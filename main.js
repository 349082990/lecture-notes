// Interview Notes — main process
const {
  app, BrowserWindow, globalShortcut, ipcMain, nativeTheme, screen,
  Tray, Menu, dialog, shell, nativeImage, net
} = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { pathToFileURL, fileURLToPath } = require('url');

app.setAppUserModelId('com.lecturenotes.app');
// Dev-only: automated tests run with LN_TEST_HIDDEN=1 — no window, tray icon or global shortcuts on screen.
const TEST_HIDDEN = !app.isPackaged && process.env.LN_TEST_HIDDEN === '1';
const TEST_OFFSET = TEST_HIDDEN ? -30000 : 0;
if (TEST_HIDDEN) app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
// Tests can opt in to real global shortcuts (use keys the user's own copy doesn't hold).
const SHORTCUTS_ON = !TEST_HIDDEN || process.env.LN_TEST_SHORTCUTS === '1';
// Until 2.0 the app was called "Lecture Notes". Copies updated from then keep using that settings
// folder (settings, documents folder, shortcuts, zoom) — only new installs get "Interview Notes".
{
  const legacy = path.join(app.getPath('appData'), 'Lecture Notes');
  if (!app.commandLine.hasSwitch('user-data-dir') && fs.existsSync(path.join(legacy, 'settings.json'))) app.setPath('userData', legacy);
}
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
const DEFAULTS = {
  theme: 'system',                       // system | light | dark
  darkStyle: 'black',                    // black | gray — how dark mode looks
  toggleShortcut: 'CommandOrControl+]',
  immersiveShortcut: 'CommandOrControl+Alt+I',
  linesShortcut: 'CommandOrControl+Alt+M',  // cycle lines shown in immersive mode
  opacityShortcut: 'CommandOrControl+Alt+O', // overlay opacity 100 → 80 → 60 → 40 → 20%
  headingPrevShortcut: 'CommandOrControl+Alt+Up',   // global only while the overlay shows
  headingNextShortcut: 'CommandOrControl+Alt+Down',
  recenterShortcut: 'CommandOrControl+Alt+0',       // overlay back to the top of the screen, centred; global only while the overlay shows
  scrollUpShortcut: 'Alt+Up',            // scroll the overlay from any app, like Alt + scroll; global only while the overlay shows
  scrollDownShortcut: 'Alt+Down',
  homeShortcut: 'CommandOrControl+Alt+Home',  // overlay: back to the start / to the end (global only while it shows)
  endShortcut: 'CommandOrControl+Alt+End',
  biggerShortcut: 'CommandOrControl+Alt+=',   // overlay text size (global only while it shows)
  smallerShortcut: 'CommandOrControl+Alt+-',
  keys: {},                              // in-app shortcuts changed in Settings: { command: [accelerators] }
  immersiveHeadings: 'flat',             // flat (same size as text) | original
  anywhereScroll: 'alt',                 // modifier for scrolling immersive from any app: alt | ctrl+alt | shift+alt | ctrl+shift | off
  headingScroll: 'ctrl+alt',             // modifier + scroll = previous / next heading (overlay: from any app): same choices
  docsFolder: path.join(app.getPath('documents'), 'Interview Notes'),
  immersiveMargins: 'narrow',            // none | narrow | normal | wide
  editorMargins: 'normal',               // narrow | normal | wide
  overlayOpacity: 1,                     // whole overlay (text + background)
  backgroundOpacity: 0.94,               // background only
  linesPerView: 25,                      // 1–25 (25 = default)
  customLines: 3,                        // the "Custom" choice for lines per view
  scrollLines: 0,                        // lines per scroll step when 3+ shown: 0 = auto (3), -1 = a whole view
  immersiveZoom: 1,                      // text scale in immersive mode
  editorPage: 'paper',                   // page colour in dark mode: paper (white) | gray | black
  alwaysOnTop: true,                     // immersive overlay only — the editor is a normal window
  minimizeToTray: false,                 // minimizing hides to the tray (hidden icons) instead of the taskbar
  launchAtStartup: false,
  defaultFont: 'Arial',
  defaultFontSize: 10,
  defaultLineSpacing: 1.15,
  mode: 'editor',
  editorBounds: null,
  immersiveBounds: null,
  lastDoc: null,
  sidebarOpen: false,
  readPositions: {},
  lastAutoUpdate: null,                  // version last auto-installed at launch (stops a retry loop if it fails)
  lastRunVersion: null                   // to say "Updated to …" after an update
};

let settings = loadSettings();
let win = null;
let tray = null;
let quitting = false;
let shortcutErrors = {};
let fullBounds = null;                   // editor bounds to restore when leaving full screen
let updater = null;
let updateStatus = { state: app.isPackaged ? 'idle' : 'dev' };

function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    if (s.editorPage === 'match') s.editorPage = 'gray'; // 1.0 "Dark page"
    // 1.3: default text went from 8 pt to 10 pt. The settings file stores every value, so move
    // the old default once; a size someone actually picked (anything but 8) is left alone.
    if (!s.defaultSize10) { if (s.defaultFontSize === 8) s.defaultFontSize = 10; s.defaultSize10 = true; }
    if (s.defaultFontSize > 10) s.defaultFontSize = 10;   // 1.8: no text bigger than 10 pt
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
// "Updated to 2.0.0" is shown once after an update.
const updatedFrom = settings.lastRunVersion && settings.lastRunVersion !== app.getVersion() ? settings.lastRunVersion : null;
if (settings.lastRunVersion !== app.getVersion()) { settings.lastRunVersion = app.getVersion(); saveSettingsNow(); }

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
  const s = mode === 'immersive' ? settings.immersiveBounds : settings.editorBounds;
  const b = onScreen(s) ? s : defaultBounds(mode);
  return TEST_HIDDEN ? { ...b, x: b.x + TEST_OFFSET } : b;
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
    alwaysOnTop: false,                  // set by applyAlwaysOnTop()
    skipTaskbar: settings.mode === 'immersive',   // the overlay stays out of the taskbar (tray icon still has it)
    title: 'Interview Notes',
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
  win.once('ready-to-show', () => {
    if (!TEST_HIDDEN) return win.show();
    // painted (so screenshots work) but parked far off-screen, out of the taskbar
    win.setSkipTaskbar(true); win.setAlwaysOnTop(false);
    win.setPosition(TEST_OFFSET, 0); win.showInactive();
  });

  // Alt+F4 (or "Close window" on the taskbar) quits the app completely. The page saves first,
  // then asks to quit; the timer is a fallback if it doesn't answer. Ctrl+] still just hides.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.webContents.send('cmd', 'quit');
    setTimeout(() => { quitting = true; app.quit(); }, 1500);
  });
  const remember = () => {
    if (!win || win.isDestroyed() || win.isMinimized() || fullBounds) return;
    const key = settings.mode === 'immersive' ? 'immersiveBounds' : 'editorBounds';
    settings[key] = win.getBounds();
    saveSettings();
  };
  // "Minimize to tray": a minimized window is hidden, so it's only in the tray's hidden icons.
  win.on('minimize', () => { if (settings.minimizeToTray && !TEST_HIDDEN) { hideToast(); win.hide(); } });
  win.on('moved', remember);
  win.on('resized', remember);
  win.on('resize', () => placeToast());
  win.on('move', () => placeToast());

  // Block navigation away from the app (e.g. dropped links)
  win.webContents.on('will-navigate', (e, url) => { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });

  setupContextMenu();
}

// "Always on top" is for the immersive overlay only: the editor (full screen included) is a normal window.
function applyAlwaysOnTop() {
  if (!win || win.isDestroyed()) return;
  if (settings.alwaysOnTop && settings.mode === 'immersive' && !TEST_HIDDEN) win.setAlwaysOnTop(true, 'screen-saver');
  else win.setAlwaysOnTop(false);
}

// Immersive mode keeps the app off the taskbar; the editor has a normal taskbar button.
function applyTaskbar() {
  if (win && !win.isDestroyed()) win.setSkipTaskbar(TEST_HIDDEN || settings.mode === 'immersive');
}

function toggleVisible() {
  if (!win) return;
  if (win.isVisible() && !win.isMinimized()) {
    hideToast();
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

// "Full screen" maximizes the window: it fills the screen's work area, so the taskbar stays visible.
// Done by hand (the window is frameless + transparent, so native maximize isn't reliable), and the
// old bounds go back afterwards.
function setFullscreen(on) {
  if (!win || win.isDestroyed()) return;
  on = !!on && settings.mode === 'editor';
  if (on === !!fullBounds) return;
  if (on) {
    fullBounds = win.getBounds();
    const d = TEST_HIDDEN ? screen.getPrimaryDisplay().workArea : screen.getDisplayMatching(fullBounds).workArea;
    win.setBounds({ ...d, x: d.x + TEST_OFFSET });
    if (!win.isVisible() && !TEST_HIDDEN) win.show();
    win.focus();
  } else {
    const b = fullBounds;
    fullBounds = null;
    win.setBounds(b);
  }
  win.webContents.send('fullscreen', on);
}

// Put the overlay back at the very top of its screen, centred, keeping its width.
function recenterOverlay() {
  if (!win || win.isDestroyed() || settings.mode !== 'immersive') return;
  const b = win.getBounds();
  const real = { ...b, x: b.x - TEST_OFFSET };
  const wa = (onScreen(real) ? screen.getDisplayMatching(real) : screen.getPrimaryDisplay()).workArea;
  const width = Math.min(b.width, wa.width);
  win.setBounds({ x: wa.x + Math.round((wa.width - width) / 2) + TEST_OFFSET, y: wa.y, width, height: b.height });
  settings.immersiveBounds = win.getBounds();
  saveSettings();
  if (!win.isVisible() && !TEST_HIDDEN) win.showInactive();
}

// Messages shown while the overlay is up ("Showing 2 lines at a time", …). The overlay window is
// only as tall as its text, so a popup inside it gets cut off — these go in their own small,
// click-through window just below the overlay (above it if there's no room below).
const TOAST_W = 520, TOAST_H = 52;
let toastWin = null, toastReady = null, toastTimer = null;
const TOAST_HTML = `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:transparent;overflow:hidden}
  body{display:flex;align-items:center;justify-content:center;font:12.5px 'Segoe UI',system-ui,sans-serif}
  #t{background:#323232;color:#fff;padding:9px 16px;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.35);
     max-width:${TOAST_W - 24}px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
</style><div id="t"></div>`;
function ensureToastWin() {
  if (toastWin && !toastWin.isDestroyed()) return;
  toastWin = new BrowserWindow({
    parent: win, width: TOAST_W, height: TOAST_H, show: false, frame: false, transparent: true, resizable: false,
    movable: false, minimizable: false, maximizable: false, focusable: false, skipTaskbar: true,
    hasShadow: false, alwaysOnTop: true, webPreferences: { contextIsolation: true, sandbox: true }
  });
  toastWin.setIgnoreMouseEvents(true);
  toastWin.setAlwaysOnTop(true, 'screen-saver');
  toastReady = toastWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(TOAST_HTML)).catch(() => {});
  toastWin.on('closed', () => { toastWin = null; });
}
async function showToast(msg, ms = 2600) {
  if (!win || win.isDestroyed()) return;
  ensureToastWin();
  await toastReady;
  if (!toastWin || toastWin.isDestroyed()) return;
  await toastWin.webContents.executeJavaScript(`document.getElementById('t').textContent = ${JSON.stringify(String(msg))}`).catch(() => {});
  placeToast(true);
  toastWin.showInactive();
  toastWin.moveTop();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}
// The overlay often resizes right after a message (e.g. 1 line → 25 lines): keep the message beside it.
function placeToast(force) {
  if (!toastWin || toastWin.isDestroyed() || !(force || toastWin.isVisible()) || !win || win.isDestroyed()) return;
  const b = win.getBounds();
  const real = { ...b, x: b.x - TEST_OFFSET };
  const wa = (onScreen(real) ? screen.getDisplayMatching(real) : screen.getPrimaryDisplay()).workArea;
  const x = Math.round(Math.min(Math.max(real.x + (real.width - TOAST_W) / 2, wa.x), wa.x + wa.width - TOAST_W));
  let y = real.y + real.height + 4;                                                  // below the overlay
  if (y + TOAST_H > wa.y + wa.height) y = real.y - TOAST_H - 4;                      // no room: above it
  if (y < wa.y) y = Math.min(real.y + real.height, wa.y + wa.height) - TOAST_H - 8;  // overlay fills the screen: inside its bottom edge
  toastWin.setBounds({ x: x + TEST_OFFSET, y: Math.round(y), width: TOAST_W, height: TOAST_H });
}
function hideToast() {
  clearTimeout(toastTimer);
  if (toastWin && !toastWin.isDestroyed()) toastWin.hide();
}

function setMode(mode) {
  if (!win || (mode !== 'editor' && mode !== 'immersive')) return;
  if (fullBounds) setFullscreen(false);
  hideToast();
  const prev = settings.mode;
  if (prev === mode) { win.webContents.send('mode', mode); return; }
  settings[prev === 'immersive' ? 'immersiveBounds' : 'editorBounds'] = win.getBounds();
  settings.mode = mode;
  win.setBounds(boundsFor(mode));
  saveSettings();
  win.webContents.send('mode', mode);
  applyTaskbar();
  applyAlwaysOnTop();
  refreshTrayMenu();
  updateWheelHook();
  if (SHORTCUTS_ON) setTimeout(() => setOverlayShortcuts(settings.mode === 'immersive'), 0);
  if (!win.isVisible()) { mode === 'immersive' ? win.showInactive() : win.show(); }
}

/* ---------------- shortcuts ---------------- */
const pretty = (a) => String(a).replace(/CommandOrControl|CmdOrCtrl/g, 'Ctrl').split('+').join(' + ');
const SHORTCUT_KEYS = ['toggleShortcut', 'immersiveShortcut', 'linesShortcut', 'opacityShortcut', 'headingPrevShortcut', 'headingNextShortcut', 'recenterShortcut', 'scrollUpShortcut', 'scrollDownShortcut', 'homeShortcut', 'endShortcut', 'biggerShortcut', 'smallerShortcut'];
// Shortcut handlers never run inside the hotkey callback itself: changing hotkey registrations
// from within one (as a mode switch used to) froze the app when the keys were held, and
// Windows repeats a held hotkey — so toggles act once per press (key repeat is ignored).
const lastFired = {};
function hotkey(key, fn, { repeat = false } = {}) {
  return () => {
    const now = Date.now(), prev = lastFired[key] || 0;
    lastFired[key] = now;
    if (!repeat && now - prev < 120) return; // a held key repeats every ~33 ms; quick presses are slower
    setImmediate(fn);
  };
}
function regShortcut(key, accel, fn, opts) {
  if (!accel) return;
  try {
    const ok = globalShortcut.register(accel, hotkey(key, fn, opts));
    if (!ok) shortcutErrors[key] = `${pretty(accel)} is already used by another app`;
  } catch (e) { shortcutErrors[key] = `${pretty(accel)} is not a valid shortcut`; }
}
const cmd = (c) => () => { if (win && !win.isDestroyed()) win.webContents.send('cmd', c); };
function registerShortcuts() {
  globalShortcut.unregisterAll();
  shortcutErrors = {};
  overlayKeysOn = false;
  regShortcut('toggleShortcut', settings.toggleShortcut, toggleVisible);
  regShortcut('immersiveShortcut', settings.immersiveShortcut, () => {
    if (!win) return;
    if (!win.isVisible()) { win.showInactive(); }
    setMode(settings.mode === 'immersive' ? 'editor' : 'immersive');
  });
  regShortcut('linesShortcut', settings.linesShortcut, cmd('cycleLines'));
  regShortcut('opacityShortcut', settings.opacityShortcut, cmd('cycleOpacity'));
  setOverlayShortcuts(settings.mode === 'immersive', false);
  sendShortcutErrors();
}
// Ctrl+Alt+Up/Down/0 mean something in lots of apps (and Ctrl+Alt+0 is "Normal text" in the
// editor), so they're only taken over while the overlay is in use. Only these keys are
// (un)registered on a mode switch — the rest stay put.
const OVERLAY_KEYS = ['headingPrevShortcut', 'headingNextShortcut', 'recenterShortcut', 'scrollUpShortcut', 'scrollDownShortcut',
  'homeShortcut', 'endShortcut', 'biggerShortcut', 'smallerShortcut'];
let overlayKeysOn = false;
function setOverlayShortcuts(on, notify = true) {
  if (on === overlayKeysOn) return;
  overlayKeysOn = on;
  if (on) {
    regShortcut('headingPrevShortcut', settings.headingPrevShortcut, cmd('heading:prev'), { repeat: true });
    regShortcut('headingNextShortcut', settings.headingNextShortcut, cmd('heading:next'), { repeat: true });
    regShortcut('recenterShortcut', settings.recenterShortcut, recenterOverlay);
    // Alt + ↑ / ↓: the overlay scrolls a step, same as Alt + scroll (held down, it keeps going)
    regShortcut('scrollUpShortcut', settings.scrollUpShortcut, overlayScroll(settings.scrollUpShortcut, -1), { repeat: true });
    regShortcut('scrollDownShortcut', settings.scrollDownShortcut, overlayScroll(settings.scrollDownShortcut, 1), { repeat: true });
    regShortcut('homeShortcut', settings.homeShortcut, overlayCmd(settings.homeShortcut, 'imm:home'));
    regShortcut('endShortcut', settings.endShortcut, overlayCmd(settings.endShortcut, 'imm:end'));
    regShortcut('biggerShortcut', settings.biggerShortcut, overlayCmd(settings.biggerShortcut, 'imm:bigger'), { repeat: true });
    regShortcut('smallerShortcut', settings.smallerShortcut, overlayCmd(settings.smallerShortcut, 'imm:smaller'), { repeat: true });
  } else {
    for (const k of OVERLAY_KEYS) {
      try { if (settings[k] && globalShortcut.isRegistered(settings[k])) globalShortcut.unregister(settings[k]); } catch {}
      delete shortcutErrors[k];
    }
  }
  if (notify) sendShortcutErrors();
}
function overlayScroll(accel, dir) {
  return () => {
    if (!win || win.isDestroyed() || settings.mode !== 'immersive') return;
    if (/(^|\+)Alt(\+|$)/.test(accel || '')) maskAlt();
    win.webContents.send('imm-scroll', dir, 1);
  };
}
function overlayCmd(accel, c) {
  return () => {
    if (!win || win.isDestroyed() || settings.mode !== 'immersive') return;
    if (/(^|\+)Alt(\+|$)/.test(accel || '')) maskAlt();
    win.webContents.send('cmd', c);
  };
}
// Releasing Alt after a shortcut the other app never saw makes it open its menu bar (Explorer,
// Office, …); a harmless F24 tap in between stops that. Once per Alt press is enough.
let lastAltMask = 0;
function maskAlt() {
  const now = Date.now();
  if (now - lastAltMask < 400 || TEST_HIDDEN) { lastAltMask = now; return; }
  lastAltMask = now;
  try {
    const h = hook || require('uiohook-napi');
    h.uIOhook.keyTap(h.UiohookKey.F24);
  } catch {}
}
function sendShortcutErrors() {
  if (win && !win.isDestroyed()) win.webContents.send('shortcut-errors', shortcutErrors);
}

/* ---------------- scroll from anywhere (immersive) ---------------- */
// Holding a modifier (Alt by default) while scrolling over any app moves the immersive view;
// another (Ctrl + Alt by default) jumps between headings.
// Electron can't see wheel events outside its windows, so this uses a system-wide input hook
// (uiohook-napi). It starts the first time the overlay is used and then stays running (events
// are ignored outside immersive mode) — stopping and restarting it on every mode switch was
// needless churn in a native module. It's only stopped if the feature is turned off.
const WHEEL_MODS = { alt: ['alt'], 'ctrl+alt': ['ctrl', 'alt'], 'shift+alt': ['shift', 'alt'], 'ctrl+shift': ['ctrl', 'shift'] };
let hook = null, hookOn = false, altMasked = false;
function updateWheelHook() {
  const enabled = (!TEST_HIDDEN || process.env.LN_TEST_HOOK === '1') &&
    !!(WHEEL_MODS[settings.anywhereScroll] || WHEEL_MODS[settings.headingScroll]);
  const want = enabled && (hookOn || settings.mode === 'immersive');
  if (want === hookOn) return;
  try {
    if (!hook) {
      hook = require('uiohook-napi');
      hook.uIOhook.on('wheel', onGlobalWheel);
      hook.uIOhook.on('keyup', (e) => {
        if (e.keycode === hook.UiohookKey.Alt || e.keycode === hook.UiohookKey.AltRight) altMasked = false;
      });
    }
    if (want) hook.uIOhook.start(); else hook.uIOhook.stop();
    hookOn = want;
  } catch (e) { console.error('scroll hook unavailable', e); }
}
function stopWheelHook() {
  if (hook && hookOn) { try { hook.uIOhook.stop(); } catch {} hookOn = false; }
}
function onGlobalWheel(e) {
  if (!win || win.isDestroyed() || !win.isVisible() || settings.mode !== 'immersive') return;
  if (e.direction !== hook.WheelDirection.VERTICAL || !e.rotation) return;
  const held = { alt: e.altKey, ctrl: e.ctrlKey, shift: e.shiftKey };
  const matches = (mods) => !!mods && ['alt', 'ctrl', 'shift'].every(m => held[m] === mods.includes(m));
  const headMods = WHEEL_MODS[settings.headingScroll];   // checked first: it wins if both use the same keys
  const mods = matches(headMods) ? headMods : matches(WHEEL_MODS[settings.anywhereScroll]) ? WHEEL_MODS[settings.anywhereScroll] : null;
  if (!mods) return;
  // Over the overlay itself the page's own wheel handling already does this.
  const p = screen.getCursorScreenPoint(), b = win.getBounds();
  if (p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height) return;
  // Releasing Alt on its own would open the focused app's menu bar; a harmless F24 tap cancels that.
  if (mods.includes('alt') && !altMasked) { altMasked = true; try { hook.uIOhook.keyTap(hook.UiohookKey.F24); } catch {} }
  const dir = e.rotation > 0 ? 1 : -1;                   // rotation > 0 = towards you
  if (mods === headMods) {
    const now = Date.now();                              // one heading per notch, even from a touchpad
    if (now - lastHeadingWheel < 120) return;
    lastHeadingWheel = now;
    win.webContents.send('cmd', dir > 0 ? 'heading:next' : 'heading:prev');
  } else win.webContents.send('imm-scroll', dir, Math.abs(e.rotation));
}
let lastHeadingWheel = 0;

/* ---------------- tray ---------------- */
function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'tray.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip('Interview Notes');
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
    { label: 'Quit Interview Notes', click: () => { quitting = true; app.quit(); } }
  ]));
}

/* ---------------- updates ---------------- */
// Releases are published to GitHub (see "publish" in package.json and scripts/release.js).
// The app checks at launch and every few hours and downloads new versions in the background, but
// never installs one without asking: each time the app is opened (launched, or opened again from
// the Start menu / desktop while it's running in the tray) and a newer version is there, a dialog
// asks whether to update now. "Not now" leaves the current version in place until the next time.
// Switching between the editor and the overlay doesn't count as opening the app.
let askOnOpen = true;          // the app was just opened: ask about an update this time
let asking = false;
let userWantsUpdate = false;   // said yes while the download was still going
let updateNotes = '';
function sendUpdate(status) {
  const changed = status.state !== updateStatus.state || status.version !== updateStatus.version;
  updateStatus = status;
  if (win && !win.isDestroyed()) win.webContents.send('update-status', status);
  if (changed) refreshTrayMenu(); // not on every download-progress tick
}
// Turn electron-updater's raw errors into something readable.
function shortErr(e) {
  const m = String((e && e.message) || e);
  if (/latest\.yml|404|Cannot find/i.test(m)) return 'the newest version is still being published';
  if (/ERR_INTERNET_DISCONNECTED|ENOTFOUND|ERR_NAME_NOT_RESOLVED|ETIMEDOUT|ECONNRESET|ERR_NETWORK/i.test(m)) return "you're offline or GitHub can't be reached";
  return m.split('\n')[0].slice(0, 140);
}
// A failed check tries again after 2 minutes (up to 5 times) instead of waiting for the 4-hour check.
let retryTimer = null, retries = 0;
function updateFailed(e) {
  if (userWantsUpdate) { // the download they asked for failed: bring the app back and say so
    userWantsUpdate = false;
    closeUpdateScreen();
    showWindow();
    if (!TEST_HIDDEN) dialog.showMessageBox(win, { type: 'warning', title: 'Update failed', message: "The update couldn't be downloaded.", detail: shortErr(e) + '\n\nYou can try again from Settings → Updates.' }).catch(() => {});
  }
  askOnOpen = false;
  if (updateStatus.state === 'ready') return;
  const retrying = retries < 5;
  sendUpdate({ state: 'error', message: shortErr(e) + (retrying ? ' — trying again in 2 minutes' : '') });
  if (retrying && !retryTimer) retryTimer = setTimeout(() => { retryTimer = null; retries++; checkForUpdates(); }, 2 * 60 * 1000);
}
// Dev-only: LN_TEST_FAKE_UPDATE=<version> pretends that version is on GitHub (with LN_TEST_HIDDEN).
function fakeUpdater(version) {
  const u = new (require('events'))();
  u.checkForUpdates = async () => {
    u.emit('checking-for-update');
    setTimeout(() => {
      u.emit('update-available', { version, releaseNotes: '<ul><li>Test change one</li><li>Test change two</li></ul>' });
      let pct = 0;
      const t = setInterval(() => {
        pct += 25;
        u.emit('download-progress', { percent: pct });
        if (pct >= 100) { clearInterval(t); u.emit('update-downloaded', { version }); }
      }, 300);
    }, 200);
  };
  u.quitAndInstall = () => { testLog('quitAndInstall ' + version); app.exit(0); };
  return u;
}
function testLog(msg) {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'test-updates.log'), msg + '\n'); } catch {}
}
function setupUpdater() {
  const fake = TEST_HIDDEN && process.env.LN_TEST_FAKE_UPDATE;
  if (fake) updater = fakeUpdater(fake);
  else {
    if (!app.isPackaged) return;
    try { updater = require('electron-updater').autoUpdater; } catch (e) { console.error('updater unavailable', e); return; }
  }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = false; // only ever installed after the user says yes
  updater.on('checking-for-update', () => sendUpdate({ state: 'checking' }));
  updater.on('update-not-available', () => { retries = 0; askOnOpen = false; sendUpdate({ state: 'none' }); });
  updater.on('update-available', (i) => {
    sendUpdate({ state: 'downloading', version: i.version, percent: 0 });
    askAboutUpdate(i);
  });
  updater.on('download-progress', (p) => {
    sendUpdate({ state: 'downloading', version: updateStatus.version, percent: p.percent });
    setUpdateScreen('downloading', p.percent);
  });
  updater.on('update-downloaded', (i) => {
    sendUpdate({ state: 'ready', version: i.version });
    if (userWantsUpdate) requestInstall();
    else askAboutUpdate(i);
  });
  updater.on('error', updateFailed);
  setTimeout(checkForUpdates, 3000);
  setInterval(checkForUpdates, 4 * 60 * 60 * 1000);
}
async function checkForUpdates() {
  if (!updater) return updateStatus;
  if (['checking', 'downloading', 'ready', 'installing'].includes(updateStatus.state)) return updateStatus;
  try { await updater.checkForUpdates(); } catch (e) { updateFailed(e); }
  return updateStatus;
}
// The app was opened again while already running (Start menu, desktop, taskbar pin).
function appOpenedAgain() {
  askOnOpen = true;
  if (['downloading', 'ready'].includes(updateStatus.state)) askAboutUpdate({ version: updateStatus.version });
  else if (updateStatus.state !== 'checking') checkForUpdates();
}
const plainNotes = (html) => String(html || '')
  .replace(/<li[^>]*>/gi, '• ').replace(/<\/(p|li|h\d)>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\*\*/g, '').replace(/\n{3,}/g, '\n\n').trim();
async function askAboutUpdate(info) {
  if (info && info.releaseNotes) updateNotes = Array.isArray(info.releaseNotes) ? info.releaseNotes.map(n => n.note).join('\n') : info.releaseNotes;
  if (!askOnOpen || asking || userWantsUpdate || !updater) return;
  askOnOpen = false;
  asking = true;
  const v = (info && info.version) || updateStatus.version;
  let notes = plainNotes(updateNotes).split('\n').filter(l => !/^Interview Notes \d|Download:|Already installed\?/.test(l)).join('\n').trim();
  if (notes.length > 700) notes = notes.slice(0, 700) + '…';
  const opts = {
    type: 'info', title: 'Update available', noLink: true, defaultId: 0, cancelId: 1,
    buttons: ['Update now', 'Not now'],
    message: `Interview Notes ${v} is available`,
    detail: `You have version ${app.getVersion()}.` + (notes ? `\n\nWhat's new:\n${notes}` : '') +
      "\n\nUpdating closes the app for a few seconds and reopens it. Your notes are saved first. " +
      "If you choose Not now, you'll be asked again the next time you open the app."
  };
  let response = 1;
  try {
    if (TEST_HIDDEN) { response = +(process.env.LN_TEST_UPDATE_ANSWER || 1); testLog('asked ' + v + ' -> ' + (response === 0 ? 'update' : 'not now')); }
    else {
      const parent = win && !win.isDestroyed() && win.isVisible() && settings.mode === 'editor' ? win : undefined;
      response = (await (parent ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts))).response;
    }
  } finally { asking = false; }
  if (response !== 0) return; // not now: nothing is installed
  userWantsUpdate = true;
  if (updateStatus.state === 'ready') requestInstall();
  else { // still downloading: show the progress, install when it's done
    showUpdateScreen(v);
    setUpdateScreen('downloading', updateStatus.percent);
    hideToast();
    if (win && !win.isDestroyed()) win.hide();
  }
}
// Let the page save the open document, then install. (Fallback if it doesn't answer.)
function requestInstall() {
  if (win && !win.isDestroyed()) win.webContents.send('cmd', 'installUpdate');
  setTimeout(installUpdate, 4000);
}
// Installing closes the app for a few seconds, so say so first: the app window goes away and a
// small "Updating Interview Notes" screen explains that it will reopen by itself. Then the
// installer's own progress window takes over until the new version opens.
function installUpdate() {
  if (!updater || updateStatus.state !== 'ready') return;
  settings.lastAutoUpdate = updateStatus.version;
  saveSettingsNow();
  updateStatus = { ...updateStatus, state: 'installing' };
  quitting = true;
  if (!updateWin || updateWin.isDestroyed()) showUpdateScreen(updateStatus.version);
  setUpdateScreen('installing');
  hideToast();
  if (win && !win.isDestroyed()) win.hide();
  testLog('installing ' + updateStatus.version);
  setTimeout(() => updater.quitAndInstall(false, true), 2500); // installer with its progress bar, then reopen the app
}
let updateWin = null;
function showUpdateScreen(version) {
  if (TEST_HIDDEN && process.env.LN_TEST_UPDATE_SCREEN !== '1') return;
  const dark = nativeTheme.shouldUseDarkColors;
  const c = dark ? { bg: '#1f1f1f', text: '#e3e3e3', muted: '#9aa0a6', track: '#3c4043', bar: '#a8c7fa' }
    : { bg: '#ffffff', text: '#1f1f1f', muted: '#5f6368', track: '#e3e8ef', bar: '#0b57d0' };
  const html = `<!doctype html><meta charset="utf-8"><title>Updating Interview Notes</title><style>
    html,body{margin:0;height:100%;background:${c.bg};color:${c.text};font:13px/1.45 'Segoe UI Variable Text','Segoe UI',sans-serif;overflow:hidden;user-select:none}
    body{display:flex;flex-direction:column;justify-content:center;padding:0 30px;box-sizing:border-box;border:1px solid ${c.track}}
    h1{font-size:17px;font-weight:600;margin:0 0 6px}p{margin:0;color:${c.muted}}
    .track{height:4px;border-radius:2px;background:${c.track};overflow:hidden;margin:18px 0 12px}
    .bar{height:100%;width:35%;border-radius:2px;background:${c.bar};animation:m 1.3s ease-in-out infinite}
    @keyframes m{0%{transform:translateX(-100%)}100%{transform:translateX(290%)}}
  </style><h1>Updating Interview Notes</h1>
  <p id="msg">Installing version ${String(version).replace(/[<&]/g, '')}. The app will close and reopen by itself in a few seconds &mdash; you don&rsquo;t need to do anything.</p>
  <div class="track"><div class="bar"></div></div><p>Your notes are saved.</p>`;
  updateVersion = String(version).replace(/[<&]/g, '');
  updateWin = new BrowserWindow({
    width: 440, height: 200, show: false, frame: false, resizable: false, movable: true, minimizable: false,
    maximizable: false, alwaysOnTop: true, skipTaskbar: false, center: true, title: 'Updating Interview Notes',
    backgroundColor: c.bg, icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true }
  });
  updateWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(() => {});
  updateWinReady = new Promise(res => updateWin.once('ready-to-show', () => {
    if (updateWin && !updateWin.isDestroyed()) updateWin.show();
    res();
  }));
}
let updateWinReady = null, updateVersion = '';
async function setUpdateScreen(phase, percent) {
  if (!updateWin || updateWin.isDestroyed()) return;
  await updateWinReady;
  if (!updateWin || updateWin.isDestroyed()) return;
  const text = phase === 'downloading'
    ? `Downloading version ${updateVersion}${percent != null ? ' — ' + Math.round(percent) + '%' : '…'}. Interview Notes will then close and reopen by itself.`
    : `Installing version ${updateVersion}. The app will close and reopen by itself in a few seconds \u2014 you don\u2019t need to do anything.`;
  updateWin.webContents.executeJavaScript(`document.getElementById('msg').textContent = ${JSON.stringify(text)}`).catch(() => {});
}
function closeUpdateScreen() {
  if (updateWin && !updateWin.isDestroyed()) updateWin.destroy();
  updateWin = null;
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
      t.push({ label: 'Lines per view', submenu: [...new Set([1, 2, settings.customLines || 3, 25])].sort((a, b) => a - b).map(n => ({ label: n === 25 ? 'Default (25 max)' : `${n} line${n > 1 ? 's' : ''}`, type: 'radio', checked: settings.linesPerView === n, click: () => win.webContents.send('set-setting', { linesPerView: n }) })) });
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
    `<meta name="generator" content="Interview Notes"></head>\n<body>\n${body}\n</body></html>\n`;
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
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
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

const WELCOME = `<h1>Welcome to Interview Notes</h1>
<p>This is a normal document — type, paste from Google Docs or Word, add images and tables. Pages show like Google Docs; type @ for page breaks, tables and more.</p>
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

  handle('settings:get', () => ({ ...settings, shortcutErrors, platform: process.platform, version: app.getVersion(), updatedFrom }));
  handle('settings:set', async (patch) => {
    const old = { ...settings };
    Object.assign(settings, patch);
    if ('theme' in patch) nativeTheme.themeSource = settings.theme;
    if ('alwaysOnTop' in patch) applyAlwaysOnTop();
    if ('launchAtStartup' in patch && app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!settings.launchAtStartup });
    if (SHORTCUT_KEYS.some(k => patch[k] !== undefined)) { registerShortcuts(); refreshTrayMenu(); }
    if ('anywhereScroll' in patch || 'headingScroll' in patch) updateWheelHook();
    if ('docsFolder' in patch && patch.docsFolder !== old.docsFolder) { previewCache.clear(); await ensureRoot(); }
    if ('mode' in patch) refreshTrayMenu();
    saveSettings();
    return { ...settings, shortcutErrors };
  });
  handle('shortcuts:pause', (paused) => { if (!SHORTCUTS_ON) return; if (paused) globalShortcut.unregisterAll(); else registerShortcuts(); });

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
  handle('win:minimize', () => { if (settings.minimizeToTray && !TEST_HIDDEN) { hideToast(); win.hide(); } else win.minimize(); });
  handle('win:quit', () => { quitting = true; app.quit(); });
  handle('win:setMode', (m) => { setMode(m); refreshTrayMenu(); });
  handle('win:fullscreen', (on) => setFullscreen(on));
  handle('win:recenter', () => recenterOverlay());
  handle('toast:show', (msg, ms) => { showToast(msg, ms); });

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
      // Word's own heading styles are 13–26 pt; keep them at 10 pt like the app (bold instead).
      const docBody = body.replace(/<(h[1-6])((?:\s[^>]*)?)>/gi, (m, tag, attrs) => /style=/i.test(attrs)
        ? `<${tag}${attrs.replace(/style=(["'])/i, 'style=$1font-size:10pt;font-weight:bold;')}>`
        : `<${tag}${attrs} style="font-size:10pt;font-weight:bold">`);
      const buf = await HTMLtoDOCX(wrapHtml(title, docBody), null, { font: settings.defaultFont, fontSize: settings.defaultFontSize * 2, table: { row: { cantSplit: true } } });
      await fsp.writeFile(r.filePath, buf);
    } else {
      const pdf = await renderOffscreen(title, body, pageCss, (wc) => wc.printToPDF({ pageSize: 'Letter', printBackground: true, margins: { marginType: 'none' } }));
      await fsp.writeFile(r.filePath, pdf);
    }
    shell.showItemInFolder(r.filePath);
    return r.filePath;
  });
  handle('print', (title, body, pageCss) => printDoc(title, body, pageCss));

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

// Printing needs a window that's really on screen: from a hidden one Windows never shows the print
// dialog (that's why Print used to do nothing). So the document opens in a print preview window,
// the Windows print dialog appears over it, and the preview closes when you print or cancel.
let printWin = null;
async function printDoc(title, body, pageCss) {
  if (printWin && !printWin.isDestroyed()) { printWin.focus(); return { ok: false, why: 'busy' }; }
  const tmp = path.join(app.getPath('temp'), `interview-notes-print-${Date.now()}.html`);
  const preview = '@media screen{html{background:#e8eaed}body{background:#fff;width:8.5in;box-sizing:border-box;' +
    'padding:1in;margin:16px auto;box-shadow:0 1px 3px rgba(0,0,0,.25)}}';
  await fsp.writeFile(tmp, wrapHtml(title, `<style>${pageCss}${preview}</style>` + body));
  if (TEST_HIDDEN) { testLog('print ' + title); fsp.unlink(tmp).catch(() => {}); return { ok: true, test: true }; }
  const wa = screen.getDisplayMatching(win.getBounds()).workArea;
  printWin = new BrowserWindow({
    width: Math.min(900, wa.width - 40), height: Math.min(1000, wa.height - 40), show: false, center: true,
    title: `Print — ${title}`, icon: path.join(__dirname, 'build', 'icon.png'), backgroundColor: '#e8eaed',
    autoHideMenuBar: true, webPreferences: { javascript: false }
  });
  printWin.setMenu(null);
  try {
    await printWin.loadURL(pathToFileURL(tmp).href);
    printWin.show();
    printWin.focus();
    return await new Promise((res) => printWin.webContents.print({}, (ok, why) => res({ ok, why: why || '' })));
  } finally {
    if (printWin && !printWin.isDestroyed()) printWin.destroy();
    printWin = null;
    fsp.unlink(tmp).catch(() => {});
  }
}

async function renderOffscreen(title, body, pageCss, fn) {
  const w = new BrowserWindow({ show: false, webPreferences: { javascript: false } });
  try {
    const html = wrapHtml(title, `<style>${pageCss}</style>` + body);
    const tmp = path.join(app.getPath('temp'), `interview-notes-print-${Date.now()}.html`);
    await fsp.writeFile(tmp, html);
    await w.loadURL(pathToFileURL(tmp).href);
    const out = await fn(w.webContents);
    fsp.unlink(tmp).catch(() => {});
    return out;
  } finally { setTimeout(() => { if (!w.isDestroyed()) w.destroy(); }, 500); }
}

/* ---------------- lifecycle ---------------- */
app.on('second-instance', () => { showWindow(); appOpenedAgain(); });
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  nativeTheme.themeSource = settings.theme;
  nativeTheme.on('updated', () => win && win.webContents.send('theme-changed'));
  try { await ensureRoot(); } catch (e) { console.error(e); }
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!settings.launchAtStartup });
  setupIpc();
  createWindow();
  if (!TEST_HIDDEN) createTray();
  if (SHORTCUTS_ON) registerShortcuts();
  setupUpdater();
  updateWheelHook();
});
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { globalShortcut.unregisterAll(); stopWheelHook(); });
// The window only ever goes away when quitting (closing it quits too) — never leave a windowless process behind.
app.on('window-all-closed', () => { quitting = true; app.quit(); });
