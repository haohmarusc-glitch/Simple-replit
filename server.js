const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== CONFIGURAÇÃO ==========
// Na VPS você pode apontar para o código do Premercado:
// WORKSPACE_PATH=/caminho/para/Premercado node server.js
const WORKSPACE = process.env.WORKSPACE_PATH
  ? path.resolve(process.env.WORKSPACE_PATH)
  : path.join(__dirname, 'workspace');

const PUBLIC = path.join(__dirname, 'public');

// Segurança (env)
const AUTH_TOKEN = (process.env.AUTH_TOKEN || '').trim();
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// SHELL_MODE=open permite qualquer comando (não recomendado). Default: whitelist
const SHELL_OPEN = process.env.SHELL_MODE === 'open';

// Pastas/arquivos que devem ser ignorados (para não explodir com monorepos grandes)
const IGNORE = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  '.cache',
  'coverage',
  '__pycache__',
  '.temp',
  '.DS_Store',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  '.agents',
  '.claude',
  '.github',
  '.docker'
]);

// Arquivos ocultos permitidos (API keys, config)
const ALLOWED_DOTFILES = new Set([
  '.env',
  '.env.example',
  '.env.local',
  '.gitignore',
  '.npmrc',
  '.dockerignore'
]);

// Garante que a pasta workspace existe (só se for a pasta padrão)
if (!process.env.WORKSPACE_PATH && !fs.existsSync(WORKSPACE)) {
  fs.mkdirSync(WORKSPACE, { recursive: true });
}

// ========== SECURITY MIDDLEWARE ==========
// Helmet-like headers (sem dependência extra)
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

// CORS restrito
app.use(
  cors({
    origin(origin, cb) {
      // requests same-origin / curl / server-side sem Origin
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.length === 0) {
        // fallback: só mesmo host ou localhost
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

app.use(express.json({ limit: '2mb' }));

// Rate limit simples em memória (por IP)
const rateBuckets = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const ip = req.headers['x-forwarded-for']?.toString().split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
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

// Limpa buckets periodicamente
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
  if (!AUTH_TOKEN) return next(); // auth desligada se AUTH_TOKEN vazio
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



// Status de auth SEM exigir token (para a tela de login)
app.get('/api/auth/status', (req, res) => {
  res.json({ success: true, authRequired: !!AUTH_TOKEN });
});

// Auth em todas as outras /api/*
app.use('/api', (req, res, next) => {
  if (req.path === '/auth/status') return next();
  return requireAuth(req, res, next);
});
app.use('/api', rateLimit(120, 60_000)); // 120 req/min por IP+rota

app.use(express.static(PUBLIC));

// ========== HELPERS ==========
function getSafePath(userPath) {
  // Normaliza e bloqueia path traversal + symlink fora do workspace
  const raw = String(userPath || '').replace(/\\/g, '/');
  if (raw.includes('\0')) throw new Error('Caminho inválido');
  const resolved = path.resolve(WORKSPACE, raw);
  const root = path.resolve(WORKSPACE);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Caminho inválido (path traversal bloqueado)');
  }
  // Se existir, resolve symlink real e confere de novo
  try {
    if (fs.existsSync(resolved)) {
      const real = fs.realpathSync(resolved);
      const relReal = path.relative(root, real);
      if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
        throw new Error('Caminho inválido (symlink fora do workspace)');
      }
      return real;
    }
  } catch (e) {
    if (e.message.includes('inválido')) throw e;
  }
  return resolved;
}

function listFiles(dir, base = '', depth = 0) {
  // Limita profundidade para monorepos grandes (evita travar)
  if (depth > 6) return [];

  const items = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return [];
  }

  for (const entry of entries) {
    if (IGNORE.has(entry.name)) continue;
    // Ignora dotfiles/dirs, exceto os permitidos (.env etc)
    if (entry.name.startsWith('.') && !ALLOWED_DOTFILES.has(entry.name)) continue;

    const relative = path.join(base, entry.name);
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      items.push({
        name: entry.name,
        path: relative,
        type: 'folder',
        children: listFiles(full, relative, depth + 1)
      });
    } else {
      items.push({
        name: entry.name,
        path: relative,
        type: 'file'
      });
    }
  }

  // Ordena: pastas primeiro, depois arquivos
  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return items;
}

// ========== API DE ARQUIVOS ==========

app.get('/api/files', (req, res) => {
  try {
    if (!fs.existsSync(WORKSPACE)) {
      return res.json({ success: true, files: [], message: 'Workspace não encontrado' });
    }
    const files = listFiles(WORKSPACE);
    res.json({ success: true, files, workspace: WORKSPACE });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/file', (req, res) => {
  try {
    const filePath = getSafePath(req.query.path);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      return res.status(404).json({ success: false, error: 'Arquivo não encontrado' });
    }
    // Limite de tamanho para não travar o browser (2 MB)
    const stats = fs.statSync(filePath);
    if (stats.size > 2 * 1024 * 1024) {
      return res.status(400).json({ success: false, error: 'Arquivo muito grande (> 2MB)' });
    }
    const content = fs.readFileSync(filePath, 'utf8');
    res.json({ success: true, content });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/file', (req, res) => {
  try {
    const { path: filePath, content } = req.body;
    if (!filePath) return res.status(400).json({ success: false, error: 'Path obrigatório' });

    const fullPath = getSafePath(filePath);
    const dir = path.dirname(fullPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(fullPath, content ?? '', 'utf8');
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/folder', (req, res) => {
  try {
    const { path: folderPath } = req.body;
    if (!folderPath) return res.status(400).json({ success: false, error: 'Path obrigatório' });

    const fullPath = getSafePath(folderPath);
    fs.mkdirSync(fullPath, { recursive: true });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.put('/api/rename', (req, res) => {
  try {
    const { oldPath, newPath } = req.body;
    if (!oldPath || !newPath) {
      return res.status(400).json({ success: false, error: 'oldPath e newPath obrigatórios' });
    }

    const fullOld = getSafePath(oldPath);
    const fullNew = getSafePath(newPath);

    if (!fs.existsSync(fullOld)) {
      return res.status(404).json({ success: false, error: 'Arquivo/pasta não encontrado' });
    }

    fs.renameSync(fullOld, fullNew);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.delete('/api/file', (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ success: false, error: 'Path obrigatório' });

    const fullPath = getSafePath(filePath);

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ success: false, error: 'Não encontrado' });
    }

    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(fullPath);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ========== EXECUTAR CÓDIGO ==========
app.post('/api/run', rateLimit(20, 60_000), (req, res) => {
  const { code, language, filename } = req.body;

  if (!code || !language) {
    return res.status(400).json({ success: false, error: 'code e language são obrigatórios' });
  }

  const id = uuidv4().slice(0, 8);
  const tempDir = path.join(WORKSPACE, '.temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  let command = '';
  let tempFile = '';

  try {
    if (language === 'javascript' || language === 'js') {
      tempFile = path.join(tempDir, `${id}.js`);
      fs.writeFileSync(tempFile, code, 'utf8');
      command = `node "${tempFile}"`;
    } else if (language === 'python' || language === 'py') {
      tempFile = path.join(tempDir, `${id}.py`);
      fs.writeFileSync(tempFile, code, 'utf8');
      command = `python3 "${tempFile}"`;
    } else {
      return res.status(400).json({
        success: false,
        error: 'Linguagem não suportada para execução. Use python ou javascript.'
      });
    }

    // Timeout de 15 segundos
    exec(command, {
      timeout: 15000,
      maxBuffer: 2 * 1024 * 1024,
      cwd: WORKSPACE
    }, (error, stdout, stderr) => {
      try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (e) {}

      if (error && error.killed) {
        return res.json({
          success: false,
          output: '',
          error: 'Tempo limite excedido (15s)'
        });
      }

      res.json({
        success: !error,
        output: stdout || '',
        error: stderr || (error ? error.message : '')
      });
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ========== SHELL ==========
// Whitelist de binários permitidos (primeiro token do comando)
const SHELL_WHITELIST = new Set([
  'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'echo', 'date', 'whoami', 'id',
  'git', 'node', 'npm', 'npx', 'python', 'python3', 'pip', 'pip3',
  'docker', 'pm2', 'curl', 'wget', 'df', 'du', 'free', 'ps', 'top', 'htop',
  'find', 'grep', 'rg', 'sed', 'awk', 'sort', 'uniq', 'diff', 'tree',
  'which', 'env', 'printenv', 'uname', 'uptime', 'ss', 'ip'
]);

const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\/$/,
  /rm\s+-rf\s+\/\s/,
  /mkfs/,
  /dd\s+if=/,
  /:\(\)\s*\{/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bpasswd\b/,
  /\buserdel\b/,
  /chmod\s+777\s+\//,
  /chown\s+-R\s+.*\s+\//,
  />\s*\/etc\//,
  /curl\s+[^\n]*\|\s*(ba)?sh/,
  /wget\s+[^\n]*\|\s*(ba)?sh/,
];

app.post('/api/shell', rateLimit(30, 60_000), (req, res) => {
  const { command } = req.body;
  if (!command || !command.trim()) {
    return res.status(400).json({ success: false, error: 'Comando vazio' });
  }

  const cmd = command.trim();

  for (const re of BLOCKED_PATTERNS) {
    if (re.test(cmd)) {
      return res.json({
        success: false,
        output: '',
        error: 'Comando bloqueado por segurança'
      });
    }
  }

  if (!SHELL_OPEN) {
    // Extrai primeiro comando (ignora env VAR=x no início simples)
    const cleaned = cmd.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/, '');
    const first = cleaned.split(/[\s|;]+/)[0];
    // permite paths tipo ./script.py só se extensão conhecida? — bloqueia paths
    const base = path.basename(first);
    if (!SHELL_WHITELIST.has(base) && !SHELL_WHITELIST.has(first)) {
      return res.json({
        success: false,
        output: '',
        error: `Comando não permitido: "${base}". Whitelist: ${[...SHELL_WHITELIST].slice(0, 20).join(', ')}… (SHELL_MODE=open para liberar)`
      });
    }
    // Bloqueia shell chaining agressivo fora do modo open
    if (/[;&`|]|\$\(|<\(/.test(cmd) && !cmd.startsWith('git ')) {
      // permite pipes simples com comandos da whitelist
      const parts = cmd.split(/\|/).map((p) => p.trim());
      for (const part of parts) {
        const b = path.basename(part.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/, '').split(/\s+/)[0] || '');
        if (!SHELL_WHITELIST.has(b)) {
          return res.json({
            success: false,
            output: '',
            error: `Pipe/comando não permitido: "${b}"`
          });
        }
      }
      if (/[;&`]|\$\(/.test(cmd)) {
        return res.json({ success: false, output: '', error: 'Operadores ; & ` $() bloqueados no modo whitelist' });
      }
    }
  }

  exec(cmd, {
    cwd: WORKSPACE,
    timeout: 30000,
    maxBuffer: 3 * 1024 * 1024,
    shell: '/bin/bash',
    env: { ...process.env, PATH: process.env.PATH }
  }, (error, stdout, stderr) => {
    res.json({
      success: !error,
      output: (stdout || '').trim(),
      error: (stderr || (error ? error.message : '')).trim(),
      code: error ? error.code : 0
    });
  });
});

// ========== DEPLOY ==========
// git pull + docker compose up -d --build (stream SSE)
app.get('/api/deploy/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, text) => {
    res.write(`data: ${JSON.stringify({ type, text })}\n\n`);
  };

  send('info', '── Deploy iniciado ──');

  const steps = [
    { label: '1/3 git pull', cmd: 'git', args: ['pull', '--ff-only'] },
    { label: '2/3 docker compose up -d --build', cmd: 'docker', args: ['compose', 'up', '-d', '--build'] },
    { label: '3/3 docker compose ps', cmd: 'docker', args: ['compose', 'ps'] }
  ];

  let stepIndex = 0;

  function runStep() {
    if (stepIndex >= steps.length) {
      send('info', '── Deploy concluído ──');
      res.write('data: {"type":"done"}\n\n');
      res.end();
      return;
    }

    const step = steps[stepIndex];
    send('info', `▶ ${step.label}`);

    const child = spawn(step.cmd, step.args, {
      cwd: WORKSPACE,
      shell: false,
      env: { ...process.env }
    });

    child.stdout.on('data', (data) => send('stdout', data.toString()));
    child.stderr.on('data', (data) => send('stderr', data.toString()));

    child.on('error', (err) => {
      send('stderr', `Erro ao executar ${step.cmd}: ${err.message}`);
      stepIndex++;
      runStep();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        send('stderr', `⚠ ${step.label} saiu com código ${code}`);
      } else {
        send('info', `✔ ${step.label}`);
      }
      stepIndex++;
      runStep();
    });

    req.on('close', () => {
      try { child.kill('SIGTERM'); } catch (e) {}
    });
  }

  runStep();
});

// ========== LOGS AO VIVO (SSE) ==========
// Mantém referência do processo atual para poder parar
let currentLogProcess = null;

app.get('/api/logs/stream', (req, res) => {
  // Headers SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, text) => {
    res.write(`data: ${JSON.stringify({ type, text })}\n\n`);
  };

  const mode = req.query.mode || 'app'; // app | all | panel
  send('info', `── Logs ao vivo (${mode}) ──`);

  // Comandos priorizados para o Premercado
  let tryCommands;
  if (mode === 'panel') {
    tryCommands = [
      ['docker', ['logs', '-f', '--tail', '80', 'deploy-panel-panel-1']],
      ['docker', ['compose', '-f', '/opt/deploy-panel/docker-compose.yml', 'logs', '-f', '--tail', '50']]
    ];
  } else if (mode === 'all') {
    tryCommands = [
      ['docker', ['compose', 'logs', '-f', '--tail', '40']],
      ['docker-compose', ['logs', '-f', '--tail', '40']]
    ];
  } else {
    // workflow / app (padrão) — container do agente Premercado
    tryCommands = [
      ['docker', ['logs', '-f', '--tail', '100', 'premercado-app-1']],
      ['docker', ['compose', 'logs', '-f', '--tail', '80', 'app']],
      ['docker-compose', ['logs', '-f', '--tail', '80', 'app']],
      ['pm2', ['logs', '--lines', '50']]
    ];
  }

  function startNext(index) {
    if (index >= tryCommands.length) {
      send('info', 'Nenhum provedor de log encontrado (docker/pm2/journalctl). Use o Shell manualmente.');
      res.write('data: {"type":"done"}\n\n');
      res.end();
      return;
    }

    const [bin, args] = tryCommands[index];
    send('info', `Tentando: ${bin} ${args.join(' ')}`);

    const child = spawn(bin, args, {
      cwd: WORKSPACE,
      shell: false
    });

    currentLogProcess = child;

    let gotOutput = false;

    child.stdout.on('data', (data) => {
      gotOutput = true;
      send('stdout', data.toString());
    });

    child.stderr.on('data', (data) => {
      gotOutput = true;
      send('stderr', data.toString());
    });

    child.on('error', () => {
      // binário não existe → tenta o próximo
      startNext(index + 1);
    });

    child.on('close', (code) => {
      currentLogProcess = null;
      if (!gotOutput && code !== 0) {
        // não teve saída útil → tenta próximo
        startNext(index + 1);
      } else {
        send('info', `── Stream finalizado (código ${code}) ──`);
        res.write('data: {"type":"done"}\n\n');
        res.end();
      }
    });

    // Cliente desconectou → mata o processo
    req.on('close', () => {
      if (currentLogProcess) {
        currentLogProcess.kill('SIGTERM');
        currentLogProcess = null;
      }
    });
  }

  startNext(0);
});

// Parar o stream de logs
app.post('/api/logs/stop', (req, res) => {
  if (currentLogProcess) {
    currentLogProcess.kill('SIGTERM');
    currentLogProcess = null;
    res.json({ success: true, message: 'Stream parado' });
  } else {
    res.json({ success: true, message: 'Nenhum stream ativo' });
  }
});

// ========== GIT ==========
function runGit(args, callback) {
  const cmd = `git ${args.join(' ')}`;
  exec(cmd, {
    cwd: WORKSPACE,
    timeout: 60000,
    maxBuffer: 5 * 1024 * 1024
  }, (error, stdout, stderr) => {
    callback({
      success: !error,
      output: (stdout || '').trim(),
      error: (stderr || (error ? error.message : '')).trim()
    });
  });
}

// Status
app.get('/api/git/status', (req, res) => {
  runGit(['status', '--porcelain', '-b'], (result) => {
    if (!result.success && result.error.includes('not a git repository')) {
      return res.json({ success: false, error: 'Não é um repositório Git' });
    }
    res.json(result);
  });
});

// Pull
app.post('/api/git/pull', (req, res) => {
  runGit(['pull'], (result) => res.json(result));
});

// Push
app.post('/api/git/push', (req, res) => {
  runGit(['push'], (result) => res.json(result));
});

// Add + Commit
app.post('/api/git/commit', (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ success: false, error: 'Mensagem de commit obrigatória' });
  }

  // Primeiro faz add de tudo, depois commit
  runGit(['add', '-A'], (addResult) => {
    if (!addResult.success) {
      return res.json(addResult);
    }
    // Escapa aspas na mensagem
    const safeMsg = message.replace(/"/g, '\\"');
    runGit(['commit', '-m', `"${safeMsg}"`], (commitResult) => {
      res.json(commitResult);
    });
  });
});

// Log resumido
app.get('/api/git/log', (req, res) => {
  runGit(['log', '--oneline', '-10'], (result) => res.json(result));
});

// Info do workspace (útil para debug)
app.get('/api/info', (req, res) => {
  res.json({
    workspace: WORKSPACE,
    exists: fs.existsSync(WORKSPACE),
    port: PORT
  });
});

// ========== MONITORING ==========
app.get('/api/monitor', (req, res) => {
  const cmds = {
    uptime: 'uptime',
    memory: "free -h | head -2",
    disk: "df -h / | tail -1",
    docker: "docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}' 2>/dev/null || echo 'docker indisponivel'",
    pm2: "pm2 jlist 2>/dev/null | head -c 2000 || echo 'pm2 indisponivel'"
  };

  const results = {};
  let pending = Object.keys(cmds).length;

  Object.entries(cmds).forEach(([key, cmd]) => {
    exec(cmd, { timeout: 8000, maxBuffer: 512 * 1024, shell: '/bin/bash' }, (err, stdout, stderr) => {
      results[key] = (stdout || stderr || (err && err.message) || '').trim();
      pending--;
      if (pending === 0) {
        res.json({ success: true, ...results, workspace: WORKSPACE });
      }
    });
  });
});

// ========== SECRETS (lista keys do .env sem valores) ==========
app.get('/api/secrets', (req, res) => {
  try {
    const envPath = path.join(WORKSPACE, '.env');
    if (!fs.existsSync(envPath)) {
      return res.json({ success: false, error: '.env não encontrado', keys: [] });
    }
    const content = fs.readFileSync(envPath, 'utf8');
    const keys = [];
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const name = t.slice(0, eq).trim();
      const val = t.slice(eq + 1).trim();
      const set = val.length > 0 && val !== '""' && val !== "''";
      keys.push({ name, set, preview: set ? (val.length > 4 ? val.slice(0, 3) + '***' : '***') : '(vazio)' });
    }
    res.json({ success: true, keys, path: '.env' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ========== WORKFLOWS (ações rápidas) ==========
app.post('/api/workflow', (req, res) => {
  const { action } = req.body || {};
  const map = {
    'restart-app': 'docker compose restart app',
    'restart-all': 'docker compose restart',
    'status': 'docker compose ps',
    'db-status': "docker exec premercado-db-1 pg_isready -U premercado 2>/dev/null || docker exec premercado-db-1 pg_isready 2>/dev/null || echo 'db check failed'",
    'health': "curl -sS -o /dev/null -w '%{http_code}' -H 'Host: premercadosc.com' http://127.0.0.1/api/healthz || echo fail"
  };

  if (!action || !map[action]) {
    return res.status(400).json({ success: false, error: 'Ação inválida', allowed: Object.keys(map) });
  }

  exec(map[action], {
    cwd: WORKSPACE,
    timeout: 60000,
    maxBuffer: 2 * 1024 * 1024,
    shell: '/bin/bash'
  }, (error, stdout, stderr) => {
    res.json({
      success: !error,
      action,
      output: (stdout || '').trim(),
      error: (stderr || (error ? error.message : '')).trim()
    });
  });
});

// ========== AI CHAT (Groq + DeepSeek) ==========
function loadEnvKeys() {
  const keys = {
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
    GROQ_API_KEY: process.env.GROQ_API_KEY || ''
  };
  try {
    const envPath = path.join(WORKSPACE, '.env');
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf8').split('\n');
      for (const line of lines) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq === -1) continue;
        const k = t.slice(0, eq).trim();
        let v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        if (k === 'DEEPSEEK_API_KEY' && v) keys.DEEPSEEK_API_KEY = v;
        if (k === 'GROQ_API_KEY' && v) keys.GROQ_API_KEY = v;
      }
    }
  } catch (e) {}
  return keys;
}

const AI_MODELS = {
  'groq-fast': {
    provider: 'groq',
    model: 'llama-3.1-8b-instant',
    url: 'https://api.groq.com/openai/v1/chat/completions'
  },
  'groq-quality': {
    provider: 'groq',
    model: 'openai/gpt-oss-120b',
    url: 'https://api.groq.com/openai/v1/chat/completions'
  },
  'deepseek-flash': {
    provider: 'deepseek',
    model: 'deepseek-chat',
    url: 'https://api.deepseek.com/chat/completions'
  },
  'deepseek-pro': {
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    url: 'https://api.deepseek.com/chat/completions'
  }
};

const AI_SYSTEM = `Você é um assistente de programação no Simple Replit (IDE na VPS).
Responda em português. Seja direto e útil.

Quando for criar ou editar arquivos, use EXATAMENTE este formato (pode repetir para vários arquivos):

\`\`\`file:caminho/do/arquivo.ext
conteúdo completo do arquivo aqui
\`\`\`

Regras:
- Prefira arquivos completos prontos para salvar
- Não invente secrets; use variáveis de ambiente
- Para apps web simples, use HTML/CSS/JS ou Python
- Se o usuário pedir só explicação, não use o bloco file:`;

app.get('/api/ai/status', (req, res) => {
  const keys = loadEnvKeys();
  res.json({
    groq: !!keys.GROQ_API_KEY,
    deepseek: !!keys.DEEPSEEK_API_KEY,
    models: Object.keys(AI_MODELS)
  });
});

app.post('/api/ai/chat', async (req, res) => {
  try {
    const { messages, model: modelKey, currentFile, currentCode } = req.body || {};
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ success: false, error: 'messages obrigatório' });
    }

    const key = modelKey && AI_MODELS[modelKey] ? modelKey : 'groq-fast';
    const cfg = AI_MODELS[key];
    const keys = loadEnvKeys();
    const apiKey = cfg.provider === 'groq' ? keys.GROQ_API_KEY : keys.DEEPSEEK_API_KEY;

    if (!apiKey) {
      return res.status(400).json({
        success: false,
        error: cfg.provider === 'groq'
          ? 'GROQ_API_KEY não configurada no .env'
          : 'DEEPSEEK_API_KEY não configurada no .env'
      });
    }

    const systemContent = AI_SYSTEM +
      (currentFile ? `\n\nArquivo aberto agora: ${currentFile}` : '') +
      (currentCode ? `\n\nConteúdo atual do editor (trecho):\n\`\`\`\n${String(currentCode).slice(0, 8000)}\n\`\`\`` : '');

    const payload = {
      model: cfg.model,
      messages: [
        { role: 'system', content: systemContent },
        ...messages.map(m => ({ role: m.role, content: m.content }))
      ],
      temperature: 0.3,
      max_tokens: 4096
    };

    const r = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const errMsg = data.error?.message || data.message || JSON.stringify(data).slice(0, 300);
      return res.status(r.status).json({ success: false, error: errMsg });
    }

    const content = data.choices?.[0]?.message?.content || '';
    // Extrai blocos file:
    const files = [];
    const re = /```file:([^\n]+)\n([\s\S]*?)```/g;
    let match;
    while ((match = re.exec(content)) !== null) {
      files.push({ path: match[1].trim(), content: match[2].replace(/\n$/, '') });
    }

    res.json({
      success: true,
      content,
      files,
      model: key,
      usage: data.usage || null
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Fallback SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  Simple Replit rodando`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Workspace: ${WORKSPACE}`);
  console.log(`========================================\n`);
});
