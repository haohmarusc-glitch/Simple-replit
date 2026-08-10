// ========== STATE ==========
let editor = null;
let currentFile = null;
let currentLanguage = 'python';
let files = [];
let autoSaveTimer = null;
let dirty = false;
/** @type {{path:string, content:string, language:string, dirty:boolean}[]} */
let openTabs = [];

// ========== ESCAPE HTML ==========
// Nomes de arquivo/caminho vêm do filesystem ou do git — nunca são
// confiáveis para innerHTML (ex: "<img src=x onerror=...>" via /api/folder).
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ========== TIMESTAMPS (logs do console/agente precisam de data e hora) ==========
function pad2(n) { return String(n).padStart(2, '0'); }

/** HH:MM:SS local — usado em logs tipo terminal (console, shell). */
function clockStamp(d = new Date()) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** HH:MM se for hoje, senão DD/MM HH:MM — usado em bolhas de chat. */
function chatStamp(d = new Date()) {
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return sameDay ? time : `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${time}`;
}

/** DD/MM/AAAA HH:MM:SS — para title="" (tooltip com data completa). */
function fullStamp(d = new Date()) {
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${clockStamp(d)}`;
}

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
  try { window.dispatchEvent(new Event('sr-auth')); } catch (_) {}
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
      startClean();
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
  startClean();
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
const WELCOME_CODE =
  '# Bem-vindo ao Simple Replit!\n# Digite seu código e clique em Rodar\n\nprint("Olá, mundo!")\n';

/** Sempre inicia limpo: sem abas, editor de boas-vindas */
function startClean() {
  openTabs = [];
  currentFile = null;
  dirty = false;
  clearTimeout(autoSaveTimer);
  autoSaveTimer = null;
  if (editor) {
    editor.setValue(WELCOME_CODE);
    monaco.editor.setModelLanguage(editor.getModel(), 'python');
  }
  currentLanguage = 'python';
  const langSel = document.getElementById('languageSelect');
  if (langSel) langSel.value = 'python';
  if (typeof renderEditorTabs === 'function') renderEditorTabs();
  if (typeof updateBreadcrumb === 'function') updateBreadcrumb('');
  if (typeof renderFileTree === 'function' && files && files.length) renderFileTree();
}

require.config({
  paths: { vs: 'vendor/monaco/vs' }
});

require(['vs/editor/editor.main'], function () {
  editor = monaco.editor.create(document.getElementById('editor'), {
    value: WELCOME_CODE,
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

  // Não avisa ao sair: início sempre limpo, sem estado a preservar entre sessões
  // (aba/arquivo não são restaurados de propósito)

  // Garante estado limpo + carrega árvore
  startClean();
  loadFiles();
});

// Se o browser restaurar a página do cache (bfcache), força início limpo de novo
window.addEventListener('pageshow', (e) => {
  if (e.persisted && editor) startClean();
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
    el.innerHTML = `<span class="tab-name">${escapeHtml(name)}${tab.dirty ? ' •' : ''}</span><span class="tab-close" title="Fechar">×</span>`;
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
  if (typeof refreshGitBadge === 'function') refreshGitBadge();
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
      div.innerHTML = `<span class="icon">${icon}</span><span>${escapeHtml(item.name)}</span>`;

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
    item.type === 'file' ? { label: 'Git Diff', fn: () => openGitDiff(item.path) } : null,
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
    overlay.innerHTML = `<div class="modal-box"><h3>${escapeHtml(title)}</h3>
      <input id="modalInput" type="text" value="${escapeHtml(value || '')}" />
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
    overlay.innerHTML = `<div class="modal-box"><h3>Confirmar</h3><p>${escapeHtml(msg)}</p>
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
  consoleActiveSource = 'run';
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
// Rastreia qual função disparou a última leva de appendConsole (Rodar, Git, Deploy...)
// pra permitir filtrar/copiar o log por origem sem precisar marcar toda chamada manualmente.
let consoleActiveSource = 'run';

function appendConsole(type, text, source) {
  const el = document.getElementById('consoleOutput');
  const span = document.createElement('span');
  const src = source || consoleActiveSource;
  span.className = type;
  span.dataset.source = src;
  const stamp = `[${clockStamp()}] `;
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  // Timestamp só na 1ª linha do bloco (evita repetir em saída multi-linha de comando/deploy).
  span.textContent = stamp + body.split('\n').join('\n' + ' '.repeat(stamp.length)) + '\n';
  span.title = fullStamp();
  const filterVal = document.getElementById('consoleSourceFilter')?.value || 'all';
  if (filterVal !== 'all' && src !== filterVal) span.style.display = 'none';
  el.appendChild(span);
  el.scrollTop = el.scrollHeight;
}

function applyConsoleFilter() {
  const val = document.getElementById('consoleSourceFilter')?.value || 'all';
  document.querySelectorAll('#consoleOutput > span').forEach((span) => {
    span.style.display = (val === 'all' || span.dataset.source === val) ? '' : 'none';
  });
}
document.getElementById('consoleSourceFilter')?.addEventListener('change', applyConsoleFilter);

document.getElementById('btnCopyConsole')?.addEventListener('click', async () => {
  const spans = Array.from(document.querySelectorAll('#consoleOutput > span')).filter((s) => s.style.display !== 'none');
  const text = spans.map((s) => s.textContent).join('');
  if (!text) { toast('Nada para copiar', 'info'); return; }
  try {
    await navigator.clipboard.writeText(text);
    toast('Log copiado', 'success');
  } catch (err) {
    toast('Falha ao copiar: ' + err.message, 'error');
  }
});

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
  consoleActiveSource = 'git';
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
  if (!confirm('Fazer git pull (--ff-only)?')) return;
  appendConsole('info', '── git pull ──');
  gitAction('/api/git/pull', 'POST').then(() => refreshGitBadge());
};

document.getElementById('btnGitPush').onclick = () => {
  if (!confirm('Fazer git push?')) return;
  appendConsole('info', '── git push ──');
  gitAction('/api/git/push', 'POST').then(() => refreshGitBadge());
};

document.getElementById('btnGitCommit').onclick = async () => {
  const message = await promptName('Mensagem do commit', 'update');
  if (!message) return;
  appendConsole('info', '── git add + commit ──');
  await gitAction('/api/git/commit', 'POST', { message });
  refreshGitBadge();
};

// ========== GIT BADGE + PAINEL ==========
let gitSummaryCache = null;

async function refreshGitBadge() {
  const badge = document.getElementById('gitBranchBadge');
  const nameEl = document.getElementById('gitBranchName');
  const metaEl = document.getElementById('gitBranchMeta');
  if (!badge) return;
  try {
    const res = await apiFetch('/api/git/summary');
    const data = await res.json();
    if (!data.success) {
      badge.style.display = 'none';
      return;
    }
    gitSummaryCache = data;
    badge.style.display = 'inline-flex';
    nameEl.textContent = data.branch || '?';
    const parts = [];
    if (data.files && data.files.length) parts.push(data.files.length + 'Δ');
    if (data.ahead) parts.push('↑' + data.ahead);
    if (data.behind) parts.push('↓' + data.behind);
    metaEl.textContent = parts.join(' ');
    badge.classList.toggle('has-changes', !!(data.files && data.files.length));
  } catch (_) {
    badge.style.display = 'none';
  }
}

function closeGitPanel() {
  const el = document.getElementById('gitOverlay');
  if (el) el.remove();
}

async function openGitPanel(tab) {
  closeGitPanel();
  if (typeof closeSheet === 'function') closeSheet();

  let data = gitSummaryCache;
  try {
    const res = await apiFetch('/api/git/summary');
    data = await res.json();
    if (data.success) gitSummaryCache = data;
  } catch (err) {
    toast('Erro Git: ' + err.message, 'error');
    return;
  }
  if (!data || !data.success) {
    toast((data && data.error) || 'Não é um repositório Git', 'error');
    return;
  }

  const activeTab = tab || 'changes';
  const overlay = document.createElement('div');
  overlay.id = 'gitOverlay';
  overlay.className = 'git-overlay';
  overlay.innerHTML = `
    <div class="git-panel">
      <div class="git-panel-header">
        <h3>⎇ ${data.branch || 'Git'}${data.files && data.files.length ? ' · ' + data.files.length + ' alteração(ões)' : ''}</h3>
        <button type="button" class="btn" id="gitPanelClose">Fechar</button>
      </div>
      <div class="git-panel-tabs">
        <button type="button" data-gtab="changes" class="${activeTab === 'changes' ? 'active' : ''}">Alterações</button>
        <button type="button" data-gtab="history" class="${activeTab === 'history' ? 'active' : ''}">Histórico</button>
      </div>
      <div class="git-panel-body" id="gitPanelBody"></div>
    </div>`;
  document.body.appendChild(overlay);

  document.getElementById('gitPanelClose').onclick = closeGitPanel;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeGitPanel(); });

  const body = document.getElementById('gitPanelBody');

  function renderChanges() {
    const files = data.files || [];
    if (!files.length) {
      body.innerHTML = '<div class="git-empty">Working tree limpa.</div>';
      return;
    }
    body.innerHTML = '';
    files.forEach((f) => {
      const row = document.createElement('div');
      row.className = 'git-file-row';
      row.innerHTML = `
        <span class="diff-badge ${escapeHtml(f.status)}">${escapeHtml((f.status || '?')[0])}</span>
        <span class="git-file-path" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</span>
        <div class="git-file-actions">
          <button type="button" class="btn" data-act="diff">Diff</button>
          <button type="button" class="btn" data-act="open">Abrir</button>
          <button type="button" class="btn" data-act="stage">Stage</button>
          <button type="button" class="btn btn-danger" data-act="discard">Descartar</button>
        </div>`;
      row.querySelector('[data-act="diff"]').onclick = () => {
        closeGitPanel();
        openGitDiff(f.path);
      };
      row.querySelector('[data-act="open"]').onclick = () => {
        closeGitPanel();
        openFile(f.path);
      };
      row.querySelector('[data-act="stage"]').onclick = async () => {
        const res = await apiFetch('/api/git/stage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paths: [f.path] }),
        });
        const r = await res.json();
        if (r.success) toast('Staged: ' + f.path, 'success');
        else toast(r.error || 'Falha no stage', 'error');
        await openGitPanel('changes');
        refreshGitBadge();
      };
      row.querySelector('[data-act="discard"]').onclick = async () => {
        if (!confirm('Descartar alterações em:\n' + f.path + '\n\nIsso não pode ser desfeito.')) return;
        const res = await apiFetch('/api/git/discard', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paths: [f.path] }),
        });
        const r = await res.json();
        if (r.success) toast('Descartado: ' + f.path, 'success');
        else toast(r.error || 'Falha ao descartar', 'error');
        await openGitPanel('changes');
        refreshGitBadge();
        loadFiles();
      };
      row.querySelector('.git-file-path').onclick = () => {
        closeGitPanel();
        openFile(f.path);
      };
      body.appendChild(row);
    });

    const box = document.createElement('div');
    box.className = 'git-commit-box';
    box.innerHTML = `
      <textarea id="gitCommitMsg" placeholder="Mensagem do commit..."></textarea>
      <div class="git-commit-actions">
        <button type="button" class="btn btn-primary" id="gitDoCommit">Commit (tudo)</button>
        <button type="button" class="btn" id="gitDoStageAll">Stage all</button>
        <button type="button" class="btn" id="gitDoPull">Pull</button>
        <button type="button" class="btn" id="gitDoPush">Push</button>
        <button type="button" class="btn" id="gitDoDiff">Diff visual</button>
      </div>`;
    body.appendChild(box);

    document.getElementById('gitDoCommit').onclick = async () => {
      consoleActiveSource = 'git';
      const msg = document.getElementById('gitCommitMsg').value.trim();
      if (!msg) { toast('Digite a mensagem do commit', 'error'); return; }
      const res = await apiFetch('/api/git/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, all: true }),
      });
      const r = await res.json();
      if (r.success) {
        toast('Commit OK', 'success');
        appendConsole('info', r.output || 'commit ok');
        await openGitPanel('changes');
        refreshGitBadge();
      } else {
        toast(r.error || 'Commit falhou', 'error');
        appendConsole('stderr', r.error || r.output || '');
      }
    };
    document.getElementById('gitDoStageAll').onclick = async () => {
      await apiFetch('/api/git/stage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
      toast('Stage all', 'success');
      await openGitPanel('changes');
      refreshGitBadge();
    };
    document.getElementById('gitDoPull').onclick = async () => {
      if (!confirm('git pull --ff-only?')) return;
      const r = await gitAction('/api/git/pull', 'POST');
      if (r && r.success) toast('Pull OK', 'success');
      await openGitPanel('changes');
      refreshGitBadge();
    };
    document.getElementById('gitDoPush').onclick = async () => {
      if (!confirm('git push?')) return;
      const r = await gitAction('/api/git/push', 'POST');
      if (r && r.success) toast('Push OK', 'success');
      await openGitPanel('changes');
      refreshGitBadge();
    };
    document.getElementById('gitDoDiff').onclick = () => {
      closeGitPanel();
      openGitDiff(null);
    };
  }

  function renderHistory() {
    const commits = data.commits || [];
    if (!commits.length) {
      body.innerHTML = '<div class="git-empty">Nenhum commit.</div>';
      return;
    }
    body.innerHTML = '';
    commits.forEach((c) => {
      const row = document.createElement('div');
      row.className = 'git-history-row';
      row.innerHTML = `
        <div><span class="gh-hash">${escapeHtml(c.hash)}</span><span class="gh-msg">${escapeHtml(c.message || '')}</span></div>
        <div class="gh-meta">${escapeHtml(c.author || '')} · ${escapeHtml(c.when || '')}</div>`;
      body.appendChild(row);
    });
  }

  function showTab(name) {
    overlay.querySelectorAll('.git-panel-tabs button').forEach((b) => {
      b.classList.toggle('active', b.dataset.gtab === name);
    });
    if (name === 'history') renderHistory();
    else renderChanges();
  }

  overlay.querySelectorAll('.git-panel-tabs button').forEach((b) => {
    b.onclick = () => showTab(b.dataset.gtab);
  });
  showTab(activeTab);
}

document.getElementById('btnGitPanel')?.addEventListener('click', () => openGitPanel('changes'));
document.getElementById('gitBranchBadge')?.addEventListener('click', () => openGitPanel('changes'));

// ========== GIT DIFF (Monaco DiffEditor) ==========
let diffEditor = null;
let diffOriginalModel = null;
let diffModifiedModel = null;

function closeDiffOverlay() {
  const el = document.getElementById('diffOverlay');
  if (el) el.remove();
  if (diffEditor) {
    try { diffEditor.dispose(); } catch (_) {}
    diffEditor = null;
  }
  if (diffOriginalModel) {
    try { diffOriginalModel.dispose(); } catch (_) {}
    diffOriginalModel = null;
  }
  if (diffModifiedModel) {
    try { diffModifiedModel.dispose(); } catch (_) {}
    diffModifiedModel = null;
  }
}

function langFromPath(p) {
  const ext = (p || '').split('.').pop().toLowerCase();
  const map = {
    py: 'python', js: 'javascript', ts: 'typescript', jsx: 'javascript',
    tsx: 'typescript', html: 'html', css: 'css', json: 'json', md: 'markdown',
    yml: 'yaml', yaml: 'yaml', sh: 'shell', bash: 'shell', env: 'ini',
  };
  return map[ext] || 'plaintext';
}

async function loadDiffForFile(filePath, status) {
  const host = document.getElementById('diffEditorHost');
  const title = document.getElementById('diffTitle');
  if (!host || typeof monaco === 'undefined') return;

  if (title) title.textContent = filePath + (status ? ` · ${status}` : '');

  document.querySelectorAll('.diff-file-row').forEach((r) => {
    r.classList.toggle('active', r.dataset.path === filePath);
  });

  let original = '';
  let modified = '';

  // HEAD version
  try {
    const res = await apiFetch('/api/git/show?path=' + encodeURIComponent(filePath));
    const data = await res.json();
    original = data.success ? (data.content || '') : '';
  } catch (_) {
    original = '';
  }

  // Working tree version
  if (status === 'deleted') {
    modified = '';
  } else {
    try {
      const res = await apiFetch('/api/file?path=' + encodeURIComponent(filePath));
      const data = await res.json();
      modified = data.success ? (data.content || '') : '';
    } catch (_) {
      modified = '';
    }
  }

  // Prefer content from open editor tab if same file
  if (currentFile === filePath && editor) {
    modified = editor.getValue();
  }

  const lang = langFromPath(filePath);

  if (!diffEditor) {
    diffEditor = monaco.editor.createDiffEditor(host, {
      theme: 'vs-dark',
      readOnly: true,
      automaticLayout: true,
      renderSideBySide: !document.body.classList.contains('mode-mobile'),
      minimap: { enabled: false },
      fontSize: 13,
      scrollBeyondLastLine: false,
    });
  }

  if (diffOriginalModel) try { diffOriginalModel.dispose(); } catch (_) {}
  if (diffModifiedModel) try { diffModifiedModel.dispose(); } catch (_) {}

  diffOriginalModel = monaco.editor.createModel(original, lang);
  diffModifiedModel = monaco.editor.createModel(modified, lang);
  diffEditor.setModel({ original: diffOriginalModel, modified: diffModifiedModel });
}

async function openGitDiff(preferPath) {
  closeDiffOverlay();

  let files = [];
  try {
    const res = await apiFetch('/api/git/changed');
    const data = await res.json();
    if (!data.success) {
      toast(data.error || 'Erro ao listar alterações', 'error');
      appendConsole('stderr', data.error || 'git changed falhou');
      return;
    }
    files = data.files || [];
  } catch (err) {
    toast('Erro: ' + err.message, 'error');
    return;
  }

  if (!files.length && preferPath) {
    files = [{ path: preferPath, status: 'modified' }];
  }

  const overlay = document.createElement('div');
  overlay.id = 'diffOverlay';
  overlay.className = 'diff-overlay';
  overlay.innerHTML = `
    <div class="diff-panel">
      <div class="diff-header">
        <h3 id="diffTitle">Git Diff</h3>
        <div class="diff-actions">
          <button type="button" class="btn" id="diffOpenFile">Abrir arquivo</button>
          <button type="button" class="btn" id="diffClose">Fechar</button>
        </div>
      </div>
      <div class="diff-body">
        <div class="diff-file-list" id="diffFileList"></div>
        <div class="diff-editor-host" id="diffEditorHost"></div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  document.getElementById('diffClose').onclick = closeDiffOverlay;
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDiffOverlay();
  });

  const list = document.getElementById('diffFileList');
  let selectedPath = preferPath || (files[0] && files[0].path) || null;
  let selectedStatus = 'modified';

  if (!files.length) {
    list.innerHTML = '<div class="diff-empty">Nenhuma alteração no working tree.</div>';
  } else {
    files.forEach((f) => {
      const row = document.createElement('div');
      row.className = 'diff-file-row' + (f.path === selectedPath ? ' active' : '');
      row.dataset.path = f.path;
      row.dataset.status = f.status;
      row.innerHTML = `<span class="diff-badge ${escapeHtml(f.status)}">${escapeHtml(f.status.slice(0, 1))}</span><span class="diff-file-path" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</span>`;
      row.onclick = () => {
        selectedPath = f.path;
        selectedStatus = f.status;
        loadDiffForFile(f.path, f.status);
      };
      list.appendChild(row);
      if (f.path === selectedPath) selectedStatus = f.status;
    });
  }

  document.getElementById('diffOpenFile').onclick = () => {
    if (selectedPath) {
      closeDiffOverlay();
      openFile(selectedPath);
    }
  };

  if (selectedPath) {
    await loadDiffForFile(selectedPath, selectedStatus);
  }
}

document.getElementById('btnGitDiff').onclick = () => {
  if (typeof closeSheet === 'function') closeSheet();
  openGitDiff(currentFile || null);
};

// Escape fecha diff / painel git
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (document.getElementById('diffOverlay')) closeDiffOverlay();
  if (document.getElementById('gitOverlay')) closeGitPanel();
});

// ========== SHELL (xterm) + TABS ==========
const aiChatArea = document.getElementById('aiChatArea');
const aiModelWrap = document.getElementById('aiModelWrap');
const consoleOutputEl = document.getElementById('consoleOutput');
const xtermContainer = document.getElementById('xtermContainer');
const consolePanel = document.querySelector('.console-panel');

let term = null;
let fitAddon = null;
let shellHistory = [];
let historyIndex = -1;
let currentLine = '';
let shellBusy = false;

function writePrompt() {
  if (!term) return;
  term.write('\x1b[32m$\x1b[0m ');
}

function writeShellBanner() {
  if (!term) return;
  term.writeln('\x1b[1;32mSimple Replit Shell\x1b[0m');
  term.writeln('\x1b[90mToque aqui e digite · Enter = executar · ↑/↓ = histórico · Ctrl+L = limpar\x1b[0m');
  term.writeln('');
  writePrompt();
}

/** Ajusta tamanho do xterm depois que o painel já tem altura real (mobile/desktop). */
function fitAndFocusTerminal(opts = {}) {
  if (!term) return;
  const redraw = !!opts.redraw;
  try {
    if (fitAddon) fitAddon.fit();
  } catch (_) {}
  // Se ainda estiver 0x0 (painel acabou de aparecer), força tamanho mínimo
  try {
    const rows = term.rows || 0;
    const cols = term.cols || 0;
    if (rows < 3 || cols < 10) {
      const h = Math.max(xtermContainer?.clientHeight || 0, 240);
      const w = Math.max(xtermContainer?.clientWidth || 0, 320);
      const forcedRows = Math.max(8, Math.floor(h / 18));
      const forcedCols = Math.max(40, Math.floor(w / 8));
      term.resize(forcedCols, forcedRows);
    }
  } catch (_) {}
  if (redraw) {
    try {
      term.reset();
      currentLine = '';
      writeShellBanner();
    } catch (_) {}
  }
  try { term.focus(); } catch (_) {}
  try { term.scrollToBottom(); } catch (_) {}
}

function initTerminal() {
  if (term) return;

  if (typeof Terminal === 'undefined') {
    if (xtermContainer) {
      xtermContainer.innerHTML =
        '<div style="color:#f85149;padding:12px;font:13px monospace">' +
        'Shell indisponível: xterm.js não carregou. Atualize a página (F5).</div>';
    }
    return;
  }

  term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace",
    theme: {
      background: '#111111',
      foreground: '#d4d4d4',
      cursor: '#58a6ff',
      selectionBackground: '#264f78',
      black: '#111',
      red: '#f85149',
      green: '#3fb950',
      yellow: '#d29922',
      blue: '#58a6ff',
      magenta: '#bc8cff',
      cyan: '#39c5cf',
      white: '#d4d4d4',
    },
    convertEol: true,
    scrollback: 2000,
    allowProposedApi: true,
  });

  if (typeof FitAddon !== 'undefined' && FitAddon.FitAddon) {
    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
  }

  // Container precisa estar visível antes do open/fit
  xtermContainer.style.display = 'block';
  term.open(xtermContainer);
  writeShellBanner();

  // Clique/toque no painel foca o terminal (mobile)
  xtermContainer.addEventListener('click', () => {
    try { term.focus(); } catch (_) {}
  });
  xtermContainer.addEventListener('touchstart', () => {
    try { term.focus(); } catch (_) {}
  }, { passive: true });

  term.onData((data) => {
    if (shellBusy) return;
    const code = data.charCodeAt(0);

    // Enter
    if (data === '\r' || data === '\n') {
      term.write('\r\n');
      const cmd = currentLine;
      currentLine = '';
      if (cmd.trim()) {
        shellHistory.push(cmd);
        if (shellHistory.length > 100) shellHistory.shift();
      }
      historyIndex = shellHistory.length;
      runShellInTerm(cmd);
      return;
    }

    // Backspace
    if (data === '\x7f' || data === '\b') {
      if (currentLine.length > 0) {
        currentLine = currentLine.slice(0, -1);
        term.write('\b \b');
      }
      return;
    }

    // Ctrl+C
    if (code === 3) {
      term.write('^C\r\n');
      currentLine = '';
      writePrompt();
      return;
    }

    // Ctrl+L clear
    if (code === 12) {
      term.clear();
      currentLine = '';
      writePrompt();
      return;
    }

    // Arrow Up
    if (data === '\x1b[A') {
      if (shellHistory.length === 0) return;
      historyIndex = Math.max(0, historyIndex - 1);
      replaceCurrentLine(shellHistory[historyIndex] || '');
      return;
    }

    // Arrow Down
    if (data === '\x1b[B') {
      if (shellHistory.length === 0) return;
      historyIndex = Math.min(shellHistory.length, historyIndex + 1);
      replaceCurrentLine(historyIndex >= shellHistory.length ? '' : shellHistory[historyIndex]);
      return;
    }

    // Ignore other escape sequences
    if (data.startsWith('\x1b')) return;

    // Printable
    if (code >= 32) {
      currentLine += data;
      term.write(data);
    }
  });

  window.addEventListener('resize', () => {
    if (xtermContainer && xtermContainer.style.display !== 'none') {
      fitAndFocusTerminal();
    }
  });
}

function replaceCurrentLine(text) {
  // erase current line visually
  for (let i = 0; i < currentLine.length; i++) term.write('\b \b');
  currentLine = text || '';
  term.write(currentLine);
}

async function runShellInTerm(cmd) {
  if (!cmd.trim()) {
    writePrompt();
    return;
  }
  shellBusy = true;
  try {
    const res = await apiFetch('/api/shell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: cmd }),
    });
    const data = await res.json();
    if (data.output) term.writeln(data.output);
    if (data.error) term.writeln('\x1b[31m' + data.error + '\x1b[0m');
    if (data.success && !data.output && !data.error) {
      term.writeln('\x1b[90m(sem saída)\x1b[0m');
    }
  } catch (err) {
    term.writeln('\x1b[31mErro de conexão: ' + err.message + '\x1b[0m');
  }
  shellBusy = false;
  writePrompt();
}

function showConsoleTab(name) {
  document.querySelectorAll('.console-tabs .tab').forEach((t) => t.classList.remove('active'));
  const tabBtn = document.querySelector(`.console-tabs .tab[data-tab="${name}"]`);
  if (tabBtn) tabBtn.classList.add('active');

  const isShell = name === 'shell';
  const isAi = name === 'ai';
  const isConsole = name === 'console';

  consoleOutputEl.style.display = isConsole ? 'block' : 'none';
  xtermContainer.style.display = isShell ? 'block' : 'none';
  aiChatArea.style.display = isAi ? 'flex' : 'none';
  aiModelWrap.style.display = isAi ? 'block' : 'none';
  if (consolePanel) consolePanel.classList.toggle('shell-active', isShell);
  const expandBtn = document.getElementById('btnExpandShell');
  if (expandBtn) expandBtn.style.display = isShell ? 'inline-block' : 'none';
  const sourceFilterEl = document.getElementById('consoleSourceFilter');
  const copyBtn = document.getElementById('btnCopyConsole');
  if (sourceFilterEl) sourceFilterEl.style.display = isConsole ? 'inline-block' : 'none';
  if (copyBtn) copyBtn.style.display = isConsole ? 'inline-block' : 'none';

  if (isShell) {
    initTerminal();
    // Mobile: painel ganha altura só após o CSS da view — fit em cascata
    requestAnimationFrame(() => {
      fitAndFocusTerminal({ redraw: !term || term.rows < 3 });
      setTimeout(() => fitAndFocusTerminal(), 80);
      setTimeout(() => fitAndFocusTerminal(), 250);
    });
  }
  if (isAi) document.getElementById('aiInput')?.focus();
}

document.querySelectorAll('.console-tabs .tab').forEach((tab) => {
  tab.onclick = () => {
    const name = tab.dataset.tab;
    if (document.body.classList.contains('mode-mobile') && typeof setMobileView === 'function') {
      // Alinha a view mobile com a aba (console/shell/ai)
      if (name === 'shell') setMobileView('shell');
      else if (name === 'ai') setMobileView('agent');
      else setMobileView('console');
      return;
    }
    showConsoleTab(name);
  };
});

// ========== SHELL EM TELA CHEIA (estilo Replit) ==========
// Reaproveita a mesma instância do xterm — só move o container de DOM pra
// dentro do overlay e de volta, sem recriar o terminal (preserva scrollback).
let shellFsAnchor = null; // marcador no lugar original do xtermContainer, pra saber onde devolver

function openShellFullscreen() {
  if (document.getElementById('shellFsOverlay')) return;
  initTerminal();
  shellFsAnchor = document.createComment('xterm-anchor');
  xtermContainer.parentNode.insertBefore(shellFsAnchor, xtermContainer);

  const overlay = document.createElement('div');
  overlay.id = 'shellFsOverlay';
  overlay.className = 'shell-fs-overlay';
  overlay.innerHTML = `
    <div class="shell-fs-header">
      <button type="button" class="ai-ws-back" id="shellFsBack" title="Voltar">←</button>
      <span class="shell-fs-badge">🐚 Shell</span>
      <span class="shell-fs-path">~/workspace: bash</span>
      <div class="shell-fs-actions">
        <button type="button" class="ai-ws-icon-btn" id="shellFsClear" title="Limpar">🗑</button>
        <button type="button" class="ai-ws-icon-btn" id="shellFsClose" title="Fechar">✕</button>
      </div>
    </div>
    <div class="shell-fs-body" id="shellFsBody"></div>`;
  document.body.appendChild(overlay);
  document.getElementById('shellFsBody').appendChild(xtermContainer);
  xtermContainer.style.display = 'block';

  const close = () => closeShellFullscreen();
  document.getElementById('shellFsBack').onclick = close;
  document.getElementById('shellFsClose').onclick = close;
  document.getElementById('shellFsClear').onclick = () => {
    if (term) { term.clear(); currentLine = ''; writePrompt(); }
  };

  requestAnimationFrame(() => {
    fitAndFocusTerminal();
    setTimeout(() => fitAndFocusTerminal(), 80);
  });
}

function closeShellFullscreen() {
  const overlay = document.getElementById('shellFsOverlay');
  if (!overlay || !shellFsAnchor) return;
  shellFsAnchor.parentNode.insertBefore(xtermContainer, shellFsAnchor.nextSibling);
  shellFsAnchor.remove();
  shellFsAnchor = null;
  overlay.remove();
  requestAnimationFrame(() => fitAndFocusTerminal());
}

document.getElementById('btnExpandShell')?.addEventListener('click', openShellFullscreen);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('shellFsOverlay')) closeShellFullscreen();
});

// clear also clears xterm when on shell
const _origClear = document.getElementById('btnClearConsole').onclick;
document.getElementById('btnClearConsole').onclick = () => {
  document.getElementById('consoleOutput').innerHTML = '';
  if (term && xtermContainer.style.display !== 'none') {
    term.clear();
    currentLine = '';
    writePrompt();
  }
  if (typeof _origClear === 'function') {
    /* already cleared above */
  }
};

// ========== API KEYS (.env) ==========
document.getElementById('btnApiKeys').onclick = () => {
  consoleActiveSource = 'secrets';
  openFile('.env');
  appendConsole('info', 'Arquivo .env aberto. Edite as keys e salve (Ctrl+S).');
  appendConsole('info', 'Depois use 🚀 Deploy ou no Shell: docker compose restart app');
};

// ========== DEPLOY (com log ao vivo + backup opcional) ==========
document.getElementById('btnDeploy').onclick = async () => {
  consoleActiveSource = 'deploy';
  // OK = com backup · Cancelar = pergunta se quer sem backup
  let withBackup = confirm(
    'Deploy agora?\n\n1. Backup automático\n2. git pull\n3. docker compose up -d --build\n4. status\n\nOK = Deploy COM backup\nCancelar = outras opções'
  );
  if (!withBackup) {
    const sem = confirm('Fazer deploy SEM backup?');
    if (!sem) return;
  }

  showConsoleTab('console');

  const btn = document.getElementById('btnDeploy');
  btn.disabled = true;
  btn.textContent = '🚀 Deploying...';

  if (withBackup) {
    appendConsole('info', '── Backup pré-deploy ──');
    try {
      const res = await apiFetch('/api/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'pre-deploy' }),
      });
      const data = await res.json();
      if (data.success) {
        appendConsole('info', `✔ Backup: ${data.name} (${data.sizeHuman})`);
        toast('Backup salvo: ' + data.name, 'success');
      } else {
        appendConsole('stderr', 'Backup falhou: ' + (data.error || ''));
        if (!confirm('Backup falhou. Continuar o deploy mesmo assim?')) {
          btn.disabled = false;
          btn.textContent = '🚀 Deploy';
          return;
        }
      }
    } catch (err) {
      appendConsole('stderr', 'Erro no backup: ' + err.message);
      if (!confirm('Backup falhou. Continuar o deploy mesmo assim?')) {
        btn.disabled = false;
        btn.textContent = '🚀 Deploy';
        return;
      }
    }
  }

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

// ========== BACKUP / RESTORE ==========
document.getElementById('btnBackup').onclick = async () => {
  consoleActiveSource = 'backup';
  showConsoleTab('console');
  appendConsole('info', '── Criando backup do workspace ──');
  toast('Criando backup...', 'info');
  try {
    const res = await apiFetch('/api/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'manual' }),
    });
    const data = await res.json();
    if (data.success) {
      appendConsole('info', `✔ Backup salvo: ${data.name} (${data.sizeHuman})`);
      toast('Backup salvo: ' + data.name, 'success');
    } else {
      appendConsole('stderr', data.error || 'Falha no backup');
      toast(data.error || 'Falha no backup', 'error');
    }
  } catch (err) {
    appendConsole('stderr', 'Erro: ' + err.message);
    toast('Erro no backup', 'error');
  }
};

function closeBackupModal() {
  const m = document.getElementById('backupModal');
  if (m) m.remove();
}

async function openRestoreModal() {
  consoleActiveSource = 'backup';
  closeBackupModal();
  showConsoleTab('console');
  appendConsole('info', '── Carregando lista de backups ──');

  let backups = [];
  try {
    const res = await apiFetch('/api/backups');
    const data = await res.json();
    if (!data.success) {
      appendConsole('stderr', data.error || 'Erro ao listar backups');
      return;
    }
    backups = data.backups || [];
  } catch (err) {
    appendConsole('stderr', 'Erro: ' + err.message);
    return;
  }

  const modal = document.createElement('div');
  modal.id = 'backupModal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box backup-modal">
      <h3>♻ Restaurar Backup</h3>
      <p class="modal-hint">Antes de restaurar, um backup de segurança (pre-restore) é criado automaticamente.</p>
      <div class="backup-list" id="backupList"></div>
      <div class="modal-actions">
        <button type="button" class="btn" id="backupModalClose">Fechar</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const list = document.getElementById('backupList');
  if (!backups.length) {
    list.innerHTML = '<div class="backup-empty">Nenhum backup encontrado.</div>';
  } else {
    backups.forEach((b) => {
      const row = document.createElement('div');
      row.className = 'backup-row';
      row.innerHTML = `
        <div class="backup-info">
          <div class="backup-name">${b.name}</div>
          <div class="backup-meta">${b.mtimeLocal} · ${b.sizeHuman}</div>
        </div>
        <div class="backup-actions">
          <button type="button" class="btn btn-primary btn-restore-one" data-name="${b.name}">Restaurar</button>
          <button type="button" class="btn btn-danger btn-del-one" data-name="${b.name}" title="Apagar">🗑</button>
        </div>`;
      list.appendChild(row);
    });
  }

  document.getElementById('backupModalClose').onclick = closeBackupModal;
  modal.addEventListener('click', (e) => { if (e.target === modal) closeBackupModal(); });

  list.querySelectorAll('.btn-restore-one').forEach((btn) => {
    btn.onclick = async () => {
      consoleActiveSource = 'backup';
      const name = btn.dataset.name;
      if (!confirm(`Restaurar o workspace a partir de:\n\n${name}\n\nUm backup de segurança será criado antes.\nContinuar?`)) return;
      btn.disabled = true;
      btn.textContent = 'Restaurando...';
      appendConsole('info', `── Restaurando ${name} ──`);
      try {
        const res = await apiFetch('/api/restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, makeSafetyBackup: true }),
        });
        const data = await res.json();
        if (data.success) {
          appendConsole('info', `✔ ${data.message}`);
          if (data.safetyBackup) appendConsole('info', `Safety backup: ${data.safetyBackup}`);
          toast('Workspace restaurado', 'success');
          closeBackupModal();
          await loadFiles();
        } else {
          appendConsole('stderr', data.error || 'Falha ao restaurar');
          toast(data.error || 'Falha ao restaurar', 'error');
          btn.disabled = false;
          btn.textContent = 'Restaurar';
        }
      } catch (err) {
        appendConsole('stderr', 'Erro: ' + err.message);
        toast('Erro ao restaurar', 'error');
        btn.disabled = false;
        btn.textContent = 'Restaurar';
      }
    };
  });

  list.querySelectorAll('.btn-del-one').forEach((btn) => {
    btn.onclick = async () => {
      const name = btn.dataset.name;
      if (!confirm(`Apagar backup?\n\n${name}`)) return;
      try {
        const res = await apiFetch('/api/backup?name=' + encodeURIComponent(name), { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
          toast('Backup apagado', 'success');
          openRestoreModal();
        } else {
          toast(data.error || 'Erro ao apagar', 'error');
        }
      } catch (err) {
        toast('Erro: ' + err.message, 'error');
      }
    };
  });
}

document.getElementById('btnRestore').onclick = () => openRestoreModal();

// ========== LOGS AO VIVO ==========
let logEventSource = null;

function stopLogStream() {
  consoleActiveSource = 'logs';
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
  consoleActiveSource = 'logs';
  showConsoleTab('console');

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
  consoleActiveSource = 'monitor';
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
  consoleActiveSource = 'secrets';
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
  consoleActiveSource = 'restart';
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

// ========== AI CHAT + PAINEL AGENTE ==========
const aiMessages = [];
const aiMessagesEl = document.getElementById('aiMessages');
const aiInput = document.getElementById('aiInput');

function addAiMessage(role, content, files) {
  if (!aiMessagesEl) return;
  const div = document.createElement('div');
  div.className = `ai-msg ${role}`;
  div.textContent = content;
  const time = document.createElement('span');
  time.className = 'ai-msg-time';
  time.textContent = chatStamp();
  time.title = fullStamp();
  div.appendChild(time);
  if (files && files.length) {
    const actions = document.createElement('div');
    actions.className = 'file-actions';
    files.forEach((f) => {
      const btn = document.createElement('button');
      btn.textContent = `💾 Salvar ${f.path}`;
      btn.onclick = async () => {
        try {
          const res = await apiFetch('/api/file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: f.path, content: f.content }),
          });
          const data = await res.json();
          if (data.success) {
            btn.textContent = `✔ ${f.path}`;
            btn.style.background = '#14532d';
            loadFiles();
            if (currentFile === f.path && editor) editor.setValue(f.content);
          } else toast(data.error || 'Erro ao salvar', 'error');
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
  const text = (presetText || (aiInput && aiInput.value) || '').trim();
  if (!text) return;
  if (!presetText && aiInput) aiInput.value = '';
  const btnSend = document.getElementById('btnAiSend');
  if (btnSend) btnSend.disabled = true;
  aiMessages.push({ role: 'user', content: text });
  addAiMessage('user', text);
  const thinking = document.createElement('div');
  thinking.className = 'ai-msg assistant';
  thinking.textContent = 'Pensando...';
  thinking.id = 'aiThinking';
  if (aiMessagesEl) {
    aiMessagesEl.appendChild(thinking);
    aiMessagesEl.scrollTop = aiMessagesEl.scrollHeight;
  }
  try {
    const modelEl = document.getElementById('aiModel');
    const res = await apiFetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: aiMessages.slice(-12),
        model: modelEl ? modelEl.value : 'deepseek-flash',
        currentFile: currentFile,
        currentCode: editor ? editor.getValue() : '',
      }),
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

if (document.getElementById('btnAiSend')) {
  document.getElementById('btnAiSend').onclick = () => sendAiMessage();
}
if (aiInput) {
  aiInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendAiMessage();
    }
  });
}
document.querySelectorAll('.ai-chip').forEach((chip) => {
  chip.addEventListener('click', () => sendAiMessage(chip.dataset.prompt));
});

const AGENT_MEM_KEY = 'simple-replit-agent-messages';
let agentMessages = [];
try {
  const raw = localStorage.getItem(AGENT_MEM_KEY);
  if (raw) {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) agentMessages = parsed.slice(-40);
  }
} catch (_) {}

function persistAgentMessages() {
  try {
    localStorage.setItem(AGENT_MEM_KEY, JSON.stringify(agentMessages.slice(-40)));
  } catch (_) {}
}

function closeAiPanel() {
  document.getElementById('aiOverlay')?.remove();
}

function openAiPanel() {
  if (typeof closeSheet === 'function') closeSheet();
  closeAiPanel();
  const overlay = document.createElement('div');
  overlay.id = 'aiOverlay';
  overlay.className = 'ai-overlay';
  overlay.innerHTML = `
    <div class="ai-workspace">
      <div class="ai-ws-header">
        <button type="button" class="ai-ws-back" id="aiPanelClose" title="Fechar">←</button>
        <div class="ai-ws-title">
          <span class="ai-ws-title-icon">✦</span>
          <span class="ai-ws-title-text">Agente</span>
        </div>
        <div class="ai-ws-actions">
          <button type="button" class="ai-ws-icon-btn" id="aiPanelUsage" title="Custos de API">💰</button>
          <button type="button" class="ai-ws-icon-btn" id="aiPanelClear" title="Limpar histórico">🗑</button>
        </div>
      </div>
      <div class="ai-ws-subbar">
        <label class="ai-agent-toggle"><input type="checkbox" id="aiAgentMode" checked /> Agente (fazer ações)</label>
        <select id="aiPanelModel">
          <option value="deepseek-flash">DeepSeek Flash</option>
          <option value="deepseek-pro">DeepSeek Pro</option>
          <option value="groq-fast">Groq Fast</option>
          <option value="groq-quality">Groq Quality</option>
        </select>
      </div>
      <div class="ai-ws-body">
        <div class="ai-ws-messages" id="aiPanelMessages"></div>
        <div class="ai-ws-footer">
          <div class="ai-ws-chips">
            <button type="button" data-p="Liste a estrutura principal do projeto e diga o que cada pasta faz">Mapear projeto</button>
            <button type="button" data-p="Mostre o status do git e resuma as alterações">Status git</button>
            <button type="button" data-p="Crie um arquivo hello_agent.py que imprime Olá do agente e rode ele">Criar e rodar</button>
            <button type="button" data-p="Explique o arquivo aberto agora">Explicar arquivo</button>
          </div>
          <div class="ai-ws-input-row">
            <textarea id="aiPanelInput" placeholder="Peça para criar, editar, rodar, commit… (modo agente faz de verdade)"></textarea>
            <button type="button" class="ai-ws-send" id="aiPanelSend" title="Enviar">➤</button>
          </div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  document.getElementById('aiPanelClose').onclick = closeAiPanel;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeAiPanel(); });
  document.getElementById('aiPanelClear').onclick = () => {
    agentMessages.length = 0;
    persistAgentMessages();
    document.getElementById('aiPanelMessages').innerHTML = '';
  };
  document.getElementById('aiPanelUsage').onclick = async () => {
    try {
      const res = await apiFetch('/api/ai/usage?days=7');
      const data = await res.json();
      if (!data.success) {
        addPanelMsg('assistant', 'Erro ao ler custos: ' + (data.error || ''));
        return;
      }
      const t = data.today || {};
      const p = data.period || {};
      const lines = [
        '── Custos API (estimativa) ──',
        `Hoje: ${t.calls || 0} chamadas · ${t.total_tokens || 0} tokens · ~$${(t.cost_usd || 0).toFixed(4)}`,
        `7 dias: ${p.calls || 0} chamadas · ${p.total_tokens || 0} tokens · ~$${(p.cost_usd || 0).toFixed(4)}`,
      ];
      if (t.by_model) {
        Object.entries(t.by_model).forEach(([m, v]) => {
          lines.push(`  ${m}: ${v.calls}× · ${v.total_tokens} tok · ~$${(v.cost_usd || 0).toFixed(5)}`);
        });
      }
      if (data.recent && data.recent.length) {
        lines.push('Últimas:');
        data.recent.slice(0, 5).forEach((r) => {
          lines.push(`  ${r.at.slice(11, 19)} ${r.endpoint} ${r.modelKey} ${r.total_tokens} tok ~$${Number(r.cost_usd).toFixed(5)}`);
        });
      }
      lines.push('Valores aproximados (tabela pública do provedor).');
      addPanelMsg('assistant', lines.join('\n'));
    } catch (err) {
      addPanelMsg('assistant', 'Erro custos: ' + err.message);
    }
  };
  const msgBox = document.getElementById('aiPanelMessages');

  /** Bolha de mensagem (usuário/assistente) com timestamp — cada log do agente tem data/hora. */
  function addPanelMsg(role, content, ts) {
    const d = ts ? new Date(ts) : new Date();
    const div = document.createElement('div');
    div.className = 'ai-ws-msg ' + role;
    const text = document.createElement('div');
    text.className = 'ai-ws-msg-text';
    text.textContent = content;
    div.appendChild(text);
    const time = document.createElement('span');
    time.className = 'ai-ws-msg-time';
    time.textContent = chatStamp(d);
    time.title = fullStamp(d);
    div.appendChild(time);
    msgBox.appendChild(div);
    msgBox.scrollTop = msgBox.scrollHeight;
    return div;
  }

  /**
   * Bloco colapsável "⚙ Trabalhou por Ns" com a lista de ferramentas usadas nessa
   * rodada — cada chamada mostra hora exata (estilo "Worked for Ns" do Replit).
   */
  function addPanelTrace(trace, elapsedSec) {
    const okCount = trace.filter((tr) => tr.result && tr.result.ok !== false).length;
    const failCount = trace.length - okCount;
    const now = new Date();
    const details = document.createElement('details');
    details.className = 'ai-ws-trace';
    const summary = document.createElement('summary');
    summary.innerHTML =
      `<span class="trace-icon">⚙</span>` +
      `<span class="trace-label">Trabalhou por ${elapsedSec}s · ${trace.length} ação(ões)` +
      (failCount ? ` · ${failCount} falha(s)` : '') + `</span>` +
      `<span class="trace-time" title="${escapeHtml(fullStamp(now))}">${escapeHtml(chatStamp(now))}</span>`;
    details.appendChild(summary);
    const body = document.createElement('div');
    body.className = 'ai-ws-trace-body';
    trace.forEach((tr) => {
      const ok = tr.result && tr.result.ok !== false;
      const err = !ok && tr.result ? (tr.result.error || tr.result.stderr || '') : '';
      const argsPreview = JSON.stringify(tr.args || {}).slice(0, 120);
      const step = document.createElement('div');
      step.className = 'trace-step ' + (ok ? 'ok' : 'err');
      step.innerHTML =
        `<span class="trace-step-icon">${ok ? '✔' : '✖'}</span>` +
        `<span class="trace-step-time" title="${escapeHtml(fullStamp(now))}">${escapeHtml(clockStamp(now))}</span>` +
        `<span class="trace-step-name">${escapeHtml(tr.tool)}</span>` +
        `<span class="trace-step-args">${escapeHtml(argsPreview)}</span>` +
        (err ? `<span class="trace-step-err">${escapeHtml(String(err).slice(0, 220))}</span>` : '');
      body.appendChild(step);
    });
    details.appendChild(body);
    msgBox.appendChild(details);
    msgBox.scrollTop = msgBox.scrollHeight;
  }

  agentMessages.forEach((m) => addPanelMsg(m.role === 'user' ? 'user' : 'assistant', m.content, m.ts));

  async function sendAgent(text) {
    const input = document.getElementById('aiPanelInput');
    const t = (text || (input && input.value) || '').trim();
    if (!t) return;
    if (input) input.value = '';
    agentMessages.push({ role: 'user', content: t, ts: Date.now() });
    persistAgentMessages();
    addPanelMsg('user', t);
    const agentOn = document.getElementById('aiAgentMode')?.checked !== false;
    const model = document.getElementById('aiPanelModel')?.value || 'deepseek-flash';
    const thinking = document.createElement('div');
    thinking.className = 'ai-ws-msg assistant ai-ws-thinking';
    thinking.id = 'aiPanelThinking';
    thinking.textContent = agentOn ? 'Agente trabalhando (arquivos/git/shell)…' : 'Pensando…';
    msgBox.appendChild(thinking);
    msgBox.scrollTop = msgBox.scrollHeight;
    const endpoint = agentOn ? '/api/ai/agent' : '/api/ai/chat';
    const startedAt = Date.now();
    try {
      const res = await apiFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: agentMessages.slice(-16),
          model,
          currentFile,
          currentCode: editor ? editor.getValue() : '',
        }),
      });
      const data = await res.json();
      document.getElementById('aiPanelThinking')?.remove();
      if (!data.success) {
        addPanelMsg('assistant', 'Erro: ' + (data.error || 'falha'));
        return;
      }
      const elapsedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      if (data.trace && data.trace.length) {
        addPanelTrace(data.trace, elapsedSec);
        loadFiles();
        if (typeof refreshGitBadge === 'function') refreshGitBadge();
      }
      const content = data.content || '(sem texto)';
      const assistantTs = Date.now();
      agentMessages.push({ role: 'assistant', content, ts: assistantTs });
      persistAgentMessages();
      addPanelMsg('assistant', content, assistantTs);
      if (data.cost && (data.cost.total_tokens || data.cost.cost_usd)) {
        const c = data.cost;
        addPanelMsg('tool',
          `💰 esta chamada: ${c.total_tokens || 0} tokens · ~$${(c.cost_usd || 0).toFixed(5)}` +
          (c.day_total_usd != null ? ` · hoje ~$${Number(c.day_total_usd).toFixed(4)}` : '')
        );
      }
      if (data.files && data.files.length) {
        for (const f of data.files) {
          try {
            await apiFetch('/api/file', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: f.path, content: f.content }),
            });
            addPanelMsg('tool', `✔ salvo ${f.path}`);
            loadFiles();
          } catch (_) {}
        }
      }
    } catch (err) {
      document.getElementById('aiPanelThinking')?.remove();
      addPanelMsg('assistant', 'Erro: ' + err.message);
    }
  }

  document.getElementById('aiPanelSend').onclick = () => sendAgent();
  document.getElementById('aiPanelInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendAgent();
    }
  });
  overlay.querySelectorAll('.ai-ws-chips button').forEach((b) => {
    b.onclick = () => sendAgent(b.dataset.p);
  });
}

document.getElementById('btnAiPanel')?.addEventListener('click', openAiPanel);
document.getElementById('btnAiTop')?.addEventListener('click', openAiPanel);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('aiOverlay')) closeAiPanel();
});

// Só após login (precisa AUTH_TOKEN); sem header → 401 e aviso falso de “sem key”
function checkAiKeysStatus() {
  if (!getAuthToken()) return;
  fetch('/api/ai/status', { headers: authHeaders() })
    .then((r) => (r.ok ? r.json() : null))
    .then((s) => {
      if (s && !s.groq && !s.deepseek) {
        console.warn('Nenhuma API key de IA configurada (GROQ_API_KEY / DEEPSEEK_API_KEY)');
      }
    })
    .catch(() => {});
}
checkAiKeysStatus();
window.addEventListener('sr-auth', checkAiKeysStatus);

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
    document.body.classList.remove('view-files', 'view-code', 'view-console', 'view-shell', 'view-ai', 'view-agent', 'view-actions');
  }

  setTimeout(() => {
    if (typeof editor !== 'undefined' && editor) editor.layout();
  }, 100);
}

function setMobileView(view) {
  const views = ['files', 'code', 'console', 'shell', 'ai', 'agent', 'actions'];
  views.forEach(v => document.body.classList.remove('view-' + v));
  document.body.classList.add('view-' + view);
  localStorage.setItem('sr_mobile_view', view);

  document.querySelectorAll('#bottomNav .bnav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });

  // Tabs internas depois do CSS da view (evita painel com altura 0)
  requestAnimationFrame(() => {
    try {
      if (view === 'ai' || view === 'agent') {
        showConsoleTab('ai');
      } else if (view === 'shell') {
        showConsoleTab('shell');
      } else if (view === 'console') {
        showConsoleTab('console');
      } else if (view === 'actions') {
        showConsoleTab('console');
        if (typeof showActionsPanel === 'function') showActionsPanel();
      }
    } catch (err) {
      console.error('setMobileView tab error', err);
    }

    setTimeout(() => {
      if (typeof editor !== 'undefined' && editor) {
        try { editor.layout(); } catch (_) {}
      }
      if (view === 'shell' && typeof fitAndFocusTerminal === 'function') {
        fitAndFocusTerminal();
        setTimeout(() => fitAndFocusTerminal(), 150);
      } else if ((view === 'shell' || view === 'console') && typeof fitAddon !== 'undefined' && fitAddon) {
        try { fitAddon.fit(); } catch (_) {}
      }
      if (view === 'shell' && typeof term !== 'undefined' && term) {
        try { term.focus(); } catch (_) {}
      }
    }, 120);
  });
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

// Bottom nav mobile (Replit-style)
document.querySelectorAll('#bottomNav .bnav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.action === 'tools' || btn.dataset.action === 'more') {
      openSheet();
      return;
    }
    closeSheet();
    const view = btn.dataset.view;
    if (view === 'agent') {
      // Agent: sempre abre o painel completo (com ferramentas) — igual em mobile e desktop.
      setMobileView('agent');
      if (typeof openAiPanel === 'function') openAiPanel();
      return;
    }
    setMobileView(view);
  });
});

// Tools sheet rows
document.getElementById('btnToolAgent')?.addEventListener('click', () => {
  closeSheet();
  if (typeof openAiPanel === 'function') openAiPanel();
  else setMobileView('agent');
});
document.getElementById('btnToolShell')?.addEventListener('click', () => {
  closeSheet();
  setMobileView('shell');
});
document.getElementById('btnToolConsole')?.addEventListener('click', () => {
  closeSheet();
  setMobileView('console');
});
document.getElementById('btnToolFiles')?.addEventListener('click', () => {
  closeSheet();
  setMobileView('files');
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

// Sync mode selects (menu Tools + atalho na topbar mobile)
[document.getElementById('modeSelectMobile'), document.getElementById('modeSelectTopMobile')]
  .filter((el) => el && modeSelect)
  .forEach((select) => {
    select.value = modeSelect.value;
    select.onchange = () => {
      modeSelect.value = select.value;
      applyMode(select.value);
      closeSheet();
    };
    modeSelect.addEventListener('change', () => {
      select.value = modeSelect.value;
    });
  });

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
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w') {
    e.preventDefault();
    if (currentFile) closeTab(currentFile);
  }
  if (e.key === 'Escape') {
    closeFilePalette();
    if (typeof hideCtxMenu === 'function') hideCtxMenu();
    if (typeof closeSheet === 'function') closeSheet();
  }
});
