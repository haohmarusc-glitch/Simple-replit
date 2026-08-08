// ========== STATE ==========
let editor = null;
let currentFile = null;
let currentLanguage = 'python';
let files = [];
let autoSaveTimer = null;
let dirty = false;
/** @type {{path:string, content:string, language:string, dirty:boolean}[]} */
let openTabs = [];

// ========== TOAST ==========
function toast(msg, type = 'info') {
  let wrap = document.getElementById('toastWrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'toastWrap';
    document.body.appendChild(wrap);
  }
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = msg;
  wrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, 2800);
}

// ========== AUTH ==========
const AUTH_KEY = 'sr_auth_token';
function getAuthToken() {
  return localStorage.getItem(AUTH_KEY) || '';
}
function setAuthToken(t) {
  if (t) localStorage.setItem(AUTH_KEY, t);
  else localStorage.removeItem(AUTH_KEY);
}
function authHeaders(extra = {}) {
  const t = getAuthToken();
  const h = { ...extra };
  if (t) h['Authorization'] = 'Bearer ' + t;
  return h;
}
async function apiFetch(url, opts = {}) {
  const headers = authHeaders(opts.headers || {});
  if (opts.body && !headers['Content-Type'] && !(opts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401) {
    showLoginGate('Sessão inválida. Digite o token novamente.');
    throw new Error('Não autorizado');
  }
  return res;
}
function withTokenQuery(url) {
  const t = getAuthToken();
  if (!t) return url;
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + 'token=' + encodeURIComponent(t);
}

function showLoginGate(msg) {
  let gate = document.getElementById('authGate');
  if (!gate) {
    gate = document.createElement('div');
    gate.id = 'authGate';
    gate.innerHTML = `
      <div class="auth-card">
        <h2>Simple Replit</h2>
        <p id="authMsg">Digite o token de acesso (AUTH_TOKEN)</p>
        <input id="authInput" type="password" placeholder="Token" autocomplete="current-password" />
        <button id="authSubmit" type="button">Entrar</button>
      </div>`;
    document.body.appendChild(gate);
    document.getElementById('authSubmit').onclick = () => {
      const v = document.getElementById('authInput').value.trim();
      if (!v) return;
      setAuthToken(v);
      gate.style.display = 'none';
      loadFiles();
      fetch('/api/ai/status', { headers: authHeaders() }).then(r => r.json()).then(s => {
        const el = document.getElementById('aiStatus');
        if (el) el.textContent = s.ok ? 'AI ok' : '';
      }).catch(() => {});
    };
    document.getElementById('authInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('authSubmit').click();
    });
  }
  if (msg) {
    const m = document.getElementById('authMsg');
    if (m) m.textContent = msg;
  }
  gate.style.display = 'flex';
}

function logout() {
  setAuthToken('');
  openTabs = [];
  currentFile = null;
  showLoginGate('Sessão encerrada. Entre de novo.');
}

// Botão Sair no sheet de config (se existir) + atalho
document.addEventListener('DOMContentLoaded', () => {
  const sheet = document.getElementById('moreMenu');
  if (sheet && !document.getElementById('btnLogout')) {
    const b = document.createElement('button');
    b.id = 'btnLogout';
    b.className = 'btn';
    b.textContent = '🚪 Sair';
    b.onclick = () => { closeSheet(); logout(); };
    const cfg = sheet.querySelector('.sheet-section:last-of-type') || sheet;
    cfg.appendChild(b);
  }
});

// Verifica se auth é necessária
fetch('/api/auth/status')
  .then((r) => r.json())
  .then((s) => {
    if (s.authRequired && !getAuthToken()) showLoginGate();
    else if (s.authRequired && getAuthToken()) {
      // valida token
      apiFetch('/api/info').catch(() => {});
    }
  })
  .catch(() => {});

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

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, () => {
    openFilePalette();
  });

  // Auto-save (2s após parar de digitar)
  editor.onDidChangeModelContent(() => {
    if (!currentFile) return;
    dirty = true;
    const tab = openTabs.find((t) => t.path === currentFile);
    if (tab) {
      tab.dirty = true;
      tab.content = editor.getValue();
    }
    renderEditorTabs();
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
      if (dirty && currentFile) saveCurrentFile();
    }, 2000);
  });

  window.addEventListener('beforeunload', (e) => {
    if (openTabs.some((t) => t.dirty) || dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // Carrega arquivos ao iniciar
  loadFiles();
});

// ========== TABS ==========
function renderEditorTabs() {
  const bar = document.getElementById('editorTabs');
  if (!bar) return;
  bar.innerHTML = '';
  if (!openTabs.length) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';
  openTabs.forEach((tab) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'editor-tab' + (tab.path === currentFile ? ' active' : '') + (tab.dirty ? ' dirty' : '');
    const name = tab.path.split('/').pop();
    el.innerHTML = `<span class="tab-name">${name}${tab.dirty ? ' •' : ''}</span><span class="tab-close" title="Fechar">×</span>`;
    el.title = tab.path;
    el.onclick = (e) => {
      if (e.target.classList.contains('tab-close')) {
        e.stopPropagation();
        closeTab(tab.path);
        return;
      }
      switchTab(tab.path);
    };
    bar.appendChild(el);
  });
}

function syncCurrentTabFromEditor() {
  if (!currentFile || !editor) return;
  const tab = openTabs.find((t) => t.path === currentFile);
  if (tab) {
    tab.content = editor.getValue();
    tab.language = currentLanguage;
    tab.dirty = dirty;
  }
}

function switchTab(path) {
  if (path === currentFile) return;
  syncCurrentTabFromEditor();
  const tab = openTabs.find((t) => t.path === path);
  if (!tab || !editor) return;
  currentFile = tab.path;
  currentLanguage = tab.language;
  dirty = tab.dirty;
  editor.setValue(tab.content);
  monaco.editor.setModelLanguage(editor.getModel(), tab.language);
  const select = document.getElementById('languageSelect');
  if (select && [...select.options].some((o) => o.value === tab.language)) {
    select.value = tab.language;
  }
  if (typeof updateBreadcrumb === 'function') updateBreadcrumb(path);
  renderEditorTabs();
  renderFileTree();
}

async function closeTab(path) {
  const tab = openTabs.find((t) => t.path === path);
  if (tab && tab.dirty) {
    try {
      if (path === currentFile) await saveCurrentFile();
      else {
        await apiFetch('/api/file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: tab.path, content: tab.content }),
        });
        tab.dirty = false;
      }
    } catch {
      /* ignore */
    }
  }
  openTabs = openTabs.filter((t) => t.path !== path);
  if (currentFile === path) {
    if (openTabs.length) {
      switchTab(openTabs[openTabs.length - 1].path);
    } else {
      currentFile = null;
      dirty = false;
      if (editor) editor.setValue('');
      if (typeof updateBreadcrumb === 'function') updateBreadcrumb('');
    }
  }
  renderEditorTabs();
  renderFileTree();
}

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
    const res = await apiFetch('/api/files');
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

      // Menu de contexto (botão direito / long-press)
      div.oncontextmenu = (e) => {
        e.preventDefault();
        showContextMenu(e, item);
      };
      let pressTimer = null;
      div.addEventListener('touchstart', (e) => {
        pressTimer = setTimeout(() => {
          const t = e.touches[0];
          showContextMenu({ clientX: t.clientX, clientY: t.clientY, preventDefault() {} }, item);
        }, 550);
      }, { passive: true });
      div.addEventListener('touchend', () => clearTimeout(pressTimer));
      div.addEventListener('touchmove', () => clearTimeout(pressTimer));

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
    const res = await apiFetch(`/api/file?path=${encodeURIComponent(filePath)}`);
    const data = await res.json();
    if (!data.success) {
      toast('Erro: ' + data.error, 'error');
      return;
    }

    syncCurrentTabFromEditor();
    const lang = detectLanguage(filePath);
    currentFile = filePath;
    currentLanguage = lang;
    dirty = false;

    const existing = openTabs.find((t) => t.path === filePath);
    if (existing) {
      existing.content = data.content;
      existing.language = lang;
      existing.dirty = false;
    } else {
      openTabs.push({ path: filePath, content: data.content, language: lang, dirty: false });
    }

    editor.setValue(data.content);
    monaco.editor.setModelLanguage(editor.getModel(), lang);

    // Atualiza select
    const select = document.getElementById('languageSelect');
    if ([...select.options].some(o => o.value === lang)) {
      select.value = lang;
    }

    if (typeof updateBreadcrumb === 'function') updateBreadcrumb(filePath);
    if (document.body.classList.contains('mode-mobile') && typeof setMobileView === 'function') {
      setMobileView('code');
    }

    renderEditorTabs();
    renderFileTree();
  } catch (err) {
    toast('Erro ao abrir: ' + err.message, 'error');
  }
}

async function saveCurrentFile() {
  if (!currentFile) {
    // Se não tem arquivo aberto, pergunta o nome
    const name = await promptName('Nome do arquivo', 'main.py');
    if (!name) return;
    currentFile = name;
  }

  const content = editor.getValue();

  try {
    const res = await apiFetch('/api/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: currentFile, content })
    });
    const data = await res.json();
    if (data.success) {
      dirty = false;
      const tab = openTabs.find((t) => t.path === currentFile);
      if (tab) {
        tab.dirty = false;
        tab.content = content;
      }
      toast('Salvo: ' + currentFile, 'ok');
      appendConsole('info', `✔ Salvo: ${currentFile}`);
      renderEditorTabs();
      loadFiles();
    } else {
      toast('Erro ao salvar: ' + data.error, 'error');
    }
  } catch (err) {
    toast('Erro ao salvar: ' + err.message, 'error');
  }
}

// ========== NEW FILE / FOLDER ==========
document.getElementById('btnNewFile').onclick = async () => {
  const name = await promptName('Novo arquivo', 'script.py');
  if (!name) return;

  try {
    const res = await apiFetch('/api/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: name, content: '' })
    });
    const data = await res.json();
    if (data.success) {
      await loadFiles();
      openFile(name);
    } else {
      toast(data.error || 'Erro', 'error');
    }
  } catch (err) {
    toast(err.message, 'error');
  }
};

document.getElementById('btnNewFolder').onclick = async () => {
  const name = await promptName('Nova pasta', 'nova-pasta');
  if (!name) return;

  try {
    const res = await apiFetch('/api/folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: name })
    });
    const data = await res.json();
    if (data.success) {
      loadFiles();
    } else {
      toast(data.error || 'Erro', 'error');
    }
  } catch (err) {
    toast(err.message, 'error');
  }
};

document.getElementById('btnRefresh').onclick = () => loadFiles();

// ========== CONTEXT MENU ==========
function hideCtxMenu() {
  const m = document.getElementById('ctxMenu');
  if (m) m.style.display = 'none';
}

function showContextMenu(e, item) {
  hideCtxMenu();
  let menu = document.getElementById('ctxMenu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'ctxMenu';
    document.body.appendChild(menu);
    document.addEventListener('click', hideCtxMenu);
  }
  menu.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'ctx-title';
  title.textContent = item.name;
  menu.appendChild(title);

  const actions = [
    item.type === 'file' ? { label: 'Abrir', fn: () => openFile(item.path) } : null,
    { label: 'Renomear', fn: () => promptName('Novo nome', item.name).then((n) => n && n !== item.name && renameItem(item.path, n)) },
    { label: 'Deletar', danger: true, fn: () => promptConfirm('Deletar "' + item.name + '"?').then((ok) => ok && deleteItem(item.path)) },
  ].filter(Boolean);

  actions.forEach((a) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctx-item' + (a.danger ? ' danger' : '');
    b.textContent = a.label;
    b.onclick = (ev) => {
      ev.stopPropagation();
      hideCtxMenu();
      a.fn();
    };
    menu.appendChild(b);
  });

  menu.style.display = 'block';
  const x = Math.min(e.clientX || 16, window.innerWidth - 200);
  const y = Math.min(e.clientY || 80, window.innerHeight - 180);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}

function promptName(title, value) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal-box"><h3>${title}</h3>
      <input id="modalInput" type="text" value="${(value || '').replace(/"/g, '&quot;')}" />
      <div class="modal-actions">
        <button type="button" class="btn" data-act="cancel">Cancelar</button>
        <button type="button" class="btn btn-primary" data-act="ok">OK</button>
      </div></div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('#modalInput');
    setTimeout(() => { input.focus(); input.select(); }, 50);
    const close = (v) => { overlay.remove(); resolve(v); };
    overlay.querySelector('[data-act=cancel]').onclick = () => close(null);
    overlay.querySelector('[data-act=ok]').onclick = () => close(input.value.trim() || null);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') close(input.value.trim() || null);
      if (e.key === 'Escape') close(null);
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
  });
}

function promptConfirm(msg) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal-box"><h3>Confirmar</h3><p>${msg}</p>
      <div class="modal-actions">
        <button type="button" class="btn" data-act="cancel">Cancelar</button>
        <button type="button" class="btn btn-danger" data-act="ok">Deletar</button>
      </div></div>`;
    document.body.appendChild(overlay);
    const close = (v) => { overlay.remove(); resolve(v); };
    overlay.querySelector('[data-act=cancel]').onclick = () => close(false);
    overlay.querySelector('[data-act=ok]').onclick = () => close(true);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
  });
}

async function renameItem(oldPath, newName) {
  // Mantém a pasta pai
  const parts = oldPath.split('/');
  parts[parts.length - 1] = newName;
  const newPath = parts.join('/');

  try {
    const res = await apiFetch('/api/rename', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPath, newPath })
    });
    const data = await res.json();
    if (data.success) {
      if (currentFile === oldPath) currentFile = newPath;
      loadFiles();
    } else {
      toast(data.error || 'Erro', 'error');
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteItem(filePath) {
  try {
    const res = await apiFetch(`/api/file?path=${encodeURIComponent(filePath)}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (data.success) {
      openTabs = openTabs.filter((t) => t.path !== filePath);
      if (currentFile === filePath) {
        if (openTabs.length) {
          switchTab(openTabs[openTabs.length - 1].path);
        } else {
          currentFile = null;
          dirty = false;
          editor.setValue('');
        }
        renderEditorTabs();
      }
      loadFiles();
    } else {
      toast(data.error || 'Erro', 'error');
    }
  } catch (err) {
    toast(err.message, 'error');
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
    const res = await apiFetch('/api/run', {
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
    const res = await apiFetch(endpoint, opts);
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

document.getElementById('btnGitCommit').onclick = async () => {
  const message = await promptName('Mensagem do commit', 'update');
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
    const res = await apiFetch('/api/shell', {
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

  const es = new EventSource(withTokenQuery('/api/deploy/stream'));

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
  apiFetch('/api/logs/stop', { method: 'POST' }).catch(() => {});
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

  logEventSource = new EventSource(withTokenQuery(`/api/logs/stream?mode=${mode}`));

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
    const res = await apiFetch('/api/monitor');
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
    const res = await apiFetch('/api/secrets');
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
    const res = await apiFetch('/api/workflow', {
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
          const res = await apiFetch('/api/file', {
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
            toast(data.error || 'Erro ao salvar', 'error');
          }
        } catch (e) {
          toast(e.message, 'error');
        }
      };
      actions.appendChild(btn);
    });
    div.appendChild(actions);
  }
  aiMessagesEl.appendChild(div);
  aiMessagesEl.scrollTop = aiMessagesEl.scrollHeight;
}

async function sendAiMessage(presetText) {
  const text = (presetText || aiInput.value).trim();
  if (!text) return;
  if (!presetText) aiInput.value = '';

  const btnSend = document.getElementById('btnAiSend');
  if (btnSend) btnSend.disabled = true;

  aiMessages.push({ role: 'user', content: text });
  addAiMessage('user', text);

  const thinking = document.createElement('div');
  thinking.className = 'ai-msg assistant';
  thinking.textContent = 'Pensando...';
  thinking.id = 'aiThinking';
  aiMessagesEl.appendChild(thinking);
  aiMessagesEl.scrollTop = aiMessagesEl.scrollHeight;

  try {
    const res = await apiFetch('/api/ai/chat', {
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
  } finally {
    if (btnSend) btnSend.disabled = false;
  }
}

document.getElementById('btnAiSend').onclick = () => sendAiMessage();
aiInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendAiMessage();
  }
});

document.querySelectorAll('.ai-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    sendAiMessage(chip.dataset.prompt);
  });
});

// Status das keys no load
fetch('/api/ai/status').then(r => r.json()).then(s => {
  if (!s.groq && !s.deepseek) {
    console.warn('Nenhuma API key de IA configurada (GROQ_API_KEY / DEEPSEEK_API_KEY)');
  }
}).catch(() => {});

// ========== MODO PC / CELULAR ==========
const modeSelect = document.getElementById('modeSelect');
const sidebar = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebarOverlay');
const moreMenu = document.getElementById('moreMenu');

function detectDefaultMode() {
  return window.matchMedia('(max-width: 768px)').matches ? 'mobile' : 'desktop';
}

function applyMode(mode) {
  let effective = mode;
  if (mode === 'auto') effective = detectDefaultMode();

  document.body.classList.remove('mode-mobile', 'mode-desktop');
  document.body.classList.add(effective === 'mobile' ? 'mode-mobile' : 'mode-desktop');

  if (sidebar) sidebar.classList.remove('open');
  if (sidebarOverlay) sidebarOverlay.style.display = 'none';
  if (moreMenu) moreMenu.style.display = 'none';

  localStorage.setItem('sr_mode', mode);

  if (effective === 'mobile') {
    setMobileView(localStorage.getItem('sr_mobile_view') || 'files');
  } else {
    document.body.classList.remove('view-files', 'view-code', 'view-console', 'view-ai', 'view-actions');
  }

  setTimeout(() => {
    if (typeof editor !== 'undefined' && editor) editor.layout();
  }, 100);
}

function setMobileView(view) {
  const views = ['files', 'code', 'console', 'ai', 'actions'];
  views.forEach(v => document.body.classList.remove('view-' + v));
  document.body.classList.add('view-' + view);
  localStorage.setItem('sr_mobile_view', view);

  document.querySelectorAll('#bottomNav .bnav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });

  // Sincroniza tabs internas console/shell/ai
  const shellInputArea = document.getElementById('shellInputArea');
  const aiChatArea = document.getElementById('aiChatArea');
  const consoleOutputEl = document.getElementById('consoleOutput');
  const aiModelWrap = document.getElementById('aiModelWrap');

  if (view === 'ai') {
    document.querySelectorAll('.console-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'ai'));
    if (consoleOutputEl) consoleOutputEl.style.display = 'none';
    if (shellInputArea) shellInputArea.style.display = 'none';
    if (aiChatArea) aiChatArea.style.display = 'flex';
    if (aiModelWrap) aiModelWrap.style.display = 'block';
  } else if (view === 'console') {
    document.querySelectorAll('.console-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'console'));
    if (consoleOutputEl) consoleOutputEl.style.display = 'block';
    if (shellInputArea) shellInputArea.style.display = 'none';
    if (aiChatArea) aiChatArea.style.display = 'none';
    if (aiModelWrap) aiModelWrap.style.display = 'none';
  } else if (view === 'actions') {
    // Mostra console com grid de ações
    if (consoleOutputEl) consoleOutputEl.style.display = 'block';
    if (shellInputArea) shellInputArea.style.display = 'none';
    if (aiChatArea) aiChatArea.style.display = 'none';
    showActionsPanel();
  }

  setTimeout(() => {
    if (typeof editor !== 'undefined' && editor) editor.layout();
  }, 80);
}

function updateBreadcrumb(path) {
  const el = document.getElementById('fileBreadcrumb');
  if (!el) return;
  if (!path) {
    el.textContent = '';
    el.title = '';
    return;
  }
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 3) {
    el.textContent = parts.join(' › ');
  } else {
    el.textContent = parts.slice(0, 1).join('') + ' › … › ' + parts.slice(-2).join(' › ');
  }
  el.title = path;
}

function openSheet() {
  const menu = document.getElementById('moreMenu');
  const backdrop = document.getElementById('sheetBackdrop');
  if (!menu) return;
  menu.style.display = 'flex';
  if (backdrop && document.body.classList.contains('mode-mobile')) {
    backdrop.style.display = 'block';
    backdrop.classList.add('show');
  }
}

function closeSheet() {
  const menu = document.getElementById('moreMenu');
  const backdrop = document.getElementById('sheetBackdrop');
  if (menu) menu.style.display = 'none';
  if (backdrop) {
    backdrop.style.display = 'none';
    backdrop.classList.remove('show');
  }
}

(function initMode() {
  const saved = localStorage.getItem('sr_mode') || 'auto';
  if (modeSelect) {
    modeSelect.value = saved;
    modeSelect.onchange = () => applyMode(modeSelect.value);
  }
  applyMode(saved);
  window.addEventListener('resize', () => {
    if (modeSelect && modeSelect.value === 'auto') applyMode('auto');
  });
})();

document.getElementById('btnMore')?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!moreMenu) return;
  if (moreMenu.style.display === 'none' || !moreMenu.style.display) openSheet();
  else closeSheet();
});

document.getElementById('sheetBackdrop')?.addEventListener('click', closeSheet);
document.getElementById('btnCloseSheet')?.addEventListener('click', closeSheet);

document.getElementById('btnDeploySheet')?.addEventListener('click', () => {
  document.getElementById('btnDeploy')?.click();
});

moreMenu?.querySelectorAll('button').forEach(btn => {
  if (btn.id === 'btnCloseSheet') return;
  btn.addEventListener('click', () => {
    setTimeout(closeSheet, 120);
  });
});

document.addEventListener('click', (e) => {
  if (!document.body.classList.contains('mode-mobile') && moreMenu && moreMenu.style.display !== 'none') {
    if (!moreMenu.contains(e.target) && e.target.id !== 'btnMore') closeSheet();
  }
});

function openSideNav() {
  document.body.classList.add('nav-open');
  document.getElementById('bottomNav')?.classList.add('open');
  const bd = document.getElementById('sideNavBackdrop');
  if (bd) bd.style.display = 'block';
}

function closeSideNav() {
  document.body.classList.remove('nav-open');
  document.getElementById('bottomNav')?.classList.remove('open');
  const bd = document.getElementById('sideNavBackdrop');
  if (bd) bd.style.display = 'none';
}

document.getElementById('btnToggleSideNav')?.addEventListener('click', (e) => {
  e.stopPropagation();
  openSideNav();
});

document.getElementById('sideNavBackdrop')?.addEventListener('click', closeSideNav);

// Side nav mobile (lateral esquerda)
document.querySelectorAll('#bottomNav .bnav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.action === 'close-nav') {
      closeSideNav();
      return;
    }
    if (btn.dataset.action === 'more') {
      closeSideNav();
      openSheet();
      return;
    }
    closeSheet();
    setMobileView(btn.dataset.view);
    closeSideNav();
  });
});

// Ao abrir arquivo no mobile → Código + breadcrumb
document.getElementById('fileTree')?.addEventListener('click', () => {
  setTimeout(() => {
    if (typeof currentFile !== 'undefined' && currentFile) {
      updateBreadcrumb(currentFile);
      if (document.body.classList.contains('mode-mobile')) setMobileView('code');
    }
  }, 80);
});

// Sync mode selects
const modeSelectMobile = document.getElementById('modeSelectMobile');
if (modeSelectMobile && modeSelect) {
  modeSelectMobile.value = modeSelect.value;
  modeSelectMobile.onchange = () => {
    modeSelect.value = modeSelectMobile.value;
    applyMode(modeSelectMobile.value);
    closeSheet();
  };
  modeSelect.addEventListener('change', () => {
    modeSelectMobile.value = modeSelect.value;
  });
}

// Patch setMobileView: remove old "actions" view dependency
const _setMobileView = setMobileView;
setMobileView = function(view) {
  if (view === 'actions') {
    openSheet();
    return;
  }
  _setMobileView(view);
};

// ========== FILE PALETTE (Ctrl+P) ==========
function flattenFiles(items, out = []) {
  for (const it of items || []) {
    if (it.type === 'file') out.push(it.path);
    else if (it.children) flattenFiles(it.children, out);
  }
  return out;
}

function openFilePalette() {
  let modal = document.getElementById('filePalette');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'filePalette';
    modal.innerHTML = `
      <div class="palette-box">
        <input id="paletteInput" type="text" placeholder="Buscar arquivo… (Esc fecha)" autocomplete="off" />
        <ul id="paletteList"></ul>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeFilePalette();
    });
    document.getElementById('paletteInput').addEventListener('input', renderPaletteList);
    document.getElementById('paletteInput').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeFilePalette();
      if (e.key === 'Enter') {
        const first = document.querySelector('#paletteList li.active, #paletteList li');
        if (first) first.click();
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = [...document.querySelectorAll('#paletteList li')];
        if (!items.length) return;
        let i = items.findIndex((x) => x.classList.contains('active'));
        items.forEach((x) => x.classList.remove('active'));
        if (e.key === 'ArrowDown') i = Math.min(items.length - 1, i + 1);
        else i = Math.max(0, i <= 0 ? items.length - 1 : i - 1);
        items[i].classList.add('active');
        items[i].scrollIntoView({ block: 'nearest' });
      }
    });
  }
  modal.style.display = 'flex';
  const input = document.getElementById('paletteInput');
  input.value = '';
  renderPaletteList();
  setTimeout(() => input.focus(), 50);
}

function closeFilePalette() {
  const modal = document.getElementById('filePalette');
  if (modal) modal.style.display = 'none';
}

function renderPaletteList() {
  const q = (document.getElementById('paletteInput')?.value || '').toLowerCase().trim();
  const all = flattenFiles(files);
  const filtered = q
    ? all.filter((p) => p.toLowerCase().includes(q)).slice(0, 40)
    : all.slice(0, 40);
  const ul = document.getElementById('paletteList');
  if (!ul) return;
  ul.innerHTML = '';
  filtered.forEach((p, idx) => {
    const li = document.createElement('li');
    if (idx === 0) li.classList.add('active');
    li.textContent = p;
    li.onclick = () => {
      closeFilePalette();
      openFile(p);
    };
    ul.appendChild(li);
  });
  if (!filtered.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nenhum arquivo';
    ul.appendChild(li);
  }
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
    e.preventDefault();
    openFilePalette();
  }
  if (e.key === 'Escape') closeFilePalette();
});
