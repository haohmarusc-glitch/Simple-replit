const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { WORKSPACE, IGNORE, ALLOWED_DOTFILES } = require('./config');

function getSafePath(userPath) {
  const raw = String(userPath || '').replace(/\\/g, '/');
  if (raw.includes('\0')) throw new Error('Caminho inválido');
  const resolved = path.resolve(WORKSPACE, raw);
  const root = path.resolve(WORKSPACE);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Caminho inválido (path traversal bloqueado)');
  }
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
  if (depth > 6) return [];
  const items = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (IGNORE.has(entry.name)) continue;
    if (entry.name.startsWith('.') && !ALLOWED_DOTFILES.has(entry.name)) continue;
    const relative = path.join(base, entry.name);
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      items.push({
        name: entry.name,
        path: relative,
        type: 'folder',
        children: listFiles(full, relative, depth + 1),
      });
    } else {
      items.push({ name: entry.name, path: relative, type: 'file' });
    }
  }
  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return items;
}

function loadEnvKeys() {
  const keys = {
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
    GROQ_API_KEY: process.env.GROQ_API_KEY || '',
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
  } catch {
    /* ignore */
  }
  return keys;
}

function runGit(args, callback) {
  const { spawn } = require('child_process');
  const child = spawn('git', args, {
    cwd: WORKSPACE,
    timeout: 60000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch (_) {}
  }, 60000);
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.on('error', (error) => {
    clearTimeout(timer);
    callback({
      success: false,
      output: '',
      error: error.message,
    });
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    callback({
      success: code === 0,
      output: stdout.trim(),
      error: stderr.trim(),
      code,
    });
  });
}

/** Promise wrapper */
function runGitAsync(args) {
  return new Promise((resolve) => runGit(args, resolve));
}

module.exports = { getSafePath, listFiles, runGit, runGitAsync, loadEnvKeys };
