const cors = require('cors');
const crypto = require('crypto');
const { AUTH_TOKEN, ALLOWED_ORIGINS } = require('./config');

const rateBuckets = new Map();

function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const ip =
      req.headers['x-forwarded-for']?.toString().split(',')[0].trim() ||
      req.socket.remoteAddress ||
      'unknown';
    const key = ip + ':' + (req.route?.path || req.path);
    const now = Date.now();
    let b = rateBuckets.get(key);
    if (!b || now > b.reset) {
      b = { count: 0, reset: now + windowMs };
      rateBuckets.set(key, b);
    }
    b.count += 1;
    if (b.count > max) {
      return res.status(429).json({ success: false, error: 'Muitas requisições. Aguarde um momento.' });
    }
    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) {
    if (now > v.reset) rateBuckets.delete(k);
  }
}, 60_000).unref?.();

function extractToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  if (req.headers['x-auth-token']) return String(req.headers['x-auth-token']).trim();
  if (req.query && req.query.token) return String(req.query.token).trim();
  return '';
}

function requireAuth(req, res, next) {
  if (!AUTH_TOKEN) return next();
  const token = extractToken(req);
  let ok = false;
  if (token && token.length === AUTH_TOKEN.length) {
    try {
      ok = crypto.timingSafeEqual(Buffer.from(token), Buffer.from(AUTH_TOKEN));
    } catch {
      ok = false;
    }
  }
  if (!ok) {
    return res.status(401).json({ success: false, error: 'Não autorizado. Informe AUTH_TOKEN.' });
  }
  next();
}

function setupSecurity(app) {
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-XSS-Protection', '0');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; font-src 'self' data: https://cdnjs.cloudflare.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'"
    );
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  app.use(
    cors({
      origin(origin, cb) {
        if (!origin) return cb(null, true);
        if (ALLOWED_ORIGINS.length === 0) {
          try {
            const u = new URL(origin);
            const ok =
              u.hostname === 'localhost' ||
              u.hostname === '127.0.0.1' ||
              u.hostname === '65.108.154.111';
            return cb(null, ok);
          } catch {
            return cb(null, false);
          }
        }
        return cb(null, ALLOWED_ORIGINS.includes(origin));
      },
      credentials: true,
    })
  );
}

module.exports = { setupSecurity, rateLimit, requireAuth, extractToken };
