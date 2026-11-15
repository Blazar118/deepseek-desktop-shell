'use strict';

// Full agent run against the live site, with a throwaway workspace:
// the model must list a directory, read a file, and write a summary.
//
//   node_modules\electron\dist\electron.exe scripts\test-agent-run.js
//
// Writes agent-run-result.json. Dangerous tools auto-deny so this stays safe.

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const out = path.join(__dirname, '..', 'agent-run-result.json');
const events = [];
const record = (e) => {
  events.push(e);
  fs.writeFileSync(out, JSON.stringify({ events }, null, 2), 'utf8');
};

app.setPath('userData', path.join(app.getPath('appData'), 'deepseek-desktop'));
app.setPath('sessionData', path.join(app.getPath('appData'), 'deepseek-desktop'));
app.commandLine.appendSwitch('no-sandbox');

// Throwaway workspace with facts the model cannot guess.
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-e2e-'));
fs.writeFileSync(
  path.join(workdir, 'facts.txt'),
  ['项目代号：蓝鲸三号', '启动端口：49317', '负责人：老张'].join('\n') + '\n',
  'utf8'
);
const startTime = Date.now();

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

    const { runAgent } = require('../src/agent');

    const result = await runAgent({
      webContents: win.webContents,
      root: workdir,
      task: '看看当前目录里有哪些文件，读出 facts.txt 的内容，然后把这三条信息写进 summary.md，用「键: 值」的格式，一行一条。',
      onEvent: (evt) => {
        const copy = { ...evt, at: Date.now() - startTime };
        if (copy.prompt) copy.prompt = copy.prompt.slice(-300);
        if (copy.text) copy.text = copy.text.slice(0, 600);
        record(copy);
      },
      approve: async (req) => {
        record({ type: 'approval-denied-auto', tool: req.tool, args: req.args });
        return false;
      },
    });

    record({ type: 'run-result', result: { ok: result.ok, error: result.error, steps: result.steps } });

    const summaryPath = path.join(workdir, 'summary.md');
    record({
      type: 'files',
      exists: fs.existsSync(summaryPath),
      content: fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, 'utf8') : null,
      dir: workdir,
    });
  } catch (err) {
    record({ type: 'error', message: err && err.message ? err.message : String(err) });
  }

  app.exit(0);
});

setTimeout(() => { record({ type: 'hard-timeout' }); app.exit(2); }, 300000);
