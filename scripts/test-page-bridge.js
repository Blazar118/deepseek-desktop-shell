'use strict';

// End-to-end check of the page bridge against the live site:
// opens the chat page, sends a trivial message through the same code path the
// agent uses, and waits for the reply.
//
//   node_modules\electron\dist\electron.exe scripts\test-page-bridge.js
//
// Writes page-bridge-result.json next to the project. Reads nothing private.

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, '..', 'page-bridge-result.json');
const events = [];
const record = (e) => {
  events.push(e);
  fs.writeFileSync(out, JSON.stringify({ events }, null, 2), 'utf8');
};

app.setPath('userData', path.join(app.getPath('appData'), 'deepseek-desktop'));
app.setPath('sessionData', path.join(app.getPath('appData'), 'deepseek-desktop'));
app.commandLine.appendSwitch('no-sandbox');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 460, height: 900, show: false,
    webPreferences: {
      partition: 'persist:deepseek',
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });

  try {
    win.webContents.session.setUserAgent(
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`
    );

    await win.loadURL('https://chat.deepseek.com/');
    await new Promise((r) => setTimeout(r, 6000));
    record({ step: 'loaded', url: win.webContents.getURL() });

    const { sendAndWaitForReply } = require('../src/page-bridge');

    const started = Date.now();
    const res = await sendAndWaitForReply(win.webContents, '只回答两个字：收到', {
      timeoutMs: 120000,
      settleMs: 2000,
      onProgress: (phase, info) => record({ step: 'progress', phase, info, at: Date.now() - started }),
    });

    record({ step: 'result', res, ms: Date.now() - started });
  } catch (err) {
    record({ step: 'error', message: err && err.message ? err.message : String(err) });
  }

  app.exit(0);
});

setTimeout(() => {
  record({ step: 'hard-timeout' });
  app.exit(2);
}, 180000);
