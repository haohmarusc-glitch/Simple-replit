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

// Tokenizador simples (aspas simples/duplas balanceadas; sem suporte a \,
// glob ou expansão de variável) -- suficiente pro subconjunto de comandos da
// whitelist do /api/shell. De propósito NÃO é um parser de shell completo:
// não faz sentido reimplementar um shell inteiro só pra nunca invocar um.
function tokenizeShellWord(str) {
  const tokens = [];
  let i = 0;
  const n = str.length;
  while (i < n) {
    while (i < n && /\s/.test(str[i])) i++;
    if (i >= n) break;
    let token = '';
    while (i < n && !/\s/.test(str[i])) {
      const c = str[i];
      if (c === '"' || c === "'") {
        const quote = c;
        i++;
        while (i < n && str[i] !== quote) {
          token += str[i];
          i++;
        }
        i++; // pula a aspa de fechamento (se faltar, só encerra o token aqui)
      } else {
        token += c;
        i++;
      }
    }
    tokens.push(token);
  }
  return tokens;
}

// SECURITY: mesma lógica do runGit acima, generalizada pra qualquer comando
// da whitelist do /api/shell -- cada estágio de uma pipeline vira um
// spawn(shell:false) próprio, com o stdout do estágio N ligado ao stdin do
// N+1 via streams do Node. Como nenhum interpretador de shell roda em
// momento algum, metacaracteres (; & ` $() > etc.) nunca são reinterpretados
// -- eles só chegam como texto literal dentro de um argv. Isso troca a
// defesa de "lista de padrões bloqueados" (que só cobre o que alguém pensou
// em bloquear) por uma garantia estrutural (não existe shell pra explorar).
//
// Efeito colateral aceito: redirecionamento (`cmd > arquivo`) para de
// funcionar como redirecionamento de verdade no modo whitelist -- vira só
// mais um argumento literal pro comando (ex.: `echo hi > out.txt` imprime
// "hi > out.txt" em vez de escrever o arquivo). SHELL_MODE=open continua
// usando um shell de verdade via exec() para quem precisa desse recurso e
// aceita o tradeoff de segurança.
function runShellPipeline(segments, { cwd, timeoutMs = 30000, maxBytes = 3 * 1024 * 1024 } = {}) {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    const stages = segments.map((seg) => {
      const tokens = tokenizeShellWord(seg);
      return { cmd: tokens[0], args: tokens.slice(1) };
    });
    if (stages.some((s) => !s.cmd)) {
      return resolve({ success: false, output: '', error: 'Comando vazio em um dos estágios do pipe', code: null });
    }

    const children = [];
    let killedByTimeout = false;
    let spawnError = null;
    const timer = setTimeout(() => {
      killedByTimeout = true;
      for (const c of children) {
        try { c.kill('SIGKILL'); } catch (_) {}
      }
    }, timeoutMs);

    let stderrAll = '';
    let stdoutFinal = '';

    for (let idx = 0; idx < stages.length; idx++) {
      const { cmd, args } = stages[idx];
      let child;
      try {
        child = spawn(cmd, args, { cwd, shell: false, env: { ...process.env } });
      } catch (err) {
        spawnError = err;
        break;
      }
      children.push(child);
      child.on('error', (err) => {
        spawnError = spawnError || err;
      });
      child.stderr.on('data', (d) => {
        stderrAll += d.toString();
        if (stderrAll.length > maxBytes) stderrAll = stderrAll.slice(0, maxBytes);
      });
      if (idx === stages.length - 1) {
        child.stdout.on('data', (d) => {
          if (stdoutFinal.length <= maxBytes) stdoutFinal += d.toString();
        });
      }
      if (idx > 0) {
        children[idx - 1].stdout.pipe(child.stdin);
      }
    }

    if (children.length === 0) {
      clearTimeout(timer);
      return resolve({ success: false, output: '', error: (spawnError && spawnError.message) || 'Falha ao iniciar comando', code: null });
    }

    const last = children[children.length - 1];
    last.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        success: code === 0 && !killedByTimeout && !spawnError,
        output: stdoutFinal.slice(0, maxBytes).trim(),
        error: killedByTimeout
          ? 'Tempo limite excedido'
          : (spawnError ? spawnError.message : stderrAll.trim()),
        code,
      });
    });
    last.on('error', (err) => {
      clearTimeout(timer);
      resolve({ success: false, output: '', error: err.message, code: null });
    });
  });
}

module.exports = { getSafePath, listFiles, runGit, runGitAsync, loadEnvKeys, runShellPipeline };
