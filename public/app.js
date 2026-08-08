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

// ========== SHELL + TABS ==========
const shellInput = document.getElementById('shellInput');
const shellInputArea = document.getElementById('shellInputArea');
const aiChatArea = document.getElementById('aiChatArea');
const aiModelWrap = document.getElementById('aiModelWrap');
const consoleOutputEl = document.getElementById('consoleOutput');

document.querySelectorAll('.console-tabs .tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.console-tabs .tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const name = tab.dataset.tab;
    shellInputArea.style.display = name === 'shell' ? 'flex' : 'none';
    aiChatArea.style.display = name === 'ai' ? 'flex' : 'none';
    consoleOutputEl.style.display = (name === 'console' || name === 'shell') ? 'block' : 'none';
    aiModelWrap.style.display = name === 'ai' ? 'block' : 'none';
    if (name === 'shell') shellInput.focus();
    if (name === 'ai') document.getElementById('aiInput').focus();
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
  appendConsole('info', 'Depois use 🚀 Deploy ou no Shell: docker compose restart app');
};

// ========== DEPLOY (com log ao vivo) ==========
document.getElementById('btnDeploy').onclick = () => {
  if (!confirm('Deploy agora?\n\n1. git pull\n2. docker compose up -d --build\n3. status\n\nO log aparece ao vivo no console.')) {
    return;
  }

  document.querySelectorAll('.console-tabs .tab').forEach(t => t.classList.remove('active'));
  const consoleTab = document.querySelector('.console-tabs .tab[data-tab="console"]');
  if (consoleTab) consoleTab.classList.add('active');
  if (typeof shellInputArea !== 'undefined') shellInputArea.style.display = 'none';

  const btn = document.getElementById('btnDeploy');
  btn.disabled = true;
  btn.textContent = '🚀 Deploying...';

  appendConsole('info', '── Deploy iniciado (log ao vivo) ──');

  const es = new EventSource('/api/deploy/stream');

  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'done') {
        es.close();
        btn.disabled = false;
        btn.textContent = '🚀 Deploy';
        appendConsole('info', '── Deploy finalizado ──');
        return;
      }
      appendConsole(data.type || 'stdout', data.text || '');
    } catch (e) {
      appendConsole('stdout', event.data);
    }
  };

  es.onerror = () => {
    es.close();
    btn.disabled = false;
    btn.textContent = '🚀 Deploy';
    appendConsole('stderr', 'Conexão de deploy interrompida (processo pode ter terminado)');
  };
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

// ========== MONITOR ==========
document.getElementById('btnMonitor').onclick = async () => {
  appendConsole('info', '── Monitor ──');
  try {
    const res = await fetch('/api/monitor');
    const data = await res.json();
    if (data.uptime) appendConsole('stdout', 'Uptime: ' + data.uptime);
    if (data.memory) appendConsole('stdout', data.memory);
    if (data.disk) appendConsole('stdout', 'Disk: ' + data.disk);
    if (data.docker) appendConsole('stdout', data.docker);
    if (data.pm2 && !data.pm2.includes('indisponivel')) {
      try {
        const list = JSON.parse(data.pm2);
        const summary = (Array.isArray(list) ? list : []).map(p =>
          `${p.name}: ${p.pm2_env?.status || '?'} (cpu ${p.monit?.cpu ?? '?'}% mem ${Math.round((p.monit?.memory || 0) / 1024 / 1024)}MB)`
        ).join('\n');
        if (summary) appendConsole('stdout', 'PM2:\n' + summary);
      } catch (e) {
        appendConsole('stdout', 'PM2: ' + data.pm2.slice(0, 300));
      }
    }
  } catch (err) {
    appendConsole('stderr', 'Erro monitor: ' + err.message);
  }
};

// ========== SECRETS LIST ==========
document.getElementById('btnSecrets').onclick = async () => {
  appendConsole('info', '── Secrets (.env) ──');
  try {
    const res = await fetch('/api/secrets');
    const data = await res.json();
    if (!data.success) {
      appendConsole('stderr', data.error || 'Falha');
      return;
    }
    data.keys.forEach(k => {
      const status = k.set ? `set ${k.preview}` : 'VAZIO';
      appendConsole(k.set ? 'stdout' : 'stderr', `${k.name}=${status}`);
    });
    appendConsole('info', `${data.keys.length} keys | clique 🔑 API Keys para editar`);
  } catch (err) {
    appendConsole('stderr', 'Erro secrets: ' + err.message);
  }
};

// ========== RESTART APP ==========
document.getElementById('btnRestartApp').onclick = async () => {
  if (!confirm('Reiniciar o container do app (docker compose restart app)?')) return;
  appendConsole('info', '── Restart app ──');
  try {
    const res = await fetch('/api/workflow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'restart-app' })
    });
    const data = await res.json();
    if (data.output) appendConsole('stdout', data.output);
    if (data.error) appendConsole('stderr', data.error);
    appendConsole(data.success ? 'info' : 'stderr', data.success ? '✔ App reiniciado' : 'Falha no restart');
  } catch (err) {
    appendConsole('stderr', 'Erro: ' + err.message);
  }
};

// ========== AI CHAT ==========
const aiMessages = [];
const aiMessagesEl = document.getElementById('aiMessages');
const aiInput = document.getElementById('aiInput');

function addAiMessage(role, content, files) {
  const div = document.createElement('div');
  div.className = `ai-msg ${role}`;
  div.textContent = content;
  if (files && files.length) {
    const actions = document.createElement('div');
    actions.className = 'file-actions';
    files.forEach(f => {
      const btn = document.createElement('button');
      btn.textContent = `💾 Salvar ${f.path}`;
      btn.onclick = async () => {
        try {
          const res = await fetch('/api/file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: f.path, content: f.content })
          });
          const data = await res.json();
          if (data.success) {
            btn.textContent = `✔ ${f.path}`;
            btn.style.background = '#14532d';
            loadFiles();
            if (currentFile === f.path && editor) editor.setValue(f.content);
          } else {
            alert(data.error || 'Erro ao salvar');
          }
        } catch (e) {
          alert(e.message);
        }
      };
      actions.appendChild(btn);
    });
    div.appendChild(actions);
  }
  aiMessagesEl.appendChild(div);
  aiMessagesEl.scrollTop = aiMessagesEl.scrollHeight;
}

async function sendAiMessage() {
  const text = aiInput.value.trim();
  if (!text) return;
  aiInput.value = '';
  aiMessages.push({ role: 'user', content: text });
  addAiMessage('user', text);

  const thinking = document.createElement('div');
  thinking.className = 'ai-msg assistant';
  thinking.textContent = 'Pensando...';
  thinking.id = 'aiThinking';
  aiMessagesEl.appendChild(thinking);
  aiMessagesEl.scrollTop = aiMessagesEl.scrollHeight;

  try {
    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: aiMessages.slice(-12),
        model: document.getElementById('aiModel').value,
        currentFile: currentFile,
        currentCode: editor ? editor.getValue() : ''
      })
    });
    const data = await res.json();
    document.getElementById('aiThinking')?.remove();
    if (!data.success) {
      addAiMessage('assistant', 'Erro: ' + (data.error || 'falha'));
      return;
    }
    aiMessages.push({ role: 'assistant', content: data.content });
    addAiMessage('assistant', data.content, data.files || []);
  } catch (err) {
    document.getElementById('aiThinking')?.remove();
    addAiMessage('assistant', 'Erro de conexão: ' + err.message);
  }
}

document.getElementById('btnAiSend').onclick = sendAiMessage;
aiInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendAiMessage();
  }
});

// Status das keys no load
fetch('/api/ai/status').then(r => r.json()).then(s => {
  if (!s.groq && !s.deepseek) {
    console.warn('Nenhuma API key de IA configurada (GROQ_API_KEY / DEEPSEEK_API_KEY)');
  }
}).catch(() => {});
