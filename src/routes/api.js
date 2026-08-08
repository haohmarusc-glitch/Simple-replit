const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const { WORKSPACE, AUTH_TOKEN, SHELL_OPEN, BACKUP_DIR, PORT } = require('../config');
const { getSafePath, listFiles, runGit, runGitAsync, loadEnvKeys } = require('../helpers');
const { rateLimit } = require('../middleware');

module.exports = function registerRoutes(app) {
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
// ========== RUN (sandbox quando Docker disponível) ==========
app.post('/api/run', rateLimit(20, 60_000), (req, res) => {
  const { code, language } = req.body;

  if (!code || !language) {
    return res.status(400).json({ success: false, error: 'code e language são obrigatórios' });
  }
  if (String(code).length > 500_000) {
    return res.status(400).json({ success: false, error: 'Código muito grande (>500KB)' });
  }

  const id = uuidv4().slice(0, 8);
  const tempDir = path.join(WORKSPACE, '.temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  let tempFile = '';
  let relTemp = '';
  let bin = '';
  let localArgs = [];

  try {
    if (language === 'javascript' || language === 'js') {
      tempFile = path.join(tempDir, `${id}.js`);
      relTemp = path.join('.temp', `${id}.js`);
      fs.writeFileSync(tempFile, code, 'utf8');
      bin = 'node';
      localArgs = [tempFile];
    } else if (language === 'python' || language === 'py') {
      tempFile = path.join(tempDir, `${id}.py`);
      relTemp = path.join('.temp', `${id}.py`);
      fs.writeFileSync(tempFile, code, 'utf8');
      bin = 'python3';
      localArgs = [tempFile];
    } else {
      return res.status(400).json({
        success: false,
        error: 'Linguagem não suportada para execução. Use python ou javascript.',
      });
    }

    const cleanup = () => {
      try { if (tempFile && fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (_) {}
    };

    const finish = (error, stdout, stderr, meta) => {
      cleanup();
      if (error && error.killed) {
        return res.json({
          success: false,
          output: stdout || '',
          error: 'Tempo limite excedido (15s)',
          sandbox: meta && meta.sandbox,
        });
      }
      res.json({
        success: !error,
        output: stdout || '',
        error: (stderr || (error ? error.message : '') || '').toString(),
        sandbox: meta && meta.sandbox,
      });
    };

    // Preferência: Docker isolado (sem rede, memória limitada, só workspace montado)
    const dockerImage = bin === 'node' ? 'node:20-alpine' : 'python:3.12-alpine';
    const dockerArgs = [
      'run', '--rm',
      '--network', 'none',
      '--memory', '256m',
      '--cpus', '0.5',
      '--pids-limit', '64',
      '-v', `${WORKSPACE}:/work:rw`,
      '-w', '/work',
      dockerImage,
      bin === 'node' ? 'node' : 'python3',
      relTemp.replace(/\\/g, '/'),
    ];

    const childDocker = spawn('docker', dockerArgs, {
      cwd: WORKSPACE,
      shell: false,
      env: { PATH: process.env.PATH || '/usr/bin:/bin' },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      try { childDocker.kill('SIGKILL'); } catch (_) {}
    }, 15000);

    childDocker.stdout.on('data', (d) => { stdout += d.toString(); });
    childDocker.stderr.on('data', (d) => { stderr += d.toString(); });

    childDocker.on('error', () => {
      // Docker indisponível → fallback local restrito
      clearTimeout(timer);
      if (settled) return;
      runLocalRestricted();
    });

    childDocker.on('close', (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      // Se docker nem chegou a rodar a imagem (ex: daemon down), stderr típico
      const dockerMissing =
        /Cannot connect to the Docker daemon|Is the docker daemon running|executable file not found|No such file/i.test(stderr);
      if (dockerMissing && code !== 0 && !stdout) {
        runLocalRestricted();
        return;
      }
      settled = true;
      const err = code === 0 ? null : Object.assign(new Error(stderr || `exit ${code}`), {
        killed: signal === 'SIGKILL',
      });
      finish(err, stdout, stderr, { sandbox: 'docker' });
    });

    function runLocalRestricted() {
      if (settled) return;
      const child = spawn(bin, localArgs, {
        cwd: WORKSPACE,
        shell: false,
        env: {
          PATH: '/usr/local/bin:/usr/bin:/bin',
          HOME: WORKSPACE,
          LANG: 'C.UTF-8',
          NODE_OPTIONS: '--max-old-space-size=128',
        },
      });
      let out = '';
      let err = '';
      const t = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) {}
      }, 15000);
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.stderr.on('data', (d) => { err += d.toString(); });
      child.on('error', (e) => {
        clearTimeout(t);
        settled = true;
        finish(e, out, err, { sandbox: 'local-restricted' });
      });
      child.on('close', (code, signal) => {
        clearTimeout(t);
        settled = true;
        const e = code === 0 ? null : Object.assign(new Error(err || `exit ${code}`), {
          killed: signal === 'SIGKILL',
        });
        finish(e, out, err, { sandbox: 'local-restricted' });
      });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ========== SHELL ==========
// Whitelist de binários permitidos (primeiro token do comando)
const SHELL_WHITELIST = new Set([
  'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'echo', 'date', 'whoami', 'id',
  'git', 'npm', 'npx', 'pip', 'pip3',
  'docker', 'pm2', 'curl', 'wget', 'df', 'du', 'free', 'ps',
  'find', 'grep', 'rg', 'sed', 'awk', 'sort', 'uniq', 'diff', 'tree',
  'which', 'env', 'printenv', 'uname', 'uptime', 'ss', 'ip',
]);

// node/python removidos da whitelist padrão — use /api/run (sandbox).
// Ainda bloqueamos flags de eval mesmo se SHELL_MODE=open parcialmente.

const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\//,
  /rm\s+-fr\s+\//,
  /mkfs\b/,
  /dd\s+if=/,
  /:\(\)\s*\{/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bpasswd\b/,
  /\buserdel\b/,
  /chmod\s+(-R\s+)?777\s+\//,
  /chown\s+-R\s+.*\s+\//,
  />\s*\/etc\//,
  /curl\s+[^\n]*\|\s*(ba)?sh/,
  /wget\s+[^\n]*\|\s*(ba)?sh/,
  // eval / code injection flags
  /\bnode\s+(-e|--eval)\b/i,
  /\bnodejs\s+(-e|--eval)\b/i,
  /\bpython3?\s+(-c|--command)\b/i,
  /\bperl\s+-e\b/i,
  /\bruby\s+-e\b/i,
  /\bphp\s+-r\b/i,
  /\bnpm\s+exec\b/i,
  /\bnpx\s+(-[^\s]+\s+)*(-e|--eval)\b/i,
  /\blua\s+-e\b/i,
  /\bos\.system\b/i,
  /\bsubprocess\b/i,
  /\/dev\/sd[a-z]/,
  /\bmkfs\./,
  /\biptables\b/,
  /\bufw\b/,
];

function shellFirstToken(cmd) {
  const cleaned = cmd.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/, '');
  return cleaned.split(/[\s|;]+/)[0] || '';
}

app.post('/api/shell', rateLimit(30, 60_000), (req, res) => {
  const { command } = req.body;
  if (!command || !command.trim()) {
    return res.status(400).json({ success: false, error: 'Comando vazio' });
  }

  const cmd = command.trim();
  if (cmd.length > 4000) {
    return res.status(400).json({ success: false, error: 'Comando muito longo' });
  }

  // Sempre aplica bloqueios críticos (mesmo SHELL_MODE=open)
  for (const re of BLOCKED_PATTERNS) {
    if (re.test(cmd)) {
      return res.json({
        success: false,
        output: '',
        error: 'Comando bloqueado por segurança',
      });
    }
  }

  if (!SHELL_OPEN) {
    const first = shellFirstToken(cmd);
    const base = path.basename(first);
    if (!SHELL_WHITELIST.has(base) && !SHELL_WHITELIST.has(first)) {
      return res.json({
        success: false,
        output: '',
        error: `Comando não permitido: "${base}". Whitelist restrita (node/python via botão Rodar). SHELL_MODE=open para liberar.`,
      });
    }
    // chaining / substitution
    if (/[;&`]|\$\(|<\(/.test(cmd) && !cmd.startsWith('git ')) {
      return res.json({
        success: false,
        output: '',
        error: 'Operadores ; & ` $() <(  bloqueados no modo whitelist',
      });
    }
    // pipes: cada segmento deve ser whitelist
    if (cmd.includes('|')) {
      const parts = cmd.split(/\|/).map((p) => p.trim()).filter(Boolean);
      for (const part of parts) {
        const t = shellFirstToken(part);
        const b = path.basename(t);
        if (!SHELL_WHITELIST.has(b) && !SHELL_WHITELIST.has(t)) {
          return res.json({
            success: false,
            output: '',
            error: `Pipe/comando não permitido: "${b}"`,
          });
        }
      }
    }
  }

  exec(cmd, {
    cwd: WORKSPACE,
    timeout: 30000,
    maxBuffer: 3 * 1024 * 1024,
    shell: '/bin/bash',
    env: { ...process.env, PATH: process.env.PATH },
  }, (error, stdout, stderr) => {
    res.json({
      success: !error,
      output: (stdout || '').trim(),
      error: (stderr || (error ? error.message : '')).trim(),
      code: error ? error.code : 0,
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

// ========== BACKUP / RESTORE ==========
const BACKUP_EXCLUDE = [
  'node_modules', '.git', '.next', 'dist', 'build', '.cache', 'coverage',
  '__pycache__', '.temp', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'
];

function backupFileName(label) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safe = (label || 'manual').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'manual';
  return `backup-${ts}-${safe}.tar.gz`;
}

function runTar(args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      resolve({ ok: false, error: 'Timeout ao executar tar' });
    }, timeoutMs);
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: (stderr || `tar saiu com código ${code}`).trim() });
    });
  });
}

const MAX_BACKUP_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB comprimido

function makeWorkspaceBackup(label) {
  const name = backupFileName(label);
  const outPath = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const parent = path.dirname(WORKSPACE);
  const base = path.basename(WORKSPACE);
  const excludeArgs = BACKUP_EXCLUDE.flatMap((d) => ['--exclude', d]);
  const args = ['-czf', outPath, ...excludeArgs, '-C', parent, base];
  return runTar(args, 120000).then((r) => {
    if (!r.ok) {
      try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (_) {}
      return { success: false, error: r.error };
    }
    let size = 0;
    try { size = fs.statSync(outPath).size; } catch (_) {}
    if (size > MAX_BACKUP_BYTES) {
      try { fs.unlinkSync(outPath); } catch (_) {}
      return {
        success: false,
        error: `Backup muito grande (${(size / (1024 * 1024)).toFixed(0)} MB). Limite 2 GB.`,
      };
    }
    return {
      success: true,
      name,
      path: outPath,
      size,
      sizeHuman: (size / (1024 * 1024)).toFixed(2) + ' MB',
    };
  });
}

/** Valida entries de um .tar.gz antes de extrair (path traversal / symlink) */
function validateTarArchive(archivePath) {
  return new Promise((resolve) => {
    const child = spawn('tar', ['-tzf', archivePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      resolve({ ok: false, error: 'Timeout ao listar backup' });
    }, 60000);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return resolve({ ok: false, error: (stderr || 'tar -tzf falhou').trim() });
      }
      const entries = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
      const expectedRoot = path.basename(WORKSPACE);
      for (const entry of entries) {
        // absolute path
        if (entry.startsWith('/') || /^[A-Za-z]:/.test(entry)) {
          return resolve({ ok: false, error: `Entry com path absoluto bloqueada: ${entry}` });
        }
        if (entry.includes('..')) {
          return resolve({ ok: false, error: `Entry com .. bloqueada: ${entry}` });
        }
        // deve ficar sob o nome do workspace (tar criado com -C parent base)
        if (!entry.startsWith(expectedRoot + '/') && entry !== expectedRoot) {
          return resolve({
            ok: false,
            error: `Entry fora do workspace (${expectedRoot}): ${entry}`,
          });
        }
      }
      // symlinks: tar -tvz mostra type; usamos -tvzf se disponível
      resolve({ ok: true, entries: entries.length });
    });
  });
}

function validateTarSymlinks(archivePath) {
  return new Promise((resolve) => {
    const child = spawn('tar', ['-tvzf', archivePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      resolve({ ok: true }); // se timeout no verbose, não bloqueia demais
    }, 60000);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.on('error', () => { clearTimeout(timer); resolve({ ok: true }); });
    child.on('close', () => {
      clearTimeout(timer);
      const lines = stdout.split('\n');
      for (const line of lines) {
        // symlink lines start with 'l' in tar -tv
        if (/^l/.test(line.trim())) {
          // target after " -> "
          const m = line.match(/->\s*(.+)\s*$/);
          const target = (m && m[1] ? m[1].trim() : '');
          if (target.startsWith('/') || target.includes('..')) {
            return resolve({
              ok: false,
              error: `Symlink perigoso no backup: ${target}`,
            });
          }
        }
      }
      resolve({ ok: true });
    });
  });
}

app.get('/api/backups', (req, res) => {
  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      return res.json({ success: true, backups: [], dir: BACKUP_DIR });
    }
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith('.tar.gz') && f.startsWith('backup-'))
      .map((f) => {
        const full = path.join(BACKUP_DIR, f);
        const st = fs.statSync(full);
        return {
          name: f,
          size: st.size,
          sizeHuman: (st.size / (1024 * 1024)).toFixed(2) + ' MB',
          mtime: st.mtime.toISOString(),
          mtimeLocal: st.mtime.toLocaleString('pt-BR'),
        };
      })
      .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    res.json({ success: true, backups: files, dir: BACKUP_DIR });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/backup', rateLimit(5, 60_000), async (req, res) => {
  try {
    const label = (req.body && req.body.label) || 'manual';
    const result = await makeWorkspaceBackup(label);
    if (!result.success) {
      return res.status(500).json(result);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/restore', rateLimit(3, 120_000), async (req, res) => {
  try {
    const { name, makeSafetyBackup } = req.body || {};
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ success: false, error: 'name do backup obrigatório' });
    }
    if (name.includes('..') || name.includes('/') || name.includes('\\') || !name.endsWith('.tar.gz')) {
      return res.status(400).json({ success: false, error: 'Nome de backup inválido' });
    }
    const archive = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(archive)) {
      return res.status(404).json({ success: false, error: 'Backup não encontrado' });
    }

    // Valida conteúdo do tar ANTES de extrair
    const listCheck = await validateTarArchive(archive);
    if (!listCheck.ok) {
      return res.status(400).json({ success: false, error: listCheck.error || 'Backup inválido' });
    }
    const linkCheck = await validateTarSymlinks(archive);
    if (!linkCheck.ok) {
      return res.status(400).json({ success: false, error: linkCheck.error || 'Symlink bloqueado' });
    }

    let safety = null;
    if (makeSafetyBackup !== false) {
      safety = await makeWorkspaceBackup('pre-restore');
      if (!safety.success) {
        console.error('[restore] safety backup failed:', safety.error);
      }
    }

    const parent = path.dirname(WORKSPACE);
    // --no-same-owner reduz surpresas de permissão; paths já validados
    const r = await runTar(['-xzf', archive, '-C', parent, '--no-same-owner'], 180000);
    if (!r.ok) {
      return res.status(500).json({ success: false, error: r.error || 'Falha ao restaurar' });
    }
    res.json({
      success: true,
      message: `Restaurado a partir de ${name}`,
      workspace: WORKSPACE,
      safetyBackup: safety && safety.success ? safety.name : null,
      entries: listCheck.entries,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/backup', rateLimit(10, 60_000), (req, res) => {
  try {
    const name = req.query.name || (req.body && req.body.name);
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ success: false, error: 'name obrigatório' });
    }
    if (name.includes('..') || name.includes('/') || name.includes('\\') || !name.endsWith('.tar.gz')) {
      return res.status(400).json({ success: false, error: 'Nome inválido' });
    }
    const full = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(full)) {
      return res.status(404).json({ success: false, error: 'Backup não encontrado' });
    }
    fs.unlinkSync(full);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ========== LOGS AO VIVO (SSE) ==========
// Um processo por cliente (evita sobrescrever e órfãos)
const logStreams = new Map(); // id -> { child, res }

function killLogStream(id) {
  const entry = logStreams.get(id);
  if (!entry) return false;
  try {
    if (entry.child) entry.child.kill('SIGTERM');
  } catch (_) {}
  logStreams.delete(id);
  return true;
}

app.get('/api/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const streamId = uuidv4();
  const send = (type, text) => {
    try {
      res.write(`data: ${JSON.stringify({ type, text })}\n\n`);
    } catch (_) {}
  };

  const mode = req.query.mode || 'app';
  send('info', `── Logs ao vivo (${mode}) · id ${streamId.slice(0, 8)} ──`);

  let tryCommands;
  if (mode === 'panel') {
    tryCommands = [
      ['docker', ['logs', '-f', '--tail', '80', 'deploy-panel-panel-1']],
      ['docker', ['compose', '-f', '/opt/deploy-panel/docker-compose.yml', 'logs', '-f', '--tail', '50']],
    ];
  } else if (mode === 'all') {
    tryCommands = [
      ['docker', ['compose', 'logs', '-f', '--tail', '40']],
      ['docker-compose', ['logs', '-f', '--tail', '40']],
    ];
  } else {
    tryCommands = [
      ['docker', ['logs', '-f', '--tail', '100', 'premercado-app-1']],
      ['docker', ['compose', 'logs', '-f', '--tail', '80', 'app']],
      ['docker-compose', ['logs', '-f', '--tail', '80', 'app']],
      ['pm2', ['logs', '--lines', '50']],
    ];
  }

  let closed = false;

  function startNext(index) {
    if (closed) return;
    if (index >= tryCommands.length) {
      send('info', 'Nenhum provedor de log encontrado (docker/pm2). Use o Shell.');
      try {
        res.write('data: {"type":"done"}\n\n');
        res.end();
      } catch (_) {}
      logStreams.delete(streamId);
      return;
    }

    const [bin, args] = tryCommands[index];
    send('info', `Tentando: ${bin} ${args.join(' ')}`);

    const child = spawn(bin, args, {
      cwd: WORKSPACE,
      shell: false,
    });
    logStreams.set(streamId, { child, res });

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
      if (!closed) startNext(index + 1);
    });
    child.on('close', (code) => {
      const stillMine = logStreams.get(streamId) && logStreams.get(streamId).child === child;
      if (!stillMine || closed) return;
      if (!gotOutput && code !== 0) {
        startNext(index + 1);
      } else {
        send('info', `── Stream finalizado (código ${code}) ──`);
        try {
          res.write('data: {"type":"done"}\n\n');
          res.end();
        } catch (_) {}
        logStreams.delete(streamId);
      }
    });
  }

  req.on('close', () => {
    closed = true;
    killLogStream(streamId);
  });

  startNext(0);
});

app.post('/api/logs/stop', (req, res) => {
  let n = 0;
  for (const id of [...logStreams.keys()]) {
    if (killLogStream(id)) n += 1;
  }
  res.json({
    success: true,
    message: n ? `${n} stream(s) parado(s)` : 'Nenhum stream ativo',
  });
});

// ========== GIT ==========
function parsePorcelain(output) {
  const files = [];
  const lines = (output || '').split('\n').filter(Boolean);
  for (const line of lines) {
    const code = line.slice(0, 2);
    let pathPart = line.slice(3);
    let path = pathPart;
    let oldPath = null;
    if (pathPart.includes(' -> ')) {
      const parts = pathPart.split(' -> ');
      oldPath = parts[0].replace(/^"|"$/g, '');
      path = parts[1].replace(/^"|"$/g, '');
    } else {
      path = pathPart.replace(/^"|"$/g, '');
    }
    const x = code[0];
    const y = code[1];
    let status = 'modified';
    if (x === '?' || y === '?') status = 'untracked';
    else if (x === 'A' || y === 'A') status = 'added';
    else if (x === 'D' || y === 'D') status = 'deleted';
    else if (x === 'R' || y === 'R') status = 'renamed';
    else if (x === 'M' || y === 'M') status = 'modified';
    const staged = x !== ' ' && x !== '?' && x !== '!';
    const unstaged = y !== ' ' && y !== '?' && y !== '!';
    files.push({ path, oldPath, status, code: code.trim(), staged, unstaged, xy: code });
  }
  return files;
}

function validateGitPaths(paths) {
  if (!Array.isArray(paths) || !paths.length) return { ok: false, error: 'paths obrigatório' };
  const safe = [];
  for (const p of paths) {
    if (typeof p !== 'string' || !p.trim()) continue;
    if (p.includes('..') || p.startsWith('/')) {
      return { ok: false, error: 'path inválido: ' + p };
    }
    try {
      getSafePath(p);
      safe.push(p.replace(/^\/+/, ''));
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  if (!safe.length) return { ok: false, error: 'nenhum path válido' };
  return { ok: true, paths: safe };
}

// Status (texto) — compat
app.get('/api/git/status', (req, res) => {
  runGit(['status', '--porcelain', '-b'], (result) => {
    if (!result.success && (result.error || '').includes('not a git repository')) {
      return res.json({ success: false, error: 'Não é um repositório Git' });
    }
    res.json(result);
  });
});

// Resumo rico: branch + upstream + arquivos
app.get('/api/git/summary', async (req, res) => {
  try {
    const [branchR, upstreamR, statusR, logR] = await Promise.all([
      runGitAsync(['rev-parse', '--abbrev-ref', 'HEAD']),
      runGitAsync(['status', '-sb']),
      runGitAsync(['status', '--porcelain']),
      runGitAsync(['log', '-15', '--pretty=format:%h|%an|%ar|%s']),
    ]);

    if (!branchR.success && (branchR.error || '').toLowerCase().includes('not a git')) {
      return res.json({ success: false, error: 'Não é um repositório Git' });
    }

    const branch = branchR.success ? branchR.output : '?';
    let ahead = 0;
    let behind = 0;
    const sb = upstreamR.output || '';
    const mAhead = sb.match(/ahead\s+(\d+)/);
    const mBehind = sb.match(/behind\s+(\d+)/);
    if (mAhead) ahead = parseInt(mAhead[1], 10);
    if (mBehind) behind = parseInt(mBehind[1], 10);

    const files = parsePorcelain(statusR.output);
    const commits = [];
    if (logR.success && logR.output) {
      for (const line of logR.output.split('\n').filter(Boolean)) {
        const [hash, author, when, ...rest] = line.split('|');
        commits.push({ hash, author, when, message: rest.join('|') });
      }
    }

    res.json({
      success: true,
      branch,
      ahead,
      behind,
      shortStatus: sb.split('\n')[0] || branch,
      files,
      commits,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/git/branch', (req, res) => {
  runGit(['rev-parse', '--abbrev-ref', 'HEAD'], (result) => {
    if (!result.success) {
      return res.json({ success: false, error: result.error || 'sem branch', branch: null });
    }
    res.json({ success: true, branch: result.output });
  });
});

app.get('/api/git/branches', (req, res) => {
  runGit(['branch', '--format=%(refname:short)'], (result) => {
    if (!result.success) return res.json({ success: false, error: result.error, branches: [] });
    const branches = (result.output || '').split('\n').filter(Boolean);
    res.json({ success: true, branches });
  });
});

app.post('/api/git/checkout', (req, res) => {
  const branch = ((req.body && req.body.branch) || '').trim();
  if (!branch || !/^[a-zA-Z0-9._\/~-]+$/.test(branch)) {
    return res.status(400).json({ success: false, error: 'branch inválida' });
  }
  runGit(['checkout', branch], (result) => res.json(result));
});

// Pull
app.post('/api/git/pull', (req, res) => {
  runGit(['pull', '--ff-only'], (result) => res.json(result));
});

// Push
app.post('/api/git/push', (req, res) => {
  runGit(['push'], (result) => res.json(result));
});

// Stage (add paths ou -A)
app.post('/api/git/stage', (req, res) => {
  const all = req.body && req.body.all;
  if (all) {
    return runGit(['add', '-A'], (result) => res.json(result));
  }
  const v = validateGitPaths(req.body && req.body.paths);
  if (!v.ok) return res.status(400).json({ success: false, error: v.error });
  runGit(['add', '--', ...v.paths], (result) => res.json(result));
});

// Unstage
app.post('/api/git/unstage', (req, res) => {
  const v = validateGitPaths(req.body && req.body.paths);
  if (!v.ok) return res.status(400).json({ success: false, error: v.error });
  runGit(['restore', '--staged', '--', ...v.paths], (result) => {
    // fallback git reset HEAD for older git
    if (!result.success) {
      return runGit(['reset', 'HEAD', '--', ...v.paths], (r2) => res.json(r2));
    }
    res.json(result);
  });
});

// Discard working tree changes (cuidado)
app.post('/api/git/discard', (req, res) => {
  const v = validateGitPaths(req.body && req.body.paths);
  if (!v.ok) return res.status(400).json({ success: false, error: v.error });
  // untracked: rm; tracked: restore
  runGit(['status', '--porcelain', '--', ...v.paths], async (st) => {
    const files = parsePorcelain(st.output);
    const results = [];
    for (const f of files.length ? files : v.paths.map((p) => ({ path: p, status: 'modified' }))) {
      if (f.status === 'untracked') {
        try {
          const full = getSafePath(f.path);
          if (fs.existsSync(full)) {
            const stat = fs.statSync(full);
            if (stat.isDirectory()) fs.rmSync(full, { recursive: true, force: true });
            else fs.unlinkSync(full);
          }
          results.push({ path: f.path, success: true, action: 'deleted-untracked' });
        } catch (err) {
          results.push({ path: f.path, success: false, error: err.message });
        }
      } else {
        const r = await runGitAsync(['restore', '--worktree', '--', f.path]);
        results.push({ path: f.path, success: r.success, error: r.error, action: 'restored' });
      }
    }
    const ok = results.every((r) => r.success);
    res.json({ success: ok, results });
  });
});

// Commit (opcional: paths específicos; senão add -A)
app.post('/api/git/commit', async (req, res) => {
  const message = (req.body && req.body.message) || '';
  if (!message || !String(message).trim()) {
    return res.status(400).json({ success: false, error: 'Mensagem de commit obrigatória' });
  }
  const paths = req.body && req.body.paths;

  if (Array.isArray(paths) && paths.length) {
    const v = validateGitPaths(paths);
    if (!v.ok) return res.status(400).json({ success: false, error: v.error });
    const addR = await runGitAsync(['add', '--', ...v.paths]);
    if (!addR.success) return res.json(addR);
  } else if (req.body && req.body.all !== false) {
    const addR = await runGitAsync(['add', '-A']);
    if (!addR.success) return res.json(addR);
  }

  const commitR = await runGitAsync(['commit', '-m', String(message).trim()]);
  res.json(commitR);
});

// Log estruturado
app.get('/api/git/log', (req, res) => {
  const n = Math.min(50, Math.max(1, parseInt(req.query.n || '15', 10) || 15));
  runGit(['log', `-${n}`, '--pretty=format:%h|%an|%ar|%s'], (result) => {
    if (!result.success) return res.json({ success: false, error: result.error, commits: [] });
    const commits = [];
    for (const line of (result.output || '').split('\n').filter(Boolean)) {
      const [hash, author, when, ...rest] = line.split('|');
      commits.push({ hash, author, when, message: rest.join('|') });
    }
    res.json({ success: true, commits, output: result.output });
  });
});

// Lista arquivos alterados (status porcelain parseado)
app.get('/api/git/changed', (req, res) => {
  runGit(['status', '--porcelain'], (result) => {
    if (!result.success && (result.error || '').includes('not a git repository')) {
      return res.json({ success: false, error: 'Não é um repositório Git', files: [] });
    }
    res.json({ success: true, files: parsePorcelain(result.output), output: result.output });
  });
});

// Diff unificado (todo o repo ou um arquivo)
app.get('/api/git/diff', (req, res) => {
  const filePath = (req.query.path || '').trim();
  if (filePath) {
    try {
      getSafePath(filePath);
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
  }
  const staged = req.query.staged === '1' || req.query.staged === 'true';
  const args = staged
    ? (filePath ? ['diff', '--cached', '--', filePath] : ['diff', '--cached'])
    : (filePath ? ['diff', '--', filePath] : ['diff']);
  runGit(args, (result) => {
    if (filePath && result.success && !result.output) {
      runGit(['status', '--porcelain', '--', filePath], (st) => {
        const isUntracked = (st.output || '').startsWith('??');
        if (isUntracked) {
          try {
            const full = getSafePath(filePath);
            if (fs.existsSync(full) && fs.statSync(full).isFile()) {
              const content = fs.readFileSync(full, 'utf8');
              if (content.length > 500000) {
                return res.json({ success: true, output: '(arquivo novo muito grande para diff)', untracked: true });
              }
              const lined = content.split('\n').map((l) => '+' + l).join('\n');
              return res.json({
                success: true,
                output: `--- /dev/null\n+++ b/${filePath}\n${lined}`,
                untracked: true,
              });
            }
          } catch (_) {}
        }
        res.json(result);
      });
      return;
    }
    res.json(result);
  });
});

// Conteúdo do arquivo em um ref (default HEAD) — para Monaco DiffEditor
app.get('/api/git/show', (req, res) => {
  const filePath = (req.query.path || '').trim();
  const ref = ((req.query.ref || 'HEAD') + '').replace(/[^a-zA-Z0-9._\/~^-]/g, '');
  if (!filePath) {
    return res.status(400).json({ success: false, error: 'path obrigatório' });
  }
  try {
    getSafePath(filePath);
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
  const safeRel = filePath.replace(/^\/+/, '');
  runGit(['show', `${ref}:${safeRel}`], (result) => {
    if (!result.success) {
      return res.json({ success: true, content: '', missing: true, error: result.error });
    }
    const content = result.output || '';
    if (content.length > 2 * 1024 * 1024) {
      return res.status(400).json({ success: false, error: 'Arquivo muito grande no ref (>2MB)' });
    }
    res.json({ success: true, content, missing: false });
  });
});

// Info do workspace (útil para debug)
app.get('/api/info', (req, res) => {
  res.json({
    workspace: WORKSPACE,
    exists: fs.existsSync(WORKSPACE),
    port: PORT,
    backupDir: BACKUP_DIR,
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
};
