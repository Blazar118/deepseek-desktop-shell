'use strict';

/**
 * Agent side panel: a separate BrowserWindow that loads a local HTML file and
 * talks to the main process over IPC.
 *
 * It is a real window rather than an overlay injected into the chat page, for
 * two reasons: the chat page stays untouched (no DOM we own inside it), and the
 * panel can keep working while you scroll the conversation.
 */

const { BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let panel = null;
let runToken = 0;
let abortController = null;
let pendingApproval = null;

const state = {
  running: false,
  root: null,
  enabled: false,
  log: [],
};

function panelHTML() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>Agent</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #16181d; color: #e8eaf0; height: 100vh; display: flex; flex-direction: column;
    font: 13px/1.55 "Microsoft YaHei UI", "Segoe UI", sans-serif;
  }
  header {
    padding: 10px 12px; display: flex; align-items: center; gap: 8px;
    border-bottom: 1px solid #262a33; flex: 0 0 auto;
  }
  header .title { font-weight: 600; font-size: 13px; }
  header .dot { width: 8px; height: 8px; border-radius: 50%; background: #4b5162; }
  header .dot.on { background: #4E6CFE; box-shadow: 0 0 8px #4E6CFE; }
  header .spacer { flex: 1; }
  .rootbar {
    padding: 8px 12px; border-bottom: 1px solid #262a33; display: flex; gap: 8px; align-items: center;
    font-size: 12px; color: #9aa3b2; flex: 0 0 auto;
  }
  .rootbar .path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #log { flex: 1; overflow-y: auto; padding: 10px 12px; }
  .ev { margin-bottom: 8px; padding-left: 8px; border-left: 2px solid #2e3340; }
  .ev.think { border-color: #4E6CFE; }
  .ev.tool { border-color: #d9a441; }
  .ev.ok { border-color: #3fa46a; }
  .ev.err { border-color: #d9534f; }
  .ev .k { color: #7f8797; font-size: 11px; }
  .ev .v { white-space: pre-wrap; word-break: break-word; }
  .ev pre {
    margin: 4px 0 0; padding: 6px 8px; background: #1d2027; border-radius: 6px;
    overflow-x: auto; font-size: 11.5px; max-height: 220px;
  }
  footer { flex: 0 0 auto; border-top: 1px solid #262a33; padding: 10px 12px; }
  textarea {
    width: 100%; height: 74px; resize: vertical; background: #1d2027; color: #e8eaf0;
    border: 1px solid #2e3340; border-radius: 8px; padding: 8px; font: inherit; outline: none;
  }
  textarea:focus { border-color: #4E6CFE; }
  .row { display: flex; gap: 8px; margin-top: 8px; }
  button {
    flex: 0 0 auto; padding: 7px 14px; border-radius: 8px; border: 1px solid #2e3340;
    background: #232732; color: #e8eaf0; font: inherit; cursor: pointer;
  }
  button:hover:not(:disabled) { background: #2b3040; }
  button:disabled { opacity: .45; cursor: default; }
  button.primary { background: #4E6CFE; border-color: #4E6CFE; color: #fff; font-weight: 600; }
  button.primary:hover:not(:disabled) { background: #5f7bff; }
  button.danger { border-color: #7a3532; color: #ff9b96; }
  .grow { flex: 1; }
  .hint { color: #6c7486; font-size: 11.5px; margin-top: 6px; }
  .approval {
    margin-top: 8px; padding: 10px; border: 1px solid #7a5c20; background: #241f12;
    border-radius: 8px; font-size: 12px;
  }
  .approval pre { margin: 6px 0; padding: 6px 8px; background: #1a1710; border-radius: 6px; overflow-x: auto; font-size: 11.5px; }
</style></head>
<body>
  <header>
    <span class="dot" id="dot"></span>
    <span class="title">Agent</span>
    <span class="spacer"></span>
    <button id="stop" class="danger" disabled>停止</button>
  </header>

  <div class="rootbar">
    <span>工作目录</span>
    <span class="path" id="root">（未选择）</span>
    <button id="pickRoot">选择</button>
  </div>

  <div id="log"></div>

  <footer>
    <textarea id="task" placeholder="交代一件具体的事，比如：读一下 README.md，把里面的命令整理成一个列表写进 TODO.md"></textarea>
    <div class="row">
      <button id="run" class="primary">开始</button>
      <div class="grow"></div>
      <button id="clear">清空日志</button>
    </div>
    <div class="hint">Agent 会真的在你的电脑上读写文件、执行命令。每一次危险操作都会先问你。</div>
  </footer>

<script>
  const $ = (id) => document.getElementById(id);
  const logEl = $('log');
  let running = false;

  function addEvent(ev) {
    const div = document.createElement('div');
    div.className = 'ev';

    const k = document.createElement('div');
    k.className = 'k';
    const v = document.createElement('div');
    v.className = 'v';

    switch (ev.type) {
      case 'thinking':
        div.classList.add('think');
        k.textContent = '第 ' + ev.step + ' 步 · 发送给模型';
        v.textContent = String(ev.prompt || '').slice(0, 400) + (String(ev.prompt || '').length > 400 ? ' …' : '');
        break;
      case 'page':
        if (ev.phase === 'sent') { k.textContent = '已发送'; v.textContent = '等待页面接收…'; }
        else if (ev.phase === 'accepted') { k.textContent = '已接收'; v.textContent = '等待回复…'; }
        else if (ev.phase === 'accepted-unclear') { k.textContent = '已发送'; v.textContent = '输入框未清空，继续等待…'; }
        else { k.textContent = '等待回复'; v.textContent = '新回合 ' + (ev.info?.turns ?? 0) + ' · ' + (ev.info?.len ?? 0) + ' 字符'; }
        break;
      case 'reply':
        k.textContent = '第 ' + ev.step + ' 步 · 模型回复（' + ev.chars + ' 字符）';
        v.textContent = ev.text.slice(0, 1500) + (ev.text.length > 1500 ? ' …' : '');
        break;
      case 'tool-call':
        div.classList.add('tool');
        k.textContent = '调用工具 · ' + ev.tool;
        v.innerHTML = '';
        const pre = document.createElement('pre');
        pre.textContent = JSON.stringify(ev.args, null, 2);
        v.appendChild(pre);
        break;
      case 'tool-result': {
        const r = ev.result || {};
        div.classList.add(r.ok ? 'ok' : 'err');
        k.textContent = '工具结果 · ' + ev.tool + (r.ok ? '' : ' · 失败');
        const p = document.createElement('pre');
        p.textContent = JSON.stringify(r, null, 2).slice(0, 3000);
        v.appendChild(p);
        break;
      }
      case 'approval':
        div.classList.add(ev.approved ? 'ok' : 'err');
        k.textContent = ev.approved ? '已允许 · ' + ev.tool : '已拒绝 · ' + ev.tool;
        v.textContent = '';
        break;
      case 'final':
        div.classList.add('ok');
        k.textContent = '完成（' + ev.step + ' 步）';
        v.textContent = ev.text;
        break;
      case 'page-error':
        div.classList.add('err');
        k.textContent = '页面操作失败';
        v.textContent = ev.error + (ev.detail ? ' · ' + JSON.stringify(ev.detail) : '');
        break;
      case 'step-limit':
        div.classList.add('err');
        k.textContent = '到达步数上限';
        v.textContent = 'Agent 用了 ' + ev.steps + ' 步仍未收尾，已停下。可以把任务拆小一点再跑。';
        break;
      case 'aborted':
        div.classList.add('err');
        k.textContent = '已停止';
        v.textContent = '第 ' + ev.step + ' 步被中断。';
        break;
      case 'error':
        div.classList.add('err');
        k.textContent = '错误';
        v.textContent = ev.message || JSON.stringify(ev);
        break;
      default:
        k.textContent = ev.type;
        v.textContent = JSON.stringify(ev);
    }

    div.appendChild(k);
    div.appendChild(v);
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setRunning(v) {
    running = v;
    $('run').disabled = v;
    $('task').disabled = v;
    $('stop').disabled = !v;
    $('dot').classList.toggle('on', v);
  }

  $('pickRoot').onclick = async () => {
    const dir = await window.agent.pickRoot();
    if (dir) $('root').textContent = dir;
  };

  $('run').onclick = async () => {
    const task = $('task').value.trim();
    if (!task) return;
    logEl.innerHTML = '';
    setRunning(true);
    const res = await window.agent.start(task);
    setRunning(false);
    if (!res.ok && res.error && res.shown !== true) {
      addEvent({ type: 'error', message: res.error + (res.detail ? ' · ' + JSON.stringify(res.detail) : '') });
    }
  };

  $('stop').onclick = () => window.agent.stop();
  $('clear').onclick = () => { logEl.innerHTML = ''; };

  window.agent.onEvent((ev) => {
    if (ev.type === 'approval-request') {
      renderApproval(ev);
      return;
    }
    addEvent(ev);
  });

  function renderApproval(ev) {
    const div = document.createElement('div');
    div.className = 'ev tool';
    div.innerHTML = '<div class="k">需要你确认 · ' + ev.tool + '</div>';
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(ev.args, null, 2);
    div.appendChild(pre);
    const row = document.createElement('div');
    row.className = 'row';
    const yes = document.createElement('button');
    yes.className = 'primary';
    yes.textContent = '允许这一次';
    const no = document.createElement('button');
    no.textContent = '拒绝';
    yes.onclick = () => { window.agent.approve(ev.id, true); g.disabled = true; };
    no.onclick = () => { window.agent.approve(ev.id, false); g.disabled = true; };
    row.appendChild(yes);
    row.appendChild(no);
    div.appendChild(row);

    // The buttons disappear once answered, so two clicks can't answer twice.
    const g = document.createElement('div');
    g.className = 'hint';
    div.appendChild(g);

    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }

  setRunning(false);
  window.agent.init().then((s) => {
    if (s.root) $('root').textContent = s.root;
  });
</script>
</body></html>`;
}

function createPanel(parent, opts = {}) {
  if (panel && !panel.isDestroyed()) {
    panel.focus();
    return panel;
  }

  panel = new BrowserWindow({
    width: 460,
    height: 720,
    minWidth: 380,
    minHeight: 480,
    parent: parent || undefined,
    title: 'Agent',
    autoHideMenuBar: true,
    backgroundColor: '#16181d',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'panel-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  panel.setMenuBarVisibility(false);
  panel.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(panelHTML()));

  panel.on('closed', () => {
    panel = null;
    if (abortController) abortController.abort();
  });

  return panel;
}

function sendToPanel(channel, payload) {
  if (panel && !panel.isDestroyed()) panel.webContents.send(channel, payload);
}

let handlersInstalled = false;

function installPanelIpc(deps) {
  if (handlersInstalled) return;
  handlersInstalled = true;

  const { getChatWindow, getRoot, setRoot, onRootChanged } = deps;

  ipcMain.handle('agent:init', () => ({ root: getRoot(), running: state.running }));

  ipcMain.handle('agent:pick-root', async () => {
    const win = panel || getChatWindow();
    const res = await dialog.showOpenDialog(win, {
      title: '选择 Agent 的工作目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return null;
    setRoot(res.filePaths[0]);
    onRootChanged(res.filePaths[0]);
    return res.filePaths[0];
  });

  ipcMain.handle('agent:start', async (_e, task) => {
    if (state.running) return { ok: false, error: 'already-running' };

    const root = getRoot();
    if (!root) {
      sendToPanel('agent:event', { type: 'error', message: '请先选择工作目录。' });
      return { ok: false, error: 'no-root', shown: true };
    }
    if (!fs.existsSync(root)) {
      sendToPanel('agent:event', { type: 'error', message: '工作目录不存在了：' + root });
      return { ok: false, error: 'root-missing', shown: true };
    }

    const chat = getChatWindow();
    if (!chat || chat.isDestroyed()) {
      sendToPanel('agent:event', { type: 'error', message: '聊天窗口已关闭，先把主窗口打开。' });
      return { ok: false, error: 'no-chat-window', shown: true };
    }

    const { runAgent } = require('./agent');
    state.running = true;
    state.root = root;
    abortController = new AbortController();
    const token = ++runToken;

    try {
      const result = await runAgent({
        webContents: chat.webContents,
        root,
        task: String(task || ''),
        signal: abortController.signal,
        onEvent: (evt) => {
          if (token !== runToken) return;
          sendToPanel('agent:event', evt);
        },
        approve: (req) => askApproval(req),
      });
      return result;
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      sendToPanel('agent:event', { type: 'error', message });
      return { ok: false, error: message, shown: true };
    } finally {
      if (token === runToken) {
        state.running = false;
        abortController = null;
      }
    }
  });

  ipcMain.handle('agent:stop', () => {
    runToken++;
    if (abortController) abortController.abort();
    state.running = false;
    sendToPanel('agent:event', { type: 'aborted', step: 0 });
    return { ok: true };
  });

  ipcMain.handle('agent:approve', (_e, id, allowed) => {
    if (pendingApproval && pendingApproval.id === id) {
      const { resolve } = pendingApproval;
      pendingApproval = null;
      resolve(Boolean(allowed));
    }
    return { ok: true };
  });
}

function askApproval({ tool, args, step }) {
  return new Promise((resolve) => {
    const id = 'ap-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    pendingApproval = { id, resolve };
    sendToPanel('agent:event', { type: 'approval-request', id, tool, args, step });

    // If the panel is closed mid-question, treat it as a refusal.
    const timer = setTimeout(() => {
      if (pendingApproval && pendingApproval.id === id) {
        pendingApproval = null;
        resolve(false);
      }
    }, 120000);
    const orig = resolve;
    pendingApproval.resolve = (v) => { clearTimeout(timer); orig(v); };
  });
}

function closePanel() {
  runToken++;
  if (abortController) abortController.abort();
  if (panel && !panel.isDestroyed()) panel.destroy();
  panel = null;
}

module.exports = { createPanel, installPanelIpc, closePanel, state };
