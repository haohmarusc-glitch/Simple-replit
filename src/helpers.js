const fs = require('fs');
const path = require('path');
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

  // Sobe até o ancestral existente mais próximo e valida o realpath dele.
  // Crítico: se o path final ainda não existe (arquivo novo), o check antigo
  // só via existsSync(resolved) deixava passar symlink tipo
  // workspace/evil-link → /tmp e gravava fora do workspace.
  let cursor = resolved;
  const missing = [];
  while (cursor !== root && !fs.existsSync(cursor)) {
    missing.unshift(path.basename(cursor));
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  try {
    const realBase = fs.existsSync(cursor) ? fs.realpathSync(cursor) : root;
    const rootReal = fs.realpathSync(root);
    const relBase = path.relative(rootReal, realBase);
    if (relBase.startsWith('..') || path.isAbsolute(relBase)) {
      throw new Error('Caminho inválido (symlink fora do workspace)');
    }
    // Reconstrói o path final sob o ancestral real (sem seguir links futuros)
    let finalPath = realBase;
    for (const part of missing) {
      if (part === '..' || part === '.' || part.includes('\0')) {
        throw new Error('Caminho inválido');
      }
      finalPath = path.join(finalPath, part);
      // garante que cada segmento ainda está sob rootReal
      const relSeg = path.relative(rootReal, finalPath);
      if (relSeg.startsWith('..') || path.isAbsolute(relSeg)) {
        throw new Error('Caminho inválido (path traversal bloqueado)');
      }
    }
    // Se o path completo já existe, realpath final também
    if (fs.existsSync(finalPath)) {
      const realFinal = fs.realpathSync(finalPath);
      const relFinal = path.relative(rootReal, realFinal);
      if (relFinal.startsWith('..') || path.isAbsolute(relFinal)) {
        throw new Error('Caminho inválido (symlink fora do workspace)');
      }
      return realFinal;
    }
    return finalPath;
  } catch (e) {
    if (e.message && e.message.includes('inválido')) throw e;
    throw new Error('Caminho inválido');
  }
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

// SECURITY: nunca monte "git " + args.join(' ') e rode via exec/shell.
// String de comando passa por /bin/sh e $(...) ou `...` executam mesmo
// dentro de aspas. Só array pro spawn/execFile (execve) elimina RCE via
// mensagem de commit, path de diff/show, etc.
function runGit(args, callback) {
  const { spawn } = require('child_process');
  if (!Array.isArray(args)) {
    return callback({ success: false, output: '', error: 'runGit: args deve ser array' });
  }
  const child = spawn('git', args, {
    cwd: WORKSPACE,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    shell: false,
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
