const express = require('express');
const path = require('path');
const { PORT, PUBLIC, AUTH_TOKEN } = require('./src/config');
const { setupSecurity, rateLimit, requireAuth } = require('./src/middleware');
const registerRoutes = require('./src/routes/api');

const app = express();

setupSecurity(app);
app.use(express.json({ limit: '2mb' }));

// Auth status (público)
app.get('/api/auth/status', (req, res) => {
  res.json({ success: true, authRequired: !!AUTH_TOKEN });
});

// Auth + rate limit em /api
app.use('/api', (req, res, next) => {
  if (req.path === '/auth/status') return next();
  return requireAuth(req, res, next);
});
app.use('/api', rateLimit(120, 60_000));

app.use(express.static(PUBLIC));

registerRoutes(app);

app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC, 'index.html'));
});

// Error handler global
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, error: err.message || 'Erro interno' });
});

app.listen(PORT, () => {
  console.log(`Simple Replit em http://localhost:${PORT}`);
  console.log(`Workspace: ${require('./src/config').WORKSPACE}`);
  console.log(`Auth: ${AUTH_TOKEN ? 'obrigatória' : 'desligada'}`);
});
