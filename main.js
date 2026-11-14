'use strict';

/**
 * DeepSeek Desktop — a thin Electron shell around the official web app.
 *
 * What this file deliberately does NOT do:
 *  - it never talks to api.deepseek.com, and needs no API key;
 *  - it never injects scripts or rewrites the page, so the UI stays official;
 *  - it never intercepts the page's own network traffic.
 *
 * What it does:
 *  - loads https://chat.deepseek.com/ in a persistent partition so login survives restarts;
 *  - parks itself in the tray when the window is closed;
 *  - sends off-site links to the system browser.
 */

const { app, BrowserWindow, Tray, Menu, shell, session, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const OFFICIAL_URL = 'https://chat.deepseek.com/';
const PARTITION = 'persist:deepseek';

// This app needs its own profile directory, set before anything touches
// getPath('userData'). Electron's default is %APPDATA%\Electron, a folder every
// unpackaged Electron app on the machine shares; if another Electron process is
// already using it, this process dies during start-up. A private folder also
// keeps this app's cookies away from anything else on the machine.
// `--profile=<dir>` overrides it, which is handy for side-by-side test runs.
const PROFILE_FLAG = process.argv.find((a) => a.startsWith('--profile='));
const PROFILE_DIR = PROFILE_FLAG
  ? path.resolve(PROFILE_FLAG.slice('--profile='.length))
  : path.join(app.getPath('appData'), 'deepseek-desktop');
app.setPath('userData', PROFILE_DIR);
app.setPath('sessionData', PROFILE_DIR);

// Chromium's renderer sandbox needs a desktop logon token with the usual
// privileges. Launched from an automation/service context that token can be
// missing, and every window then dies with an access violation. Matching the
// switch that context needs keeps the shell runnable there as well; an ordinary
// desktop launch is unaffected.
if (!app.commandLine.hasSwitch('no-sandbox') && process.env.DEEPSEEK_DESKTOP_NO_SANDBOX === '1') {
  app.commandLine.appendSwitch('no-sandbox');
}

// This is a plain chat window, so the GPU sandbox is not needed, and it is a
// known crash source on integrated-graphics laptops.
app.commandLine.appendSwitch('disable-gpu-sandbox');

const SMOKE = process.argv.includes('--smoke-test');
const SMOKE_TIMEOUT_MS = 60 * 1000;
const smoke = { loadedUrl: null, title: null, bodyChars: 0, errors: [], done: false };

let mainWindow = null;
let tray = null;
let isQuitting = false;

// Electron on Windows is a GUI-subsystem binary: console output is often
// invisible when it is launched from a console, so smoke results go to a file.
// A packaged app lives inside app.asar (read-only), hence the candidate list and
// the --smoke-out override.
function smokeOutPath() {
  const flag = process.argv.find((a) => a.startsWith('--smoke-out='));
  if (flag) return path.resolve(flag.slice('--smoke-out='.length));
  const candidates = [__dirname, app.getPath('temp'), app.getPath('userData')];
  for (const dir of candidates) {
    try {
      fs.accessSync(dir, fs.constants.W_OK);
      return path.join(dir, 'smoke-result.json');
    } catch { /* try next */ }
  }
  return path.join(app.getPath('userData'), 'smoke-result.json');
}

function writeSmokeResult(payload) {
  const target = smokeOutPath();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    console.log('SMOKE_WRITE_FAILED ' + target + ' ' + err.message);
  }
}

if (SMOKE) {
  process.on('uncaughtException', (err) => {
    writeSmokeResult({ ok: false, reason: 'uncaughtException', detail: err && err.stack ? err.stack : String(err) });
    app.exit(4);
  });
  process.on('unhandledRejection', (err) => {
    writeSmokeResult({ ok: false, reason: 'unhandledRejection', detail: err && err.stack ? err.stack : String(err) });
  });
}

// Single instance: a second launch just focuses the running window.
// (Skipped in smoke mode so a leftover instance never hides the test result.)
if (!SMOKE) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on('second-instance', () => showWindow());
  }
}

/* ------------------------------------------------------------------ */
/* persistent session                                                  */
/* ------------------------------------------------------------------ */

function prepareSession() {
  const ses = session.fromPartition(PARTITION);

  // Keep the shell from silently granting camera/mic/notifications.
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  // A plain desktop user agent; the official site serves its own layout from it.
  ses.setUserAgent(
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`
  );

  return ses;
}

/* ------------------------------------------------------------------ */
/* window                                                              */
/* ------------------------------------------------------------------ */

function createWindow() {
  const ses = prepareSession();

  mainWindow = new BrowserWindow({
    width: 420,
    height: 800,
    minWidth: 360,
    minHeight: 520,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0f1117',
    title: 'DeepSeek',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      partition: PARTITION,
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  // On-site windows open inside the shell; anything else goes to the browser,
  // so this stays a chat window instead of a general-purpose browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isOfficial(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: childWindowOptions() };
    }
    if (isSafeExternal(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isOfficial(url)) return;
    event.preventDefault();
    if (isSafeExternal(url)) shell.openExternal(url);
  });

  if (SMOKE) {
    mainWindow.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) smoke.errors.push(String(message).slice(0, 300));
    });
  }

  mainWindow.once('ready-to-show', () => {
    if (!SMOKE) mainWindow.show();
  });

  // Closing the window parks it in the tray; "Quit" in the tray really exits.
  mainWindow.on('close', (event) => {
    if (isQuitting || SMOKE) return;
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  wireShortcuts(mainWindow);
  attachSmokeProbe(mainWindow);

  mainWindow.loadURL(OFFICIAL_URL).catch((err) => {
    smoke.errors.push('loadURL: ' + err.message);
    console.error('[deepseek-desktop] initial load failed:', err.message);
    loadOfflineNotice(mainWindow);
  });

  return mainWindow;
}

function childWindowOptions() {
  return {
    width: 420,
    height: 800,
    autoHideMenuBar: true,
    backgroundColor: '#0f1117',
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
}

function isOfficial(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'deepseek.com' || u.hostname.endsWith('.deepseek.com'));
  } catch {
    return false;
  }
}

function isSafeExternal(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* keyboard                                                            */
/* ------------------------------------------------------------------ */

function wireShortcuts(win) {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = (input.key || '').toLowerCase();
    const ctrl = input.control || input.meta;

    if (key === 'f5' || (ctrl && key === 'r')) {
      event.preventDefault();
      win.webContents.reload();
      return;
    }
    if (input.alt && key === 'left') {
      event.preventDefault();
      if (win.webContents.canGoBack()) win.webContents.goBack();
      return;
    }
    if (input.alt && key === 'right') {
      event.preventDefault();
      if (win.webContents.canGoForward()) win.webContents.goForward();
      return;
    }
    // DevTools only exist in smoke mode; end users get a plain chat window.
    if (SMOKE && ctrl && input.shift && key === 'i') {
      event.preventDefault();
      win.webContents.toggleDevTools();
    }
  });
}

/* ------------------------------------------------------------------ */
/* tray                                                                */
/* ------------------------------------------------------------------ */

function trayImage() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

function buildTray() {
  if (SMOKE || tray) return;
  tray = new Tray(trayImage());
  tray.setToolTip('DeepSeek 桌面版');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '打开窗口', click: () => showWindow() },
    { type: 'separator' },
    { label: '刷新', click: () => mainWindow && mainWindow.webContents.reload() },
    {
      label: '返回',
      click: () => mainWindow && mainWindow.webContents.canGoBack() && mainWindow.webContents.goBack(),
    },
    {
      label: '前进',
      click: () => mainWindow && mainWindow.webContents.canGoForward() && mainWindow.webContents.goForward(),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function showWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

/* ------------------------------------------------------------------ */
/* offline fallback                                                    */
/* ------------------------------------------------------------------ */

function loadOfflineNotice(win) {
  if (!win || win.isDestroyed()) return;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>
  html,body{height:100%;margin:0;background:#0f1117;color:#e6e8ee;
    font-family:"Microsoft YaHei UI","Segoe UI",sans-serif}
  .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;text-align:center;padding:24px}
  h1{font-size:17px;font-weight:600;margin:0}
  p{font-size:13px;line-height:1.7;color:#9aa3b2;margin:0;max-width:320px}
  button{margin-top:6px;padding:8px 20px;font-size:13px;color:#0f1117;background:#d7e3ff;
    border:0;border-radius:8px;cursor:pointer}
  button:hover{background:#ffffff}
</style></head><body><div class="wrap">
  <h1>暂时连不上 chat.deepseek.com</h1>
  <p>请检查网络或代理设置，然后点下面的按钮重试。程序没有改用任何 API 接口。</p>
  <button onclick="location.href='${OFFICIAL_URL}'">重新加载</button>
</div></body></html>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

/* ------------------------------------------------------------------ */
/* smoke test (shell self-check; not used by end users)                */
/* ------------------------------------------------------------------ */

function attachSmokeProbe(win) {
  if (!SMOKE) return;

  const wc = win.webContents;

  const finish = (reason) => {
    if (smoke.done) return;
    smoke.done = true;
    smoke.reason = reason;
    smoke.ok = smoke.ok === true;
    smoke.loadedUrl = smoke.loadedUrl || wc.getURL();
    smoke.electron = process.versions.electron;
    smoke.chrome = process.versions.chrome;
    smoke.userData = app.getPath('userData');
    writeSmokeResult(smoke);
    console.log('SMOKE_RESULT ' + JSON.stringify(smoke));
    isQuitting = true;
    setTimeout(() => app.exit(smoke.ok ? 0 : 3), 150);
  };

  wc.on('did-finish-load', async () => {
    smoke.loadedUrl = wc.getURL();
    smoke.title = wc.getTitle();
    try {
      smoke.bodyChars = await wc.executeJavaScript(
        'document.body ? document.body.innerText.trim().length : 0'
      );
    } catch { /* ignore */ }
    smoke.ok = smoke.bodyChars > 0 || isOfficial(smoke.loadedUrl);
    setTimeout(() => finish('loaded'), 500);
  });

  wc.on('did-fail-load', (_e, code, desc, url) => {
    smoke.errors.push(`did-fail-load ${code} ${desc} ${url}`);
    finish('did-fail-load');
  });

  setTimeout(() => {
    if (!smoke.done) finish('timeout');
  }, SMOKE_TIMEOUT_MS);
}

/* ------------------------------------------------------------------ */
/* lifecycle                                                           */
/* ------------------------------------------------------------------ */

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  if (SMOKE || isQuitting) {
    app.quit();
    return;
  }
  // Tray app: keep running with no window.
});

app.on('activate', () => {
  showWindow();
});

app.whenReady().then(() => {
  app.setAppUserModelId('local.deepseek.desktop');
  createWindow();
  if (!SMOKE) buildTray();
});
