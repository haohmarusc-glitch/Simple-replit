// ========== STATE ==========
let editor = null;
let currentFile = null;
let currentLanguage = 'python';
let files = [];

// ========== MONACO SETUP ==========
require.config({
  paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' }
});

require(['vs/editor/editor.main'], function () {
  editor = monaco.editor.create(document.getElementById('editor'), {
    value: '# Bem-vindo ao Simple Replit!\n# Digite seu código e clique em Rodar\n\nprint("Olá, mundo!")\n',
    language: 'python',
    theme: 'vs-dark',
    fontSize: 14,
    fontFamily: "'SF Mono', 'Fira Code', Consolas, monospace",
    minimap: { enabled: false },
    automaticLayout: true,
    tabSize: 2,
    scrollBeyondLastLine: false,
    padding: { top: 12 }
  });

  // Atalhos
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    saveCurrentFile();
  });

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
    runCode();
  });

  // Carrega arquivos ao iniciar
  loadFiles();
});

// ========== LANGUAGE MAP ==========
const langMap = {
  python: 'python',
  py: 'python',
  javascript: 'javascript',
  js: 'javascript',
  html: 'html',
  css: 'css',
  md: 'markdown',
  markdown: 'markdown',
  json: 'json',
  txt: 'plaintext'
};

function detectLanguage(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  return langMap[ext] || 'plaintext';
}

// ========== FILE TREE ==========
async function loadFiles() {
  try {
    const res = await fetch('/api/files');
    const data = await res.json();
    if (data.success) {
      files = data.files;
      renderFileTree();
    }
  } catch (err) {
    console.error('Erro ao carregar arquivos:', err);
  }
}

function renderFileTree() {
  const container = document.getElementById('fileTree');
  container.innerHTML = '';

  if (files.length === 0) {
    container.innerHTML = '<div style="padding:12px;color:#666;font-size:12px;">Nenhum arquivo ainda.<br>Clique em ＋ para criar.</div>';
    return;
  }

  function renderItems(items, parent) {
    items.forEach(item => {
      const div = document.createElement('div');
      div.className = `file-item ${item.type}`;
      if (currentFile === item.path) div.classList.add('active');

      const icon = item.type === 'folder' ? '📁' : getFileIcon(item.name);
      div.innerHTML = `<span class="icon">${icon}</span><span>${item.name}</span>`;

      div.onclick = (e) => {
        e.stopPropagation();
        if (item.type === 'file') {
          openFile(item.path);
        }
      };

      // Menu de contexto simples (botão direito)
      div.oncontextmenu = (e) => {
        e.preventDefault();
        showContextMenu(e, item);
      };

      parent.appendChild(div);

      if (item.type === 'folder' && item.children && item.children.length) {
        const children = document.createElement('div');
        children.className = 'file-children';
        parent.appendChild(children);
        renderItems(item.children, children);
      }
    });
  }

  renderItems(files, container);
}

function getFileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const icons = {
    py: '🐍',
    js: '📜',
    html: '🌐',
    css: '🎨',
    md: '📝',
    json: '📋',
    txt: '📄'
  };
  return icons[ext] || '📄';
}

// ========== OPEN / SAVE ==========
async function openFile(filePath) {
  try {
    const res = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`);
    const data = await res.json();
    if (!data.success) {
      alert('Erro: ' + data.error);
      return;
    }

    currentFile = filePath;
    const lang = detectLanguage(filePath);
    currentLanguage = lang;

    editor.setValue(data.content);
    monaco.editor.setModelLanguage(editor.getModel(), lang);

    // Atualiza select
    const select = document.getElementById('languageSelect');
    if ([...select.options].some(o => o.value === lang)) {
      select.value = lang;
    }

    renderFileTree();
  } catch (err) {
    alert('Erro ao abrir arquivo: ' + err.message);
  }
}

async function saveCurrentFile() {
  if (!currentFile) {
    // Se não tem arquivo aberto, pergunta o nome
    const name = prompt('Nome do arquivo (ex: main.py):');
    if (!name) return;
    currentFile = name;
  }

  const content = editor.getValue();

  try {
    const res = await fetch('/api/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: currentFile, content })
    });
    const data = await res.json();
    if (data.success) {
      appendConsole('info', `✔ Salvo: ${currentFile}`);
      loadFiles();
    } else {
      alert('Erro ao salvar: ' + data.error);
    }
  } catch (err) {
    alert('Erro ao salvar: ' + err.message);
  }
}

// ========== NEW FILE / FOLDER ==========
document.getElementById('btnNewFile').onclick = async () => {
  const name = prompt('Nome do novo arquivo (ex: script.py):');
  if (!name) return;

  try {
    const res = await fetch('/api/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: name, content: '' })
    });
    const data = await res.json();
    if (data.success) {
      await loadFiles();
      openFile(name);
    } else {
      alert(data.error);
    }
  } catch (err) {
    alert(err.message);
  }
};

document.getElementById('btnNewFolder').onclick = async () => {
  const name = prompt('Nome da nova pasta:');
  if (!name) return;

  try {
    const res = await fetch('/api/folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: name })
    });
    const data = await res.json();
    if (data.success) {
      loadFiles();
    } else {
      alert(data.error);
    }
  } catch (err) {
    alert(err.message);
  }
};

document.getElementById('btnRefresh').onclick = () => loadFiles();

// ========== CONTEXT MENU (simples) ==========
function showContextMenu(e, item) {
  const action = prompt(`Ação para "${item.name}":\n1 = Renomear\n2 = Deletar\n\nDigite 1 ou 2:`);
  if (action === '1') {
    const newName = prompt('Novo nome:', item.name);
    if (!newName || newName === item.name) return;
    renameItem(item.path, newName);
  } else if (action === '2') {
    if (confirm(`Deletar "${item.name}"?`)) {
      deleteItem(item.path);
    }
  }
}

async function renameItem(oldPath, newName) {
  // Mantém a pasta pai
  const parts = oldPath.split('/');
  parts[parts.length - 1] = newName;
  const newPath = parts.join('/');

  try {
    const res = await fetch('/api/rename', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPath, newPath })
    });
    const data = await res.json();
    if (data.success) {
      if (currentFile === oldPath) currentFile = newPath;
      loadFiles();
    } else {
      alert(data.error);
    }
  } catch (err) {
    alert(err.message);
  }
}

async function deleteItem(filePath) {
  try {
    const res = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (data.success) {
      if (currentFile === filePath) {
        currentFile = null;
        editor.setValue('');
      }
      loadFiles();
    } else {
      alert(data.error);
    }
  } catch (err) {
    alert(err.message);
  }
}

// ========== RUN CODE ==========
async function runCode() {
  const code = editor.getValue();
  const language = document.getElementById('languageSelect').value;

  // Só roda python e javascript
  if (!['python', 'javascript'].includes(language)) {
    appendConsole('info', 'Só é possível rodar Python ou JavaScript por enquanto.');
    return;
  }

  appendConsole('info', `▶ Executando (${language})...`);

  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        language,
        filename: currentFile || 'temp'
      })
    });
    const data = await res.json();

    if (data.output) {
      appendConsole('stdout', data.output);
    }
    if (data.error) {
      appendConsole('stderr', data.error);
    }
    if (data.success && !data.output && !data.error) {
      appendConsole('info', '(sem saída)');
    }
  } catch (err) {
    appendConsole('stderr', 'Erro de conexão: ' + err.message);
  }
}

// ========== CONSOLE ==========
function appendConsole(type, text) {
  const el = document.getElementById('consoleOutput');
  const span = document.createElement('span');
  span.className = type;
  span.textContent = text + (text.endsWith('\n') ? '' : '\n');
  el.appendChild(span);
  el.scrollTop = el.scrollHeight;
}

document.getElementById('btnClearConsole').onclick = () => {
  document.getElementById('consoleOutput').innerHTML = '';
};

// ========== BUTTONS ==========
document.getElementById('btnRun').onclick = runCode;
document.getElementById('btnSave').onclick = saveCurrentFile;

document.getElementById('languageSelect').onchange = (e) => {
  currentLanguage = e.target.value;
  if (editor) {
    monaco.editor.setModelLanguage(editor.getModel(), currentLanguage);
  }
};

// ========== GIT ==========
async function gitAction(endpoint, method = 'GET', body = null) {
  try {
    const opts = { method };
    if (body) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(endpoint, opts);
    const data = await res.json();

    if (data.output) appendConsole('stdout', data.output);
    if (data.error) appendConsole('stderr', data.error);
    if (data.success && !data.output && !data.error) {
      appendConsole('info', '✔ OK');
    }
    if (!data.success && data.error) {
      appendConsole('stderr', data.error);
    }
    return data;
  } catch (err) {
    appendConsole('stderr', 'Erro Git: ' + err.message);
  }
}

document.getElementById('btnGitStatus').onclick = () => {
  appendConsole('info', '── git status ──');
  gitAction('/api/git/status');
};

document.getElementById('btnGitPull').onclick = () => {
  if (!confirm('Fazer git pull?')) return;
  appendConsole('info', '── git pull ──');
  gitAction('/api/git/pull', 'POST');
};

document.getElementById('btnGitPush').onclick = () => {
  if (!confirm('Fazer git push?')) return;
  appendConsole('info', '── git push ──');
  gitAction('/api/git/push', 'POST');
};

document.getElementById('btnGitCommit').onclick = () => {
  const message = prompt('Mensagem do commit:');
  if (!message) return;
  appendConsole('info', '── git add + commit ──');
  gitAction('/api/git/commit', 'POST', { message });
};

// ========== SHELL ==========
const shellInput = document.getElementById('shellInput');
const shellInputArea = document.getElementById('shellInputArea');

document.querySelectorAll('.console-tabs .tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.console-tabs .tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const isShell = tab.dataset.tab === 'shell';
    shellInputArea.style.display = isShell ? 'flex' : 'none';
    if (isShell) shellInput.focus();
  };
});

async function runShellCommand(cmd) {
  if (!cmd.trim()) return;
  appendConsole('info', `$ ${cmd}`);
  try {
    const res = await fetch('/api/shell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: cmd })
    });
    const data = await res.json();
    if (data.output) appendConsole('stdout', data.output);
    if (data.error) appendConsole('stderr', data.error);
    if (data.success && !data.output && !data.error) {
      appendConsole('info', '(sem saída)');
    }
  } catch (err) {
    appendConsole('stderr', 'Erro de conexão: ' + err.message);
  }
}

shellInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const cmd = shellInput.value;
    shellInput.value = '';
    runShellCommand(cmd);
  }
});

// ========== API KEYS (.env) ==========
document.getElementById('btnApiKeys').onclick = () => {
  openFile('.env');
  appendConsole('info', 'Arquivo .env aberto. Edite as keys e salve (Ctrl+S).');
  appendConsole('info', 'Depois reinicie o container: no Shell digite → docker compose restart app');
};

// ========== LOGS AO VIVO ==========
let logEventSource = null;

function stopLogStream() {
  if (logEventSource) {
    logEventSource.close();
    logEventSource = null;
  }
  fetch('/api/logs/stop', { method: 'POST' }).catch(() => {});
  document.getElementById('btnLogs').style.display = '';
  document.getElementById('btnLogsAll').style.display = '';
  document.getElementById('btnStopLogs').style.display = 'none';
  appendConsole('info', '── Stream de logs parado ──');
}

document.getElementById('btnStopLogs').onclick = stopLogStream;

function startLogStream(mode) {
  document.querySelectorAll('.console-tabs .tab').forEach(t => t.classList.remove('active'));
  const consoleTab = document.querySelector('.console-tabs .tab[data-tab="console"]');
  if (consoleTab) consoleTab.classList.add('active');
  shellInputArea.style.display = 'none';

  if (logEventSource) stopLogStream();

  document.getElementById('btnLogs').style.display = 'none';
  document.getElementById('btnLogsAll').style.display = 'none';
  document.getElementById('btnStopLogs').style.display = '';

  appendConsole('info', `── Conectando logs ao vivo (${mode})... ──`);

  logEventSource = new EventSource(`/api/logs/stream?mode=${mode}`);

  logEventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'done') {
        stopLogStream();
        return;
      }
      appendConsole(data.type || 'stdout', data.text || '');
    } catch (e) {
      appendConsole('stdout', event.data);
    }
  };

  logEventSource.onerror = () => {
    appendConsole('stderr', 'Conexão de logs interrompida');
    stopLogStream();
  };
}

document.getElementById('btnLogs').onclick = () => startLogStream('app');
document.getElementById('btnLogsAll').onclick = () => startLogStream('all');
