const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== CONFIGURAÇÃO ==========
// Na VPS você pode apontar para o código do Premercado:
// WORKSPACE_PATH=/caminho/para/Premercado node server.js
const WORKSPACE = process.env.WORKSPACE_PATH
  ? path.resolve(process.env.WORKSPACE_PATH)
  : path.join(__dirname, 'workspace');

const PUBLIC = path.join(__dirname, 'public');

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
  'yarn.lock'
]);

// Garante que a pasta workspace existe (só se for a pasta padrão)
if (!process.env.WORKSPACE_PATH && !fs.existsSync(WORKSPACE)) {
  fs.mkdirSync(WORKSPACE, { recursive: true });
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(PUBLIC));

// ========== HELPERS ==========
function getSafePath(userPath) {
  const resolved = path.resolve(WORKSPACE, userPath || '');
  if (!resolved.startsWith(WORKSPACE)) {
    throw new Error('Caminho inválido (path traversal bloqueado)');
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
    if (IGNORE.has(entry.name) || entry.name.startsWith('.')) continue;

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
app.post('/api/run', (req, res) => {
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
