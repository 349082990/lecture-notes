// Lecture Notes — main process
const {
  app, BrowserWindow, globalShortcut, ipcMain, nativeTheme, screen,
  Tray, Menu, dialog, shell, nativeImage, net
} = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { pathToFileURL, fileURLToPath } = require('url');

app.setAppUserModelId('com.lecturenotes.app');
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
const DEFAULTS = {
  theme: 'system',                       // system | light | dark
  darkStyle: 'black',                    // black | gray — how dark mode looks
  toggleShortcut: 'CommandOrControl+]',
  immersiveShortcut: 'CommandOrControl+Alt+I',
  docsFolder: path.join(app.getPath('documents'), 'Lecture Notes'),
  immersiveMargins: 'narrow',            // none | narrow | normal | wide
  editorMargins: 'normal',               // narrow | normal | wide
  overlayOpacity: 1,                     // whole overlay (text + background)
  backgroundOpacity: 0.94,               // background only
  linesPerView: 25,                      // 1 | 2 | 25
  immersiveZoom: 1,                      // text scale in immersive mode
  editorPage: 'paper',                   // paper (white page) | match (follows theme)
  alwaysOnTop: true,
  launchAtStartup: false,
  defaultFont: 'Arial',
  defaultFontSize: 8,
  defaultLineSpacing: 1.15,
  mode: 'editor',
  editorBounds: null,
  immersiveBounds: null,
  lastDoc: null,
  sidebarOpen: false,
  readPositions: {},
  lastAutoUpdate: null                   // version last auto-installed at launch (stops a retry loop if it fails)
};

let settings = loadSettings();
let win = null;
let tray = null;
let quitting = false;
let shortcutErrors = {};
let fullBounds = null;                   // editor bounds to restore when leaving full screen
let updater = null;
let updateStatus = { state: app.isPackaged ? 'idle' : 'dev' };
const launchedAt = Date.now();

function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    return { ...DEFAULTS, ...s };
  } catch { return { ...DEFAULTS }; }
}
let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSettingsNow, 150);
}
function saveSettingsNow() {
  clearTimeout(saveTimer);
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  } catch (e) { console.error('settings save failed', e); }
}

/* ---------------- window ---------------- */
function defaultBounds(mode) {
  const wa = screen.getPrimaryDisplay().workArea;
  if (mode === 'immersive') {
    const w = Math.min(560, wa.width - 40);
    return { x: wa.x + Math.round((wa.width - w) / 2), y: wa.y + 24, width: w, height: 160 };
  }
  const w = Math.min(1040, wa.width - 80), h = Math.min(760, wa.height - 80);
  return { x: wa.x + Math.round((wa.width - w) / 2), y: wa.y + Math.round((wa.height - h) / 2), width: w, height: h };
}
function onScreen(b) {
  if (!b) return false;
  return screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return b.x + 60 > a.x && b.x < a.x + a.width - 60 && b.y + 10 > a.y - 40 && b.y < a.y + a.height - 20;
  });
}
function boundsFor(mode) {
  const b = mode === 'immersive' ? settings.immersiveBounds : settings.editorBounds;
  return onScreen(b) ? b : defaultBounds(mode);
}

function createWindow() {
  const b = boundsFor(settings.mode);
  win = new BrowserWindow({
    ...b,
    minWidth: 160, minHeight: 18,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    show: false,
    alwaysOnTop: settings.alwaysOnTop,
    skipTaskbar: false,
    title: 'Lecture Notes',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true
    }
  });
  applyAlwaysOnTop();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { win.show(); });

  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
  const remember = () => {
    if (!win || win.isDestroyed() || win.isMinimized() || fullBounds) return;
    const key = settings.mode === 'immersive' ? 'immersiveBounds' : 'editorBounds';
    settings[key] = win.getBounds();
    saveSettings();
  };
  win.on('moved', remember);
  win.on('resized', remember);

  // Block navigation away from the app (e.g. dropped links)
  win.webContents.on('will-navigate', (e, url) => { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });

  setupContextMenu();
}

function applyAlwaysOnTop() {
  if (!win) return;
  if (settings.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver');
  else win.setAlwaysOnTop(false);
}

function toggleVisible() {
  if (!win) return;
  if (win.isVisible() && !win.isMinimized()) {
    win.hide();
  } else {
    if (win.isMinimized()) win.restore();
    if (settings.mode === 'immersive') win.showInactive(); else { win.show(); win.focus(); }
    applyAlwaysOnTop();
  }
}
function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus(); applyAlwaysOnTop();
}

// Full screen is done by hand (the window is frameless + transparent, so the native kind isn't available):
// cover the whole display, and put the old bounds back afterwards.
function setFullscreen(on) {
  if (!win || win.isDestroyed()) return;
  on = !!on && settings.mode === 'editor';
  if (on === !!fullBounds) return;
  if (on) {
    fullBounds = win.getBounds();
    win.setBounds(screen.getDisplayMatching(fullBounds).bounds);
    if (!win.isVisible()) win.show();
    win.focus();
  } else {
    const b = fullBounds;
    fullBounds = null;
    win.setBounds(b);
  }
  win.webContents.send('fullscreen', on);
}

function setMode(mode) {
  if (!win || (mode !== 'editor' && mode !== 'immersive')) return;
  if (fullBounds) setFullscreen(false);
  const prev = settings.mode;
  if (prev === mode) { win.webContents.send('mode', mode); return; }
  settings[prev === 'immersive' ? 'immersiveBounds' : 'editorBounds'] = win.getBounds();
  settings.mode = mode;
  win.setBounds(boundsFor(mode));
  saveSettings();
  win.webContents.send('mode', mode);
  if (!win.isVisible()) { mode === 'immersive' ? win.showInactive() : win.show(); }
}

/* ---------------- shortcuts ---------------- */
function registerShortcuts() {
  globalShortcut.unregisterAll();
  shortcutErrors = {};
  const reg = (key, accel, fn) => {
    if (!accel) return;
    try {
      const ok = globalShortcut.register(accel, fn);
      if (!ok) shortcutErrors[key] = `"${accel}" is already used by another app`;
    } catch (e) { shortcutErrors[key] = `"${accel}" is not a valid shortcut`; }
  };
  reg('toggleShortcut', settings.toggleShortcut, toggleVisible);
  reg('immersiveShortcut', settings.immersiveShortcut, () => {
    if (!win) return;
    if (!win.isVisible()) { win.showInactive(); }
    setMode(settings.mode === 'immersive' ? 'editor' : 'immersive');
  });
  if (win && !win.isDestroyed()) win.webContents.send('shortcut-errors', shortcutErrors);
}

/* ---------------- tray ---------------- */
function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'tray.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip('Lecture Notes');
  refreshTrayMenu();
  tray.on('click', toggleVisible);
}
function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show / Hide', accelerator: settings.toggleShortcut, click: toggleVisible },
    { label: 'Immersive mode', type: 'checkbox', checked: settings.mode === 'immersive',
      click: () => { showWindow(); setMode(settings.mode === 'immersive' ? 'editor' : 'immersive'); } },
    { label: 'Settings…', click: () => { showWindow(); win.webContents.send('cmd', 'settings'); } },
    { label: 'Reset window position', click: () => { setFullscreen(false); win.setBounds(defaultBounds(settings.mode)); showWindow(); } },
    updateStatus.state === 'ready'
      ? { label: `Restart to update (v${updateStatus.version})`, click: () => { showWindow(); win.webContents.send('cmd', 'update'); } }
      : { label: 'Check for updates', enabled: !!updater, click: () => { showWindow(); win.webContents.send('cmd', 'update'); } },
    { type: 'separator' },
    { label: 'Quit Lecture Notes', click: () => { quitting = true; app.quit(); } }
  ]));
}

/* ---------------- updates ---------------- */
// Releases are published to GitHub (see "publish" in package.json and scripts/release.js).
// The app checks at launch and every few hours, downloads in the background, and installs
// when it quits. An update that's ready within a minute of launch is installed right away,
// so closing and reopening the app is enough to get the latest version.
function sendUpdate(status) {
  updateStatus = status;
  if (win && !win.isDestroyed()) win.webContents.send('update-status', status);
  refreshTrayMenu();
}
const shortErr = (e) => String((e && e.message) || e).split('\n')[0].slice(0, 140);
function setupUpdater() {
  if (!app.isPackaged) return;
  try { updater = require('electron-updater').autoUpdater; } catch (e) { console.error('updater unavailable', e); return; }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('checking-for-update', () => sendUpdate({ state: 'checking' }));
  updater.on('update-not-available', () => sendUpdate({ state: 'none' }));
  updater.on('update-available', (i) => sendUpdate({ state: 'downloading', version: i.version, percent: 0 }));
  updater.on('download-progress', (p) => sendUpdate({ state: 'downloading', version: updateStatus.version, percent: p.percent }));
  updater.on('update-downloaded', (i) => sendUpdate({
    state: 'ready', version: i.version,
    auto: Date.now() - launchedAt < 60000 && settings.lastAutoUpdate !== i.version
  }));
  updater.on('error', (e) => { if (updateStatus.state !== 'ready') sendUpdate({ state: 'error', message: shortErr(e) }); });
  setTimeout(checkForUpdates, 3000);
  setInterval(checkForUpdates, 4 * 60 * 60 * 1000);
}
async function checkForUpdates() {
  if (!updater) return updateStatus;
  if (['checking', 'downloading', 'ready', 'installing'].includes(updateStatus.state)) return updateStatus;
  try { await updater.checkForUpdates(); } catch (e) { sendUpdate({ state: 'error', message: shortErr(e) }); }
  return updateStatus;
}
function installUpdate() {
  if (!updater || updateStatus.state !== 'ready') return;
  settings.lastAutoUpdate = updateStatus.version;
  saveSettingsNow();
  updateStatus = { ...updateStatus, state: 'installing' };
  quitting = true;
  setImmediate(() => updater.quitAndInstall(true, true)); // silent install, then reopen the app
}

/* ---------------- context menu (spelling, table, image) ---------------- */
let ctxInfo = {};
function setupContextMenu() {
  win.webContents.on('context-menu', (e, p) => {
    const send = (c) => () => win.webContents.send('cmd', c);
    const t = [];
    if (p.misspelledWord) {
      p.dictionarySuggestions.slice(0, 6).forEach(s => t.push({ label: s, click: () => win.webContents.replaceMisspelling(s) }));
      if (!p.dictionarySuggestions.length) t.push({ label: 'No suggestions', enabled: false });
      t.push({ label: 'Add to dictionary', click: () => win.webContents.session.addWordToSpellCheckerDictionary(p.misspelledWord) });
      t.push({ type: 'separator' });
    }
    if (ctxInfo.immersive) {
      t.push({ label: 'Exit immersive mode', click: () => setMode('editor') });
      t.push({ label: 'Lines per view', submenu: [1, 2, 25].map(n => ({ label: n === 25 ? 'Default (25 max)' : `${n} line${n > 1 ? 's' : ''}`, type: 'radio', checked: settings.linesPerView === n, click: () => win.webContents.send('set-setting', { linesPerView: n }) })) });
      t.push({ label: 'Hide', click: () => win.hide() });
    } else if (p.isEditable) {
      t.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { label: 'Paste without formatting', accelerator: 'CmdOrCtrl+Shift+V', click: send('pastePlain') },
        { type: 'separator' });
      if (ctxInfo.link) t.push({ label: 'Edit link', click: send('link') }, { label: 'Remove link', click: send('unlink') }, { type: 'separator' });
      if (ctxInfo.image) t.push(
        { label: 'Image size', submenu: [25, 50, 75, 100].map(n => ({ label: `${n}% width`, click: send('img:' + n) })) },
        { label: 'Image align', submenu: [['Left', 'left'], ['Center', 'center'], ['Right', 'right']].map(([l, v]) => ({ label: l, click: send('imgalign:' + v) })) },
        { label: 'Delete image', click: send('img:delete') }, { type: 'separator' });
      if (ctxInfo.table) t.push(
        { label: 'Insert row above', click: send('table:rowAbove') },
        { label: 'Insert row below', click: send('table:rowBelow') },
        { label: 'Insert column left', click: send('table:colLeft') },
        { label: 'Insert column right', click: send('table:colRight') },
        { label: 'Delete row', click: send('table:delRow') },
        { label: 'Delete column', click: send('table:delCol') },
        { label: 'Delete table', click: send('table:delTable') },
        { type: 'separator' });
      t.push({ label: 'Insert link…', click: send('link') }, { label: 'Clear formatting', click: send('clearFormat') }, { type: 'separator' }, { role: 'selectAll' });
    } else if (p.selectionText) {
      t.push({ role: 'copy' });
    }
    if (t.length) Menu.buildFromTemplate(t).popup({ window: win });
  });
}

/* ---------------- document storage ---------------- */
function root() { return settings.docsFolder; }
function safe(rel = '') {
  const r = path.resolve(root(), rel || '.');
  const base = path.resolve(root());
  if (r !== base && !r.startsWith(base + path.sep)) throw new Error('Path outside documents folder');
  return r;
}
function relOf(abs) { return path.relative(root(), abs).split(path.sep).join('/'); }
const DOC_EXT = '.html';
function cleanName(n) {
  return String(n || 'Untitled document').replace(/[<>:"/\\|?*\x00-\x1F]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled document';
}
async function uniquePath(dir, base, ext) {
  let p = path.join(dir, base + ext), i = 2;
  while (fs.existsSync(p)) p = path.join(dir, `${base} (${i++})${ext}`);
  return p;
}
function wrapHtml(title, body) {
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${title.replace(/</g, '&lt;')}</title>` +
    `<meta name="generator" content="Lecture Notes"></head>\n<body>\n${body}\n</body></html>\n`;
}
function bodyOf(html) {
  const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return (m ? m[1] : html).trim();
}
const previewCache = new Map();
async function previewOf(abs, mtimeMs) {
  const c = previewCache.get(abs);
  if (c && c.m === mtimeMs) return c.p;
  let p = '';
  try {
    const fd = await fsp.open(abs, 'r');
    const buf = Buffer.alloc(24000);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    await fd.close();
    p = bodyOf(buf.slice(0, bytesRead).toString('utf8'))
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<img[^>]*>/gi, ' [image] ')
      .replace(/<\/(p|div|li|h\d|tr)>/gi, ' \n ')
      .replace(/<[^>]*>?/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ').trim().slice(0, 160);
  } catch {}
  previewCache.set(abs, { m: mtimeMs, p });
  return p;
}
async function listTree(dirAbs) {
  let entries = [];
  try { entries = await fsp.readdir(dirAbs, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const abs = path.join(dirAbs, e.name);
    if (e.isDirectory()) {
      out.push({ type: 'folder', name: e.name, rel: relOf(abs), children: await listTree(abs) });
    } else if (e.isFile() && e.name.toLowerCase().endsWith(DOC_EXT)) {
      const st = await fsp.stat(abs);
      out.push({ type: 'doc', name: e.name.slice(0, -DOC_EXT.length), rel: relOf(abs), mtime: st.mtimeMs, preview: await previewOf(abs, st.mtimeMs) });
    }
  }
  out.sort((a, b) => a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : a.type === 'doc' ? b.mtime - a.mtime : a.name.localeCompare(b.name));
  return out;
}

const WELCOME = `<h1 style="font-size:14pt">Welcome to Lecture Notes</h1>
<p>This is a normal document — type, paste from Google Docs or Word, add images and tables.</p>
<p><b>Shortcuts</b></p>
<ul><li><b>Ctrl + ]</b> — show / hide the overlay (works from any app)</li>
<li><b>Ctrl + Alt + I</b> — switch between editor and immersive mode</li>
<li>In immersive mode: scroll, arrow keys or Space to move; drag anywhere to move the window; drag the edges to resize</li>
<li>Ctrl + scroll in immersive mode changes the text size</li></ul>
<p>Open the <b>☰</b> menu (top left) for all your documents and folders. Everything is saved automatically as you type.</p>
<p>Settings (gear icon) lets you change the theme, margins, opacity, lines per view and shortcuts.</p>`;

async function ensureRoot() {
  await fsp.mkdir(root(), { recursive: true });
  const items = await fsp.readdir(root());
  if (!items.some(n => n.toLowerCase().endsWith(DOC_EXT) || !n.includes('.'))) {
    await fsp.writeFile(path.join(root(), 'Welcome' + DOC_EXT), wrapHtml('Welcome', WELCOME));
  }
}

/* ---------------- IPC ---------------- */
function handle(ch, fn) {
  ipcMain.handle(ch, async (_e, ...a) => {
    try { return { ok: true, value: await fn(...a) }; }
    catch (err) { return { ok: false, error: err.message || String(err) }; }
  });
}

function setupIpc() {
  ipcMain.on('ctx-info', (e, info) => { ctxInfo = info || {}; e.returnValue = true; });

  handle('settings:get', () => ({ ...settings, shortcutErrors, platform: process.platform, version: app.getVersion() }));
  handle('settings:set', async (patch) => {
    const old = { ...settings };
    Object.assign(settings, patch);
    if ('theme' in patch) nativeTheme.themeSource = settings.theme;
    if ('alwaysOnTop' in patch) applyAlwaysOnTop();
    if ('launchAtStartup' in patch && app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!settings.launchAtStartup });
    if (patch.toggleShortcut !== undefined || patch.immersiveShortcut !== undefined) { registerShortcuts(); refreshTrayMenu(); }
    if ('docsFolder' in patch && patch.docsFolder !== old.docsFolder) { previewCache.clear(); await ensureRoot(); }
    if ('mode' in patch) refreshTrayMenu();
    saveSettings();
    return { ...settings, shortcutErrors };
  });
  handle('shortcuts:pause', (paused) => { if (paused) globalShortcut.unregisterAll(); else registerShortcuts(); });

  handle('win:getBounds', () => win.getBounds());
  handle('win:setBounds', (b) => {
    // immersive auto-height can arrive just after switching back to the editor — don't shrink the editor
    if (b.immersiveOnly && settings.mode !== 'immersive') return;
    const cur = win.getBounds();
    const nb = {
      x: Math.round(b.x ?? cur.x), y: Math.round(b.y ?? cur.y),
      width: Math.max(160, Math.round(b.width ?? cur.width)), height: Math.max(18, Math.round(b.height ?? cur.height))
    };
    win.setBounds(nb);
  });
  ipcMain.on('win:move', (_e, x, y) => { if (win) { const b = win.getBounds(); win.setBounds({ x: Math.round(x), y: Math.round(y), width: b.width, height: b.height }); } });
  ipcMain.on('win:resize', (_e, b) => { if (win) win.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.max(160, Math.round(b.width)), height: Math.max(18, Math.round(b.height)) }); });
  handle('win:workArea', () => screen.getDisplayMatching(win.getBounds()).workArea);
  handle('win:hide', () => win.hide());
  handle('win:minimize', () => win.minimize());
  handle('win:quit', () => { quitting = true; app.quit(); });
  handle('win:setMode', (m) => { setMode(m); refreshTrayMenu(); });
  handle('win:fullscreen', (on) => setFullscreen(on));

  handle('update:status', () => updateStatus);
  handle('update:check', () => checkForUpdates());
  handle('update:install', () => installUpdate());

  handle('docs:root', () => root());
  handle('docs:list', async () => { await ensureRoot(); return listTree(root()); });
  handle('docs:read', async (rel) => {
    const html = await fsp.readFile(safe(rel), 'utf8');
    return bodyOf(html);
  });
  handle('docs:write', async (rel, body) => {
    const abs = safe(rel);
    const title = path.basename(abs, DOC_EXT);
    const tmp = abs + '.tmp';
    await fsp.writeFile(tmp, wrapHtml(title, body));
    await fsp.rename(tmp, abs);
    return (await fsp.stat(abs)).mtimeMs;
  });
  handle('docs:create', async (folderRel, name, body) => {
    const dir = safe(folderRel || '');
    await fsp.mkdir(dir, { recursive: true });
    const p = await uniquePath(dir, cleanName(name), DOC_EXT);
    await fsp.writeFile(p, wrapHtml(path.basename(p, DOC_EXT), body || ''));
    return relOf(p);
  });
  handle('docs:rename', async (rel, newName) => {
    const abs = safe(rel);
    const isDoc = abs.toLowerCase().endsWith(DOC_EXT);
    const ext = isDoc ? DOC_EXT : '';
    const name = cleanName(newName);
    if (path.basename(abs) === name + ext) return rel;
    const p = await uniquePath(path.dirname(abs), name, ext);
    await fsp.rename(abs, p);
    return relOf(p);
  });
  handle('docs:delete', async (rel) => {
    const abs = safe(rel);
    if (abs === path.resolve(root())) throw new Error('Cannot delete the documents folder');
    try { await shell.trashItem(abs); } catch { await fsp.rm(abs, { recursive: true, force: true }); }
  });
  handle('docs:mkdir', async (parentRel, name) => {
    const p = await uniquePath(safe(parentRel || ''), cleanName(name || 'New folder'), '');
    await fsp.mkdir(p, { recursive: true });
    return relOf(p);
  });
  handle('docs:move', async (rel, destFolderRel) => {
    const abs = safe(rel);
    const dest = safe(destFolderRel || '');
    if (dest === abs || dest.startsWith(abs + path.sep)) throw new Error('Cannot move a folder into itself');
    if (path.dirname(abs) === dest) return rel;
    const ext = abs.toLowerCase().endsWith(DOC_EXT) ? DOC_EXT : '';
    const p = await uniquePath(dest, path.basename(abs, ext), ext);
    await fsp.rename(abs, p);
    return relOf(p);
  });
  handle('docs:exists', async (rel) => { try { await fsp.access(safe(rel)); return true; } catch { return false; } });
  handle('docs:openFolder', async (rel) => { await shell.openPath(safe(rel || '')); });
  handle('docs:chooseFolder', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose documents folder', defaultPath: root(), properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  handle('import:file', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Import document', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Documents', extensions: ['docx', 'html', 'htm', 'txt', 'md'] }]
    });
    if (r.canceled) return [];
    const out = [];
    for (const f of r.filePaths) {
      const ext = path.extname(f).toLowerCase();
      const name = path.basename(f, path.extname(f));
      let html = '';
      if (ext === '.docx') {
        const mammoth = require('mammoth');
        const res = await mammoth.convertToHtml({ path: f }, {
          styleMap: ['u => u', 'strike => s', "p[style-name='Title'] => h1.title:fresh", "p[style-name='Subtitle'] => p.subtitle:fresh"]
        });
        html = res.value;
      } else if (ext === '.html' || ext === '.htm') {
        html = bodyOf(await fsp.readFile(f, 'utf8'));
      } else {
        const txt = await fsp.readFile(f, 'utf8');
        html = txt.split(/\r?\n/).map(l => `<p>${l.replace(/&/g, '&amp;').replace(/</g, '&lt;') || '<br>'}</p>`).join('');
      }
      out.push({ name, html });
    }
    return out;
  });

  handle('export:file', async (format, title, body, pageCss) => {
    const filters = { docx: ['Word document', 'docx'], pdf: ['PDF', 'pdf'], html: ['Web page', 'html'] }[format];
    const r = await dialog.showSaveDialog(win, {
      title: 'Download as ' + format.toUpperCase(),
      defaultPath: path.join(app.getPath('downloads'), cleanName(title) + '.' + filters[1]),
      filters: [{ name: filters[0], extensions: [filters[1]] }]
    });
    if (r.canceled || !r.filePath) return null;
    if (format === 'html') {
      await fsp.writeFile(r.filePath, wrapHtml(title, `<style>${pageCss}</style>` + body));
    } else if (format === 'docx') {
      const HTMLtoDOCX = require('html-to-docx');
      const buf = await HTMLtoDOCX(wrapHtml(title, body), null, { font: settings.defaultFont, fontSize: settings.defaultFontSize * 2, table: { row: { cantSplit: true } } });
      await fsp.writeFile(r.filePath, buf);
    } else {
      const pdf = await renderOffscreen(title, body, pageCss, (wc) => wc.printToPDF({ pageSize: 'Letter', printBackground: true, margins: { marginType: 'none' } }));
      await fsp.writeFile(r.filePath, pdf);
    }
    shell.showItemInFolder(r.filePath);
    return r.filePath;
  });
  handle('print', async (title, body, pageCss) => {
    await renderOffscreen(title, body, pageCss, (wc) => new Promise((res) => wc.print({}, () => res())));
  });

  handle('image:inline', async (src) => {
    // Turns a remote (Google Docs) or local temp (Word) image into a data URI so it survives.
    try {
      if (/^file:/i.test(src)) {
        const p = fileURLToPath(src);
        const buf = await fsp.readFile(p);
        const ext = path.extname(p).slice(1).toLowerCase().replace('jpg', 'jpeg') || 'png';
        return `data:image/${ext};base64,${buf.toString('base64')}`;
      }
      if (/^https?:/i.test(src)) {
        const res = await net.fetch(src);
        if (!res.ok) return null;
        const type = res.headers.get('content-type') || 'image/png';
        if (!type.startsWith('image/')) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        return `data:${type};base64,${buf.toString('base64')}`;
      }
    } catch { return null; }
    return null;
  });
  handle('image:pick', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Insert image', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] }] });
    if (r.canceled) return [];
    const out = [];
    for (const f of r.filePaths) {
      const ext = path.extname(f).slice(1).toLowerCase();
      const mime = ext === 'svg' ? 'image/svg+xml' : 'image/' + (ext === 'jpg' ? 'jpeg' : ext);
      out.push(`data:${mime};base64,${(await fsp.readFile(f)).toString('base64')}`);
    }
    return out;
  });
  handle('menu:popup', (items, x, y) => new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const build = (arr) => arr.map(it => it.type === 'separator' ? { type: 'separator' } : {
      label: it.label,
      accelerator: it.accel || undefined, registerAccelerator: false,
      enabled: it.enabled !== false,
      type: it.checked !== undefined ? 'checkbox' : 'normal', checked: !!it.checked,
      submenu: it.submenu ? build(it.submenu) : undefined,
      click: it.submenu ? undefined : () => finish(it.id)
    });
    const opts = { window: win, callback: () => setTimeout(() => finish(null), 150) };
    if (Number.isFinite(x) && Number.isFinite(y)) { opts.x = x; opts.y = y; }
    Menu.buildFromTemplate(build(items)).popup(opts);
  }));
  handle('edit:native', (action) => {
    const wc = win.webContents;
    if (['cut', 'copy', 'paste', 'selectAll', 'pasteAndMatchStyle'].includes(action)) wc[action]();
  });
  handle('open:external', (url) => { if (/^(https?|mailto):/i.test(url)) shell.openExternal(url); });
}

async function renderOffscreen(title, body, pageCss, fn) {
  const w = new BrowserWindow({ show: false, webPreferences: { javascript: false } });
  try {
    const html = wrapHtml(title, `<style>${pageCss}</style>` + body);
    const tmp = path.join(app.getPath('temp'), `lecture-notes-print-${Date.now()}.html`);
    await fsp.writeFile(tmp, html);
    await w.loadURL(pathToFileURL(tmp).href);
    const out = await fn(w.webContents);
    fsp.unlink(tmp).catch(() => {});
    return out;
  } finally { setTimeout(() => { if (!w.isDestroyed()) w.destroy(); }, 500); }
}

/* ---------------- lifecycle ---------------- */
app.on('second-instance', showWindow);
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  nativeTheme.themeSource = settings.theme;
  nativeTheme.on('updated', () => win && win.webContents.send('theme-changed'));
  try { await ensureRoot(); } catch (e) { console.error(e); }
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!settings.launchAtStartup });
  setupIpc();
  createWindow();
  createTray();
  registerShortcuts();
  setupUpdater();
});
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {});
