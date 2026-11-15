# DeepSeek Desktop Shell

[![CI](https://github.com/Blazar118/deepseek-desktop-shell/actions/workflows/ci.yml/badge.svg)](https://github.com/Blazar118/deepseek-desktop-shell/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4.svg)](#requirements)
[![No API key](https://img.shields.io/badge/API%20key-not%20required-success.svg)](#what-it-does-not-do)

A thin Electron shell that loads the **official** [chat.deepseek.com](https://chat.deepseek.com/) web app as a Windows desktop window, plus an **opt-in local agent** that can read and write files on your machine.

By default it is deliberately tiny: no API client, no API key, no injected scripts, no page rewrites. You log in with your own account on the real site, exactly as you would in a browser.

> Not affiliated with DeepSeek. Unofficial, unendorsed, use at your own risk.

## Install

Grab `DeepSeek-Desktop-Setup-*.exe` from [Releases](https://github.com/Blazar118/deepseek-desktop-shell/releases), or build it yourself with `npm run dist`.

## What it does

- Opens `https://chat.deepseek.com/` in a 420×800 window (resizable, mobile-ish proportions).
- Keeps cookies and `localStorage` in a private Chromium profile, so you stay logged in after closing and reopening.
- Closing the window hides it to the system tray instead of quitting.
- Tray menu: open window / reload / back / forward / agent / quit.
- Sends off-site links to your default browser.
- Keyboard: `F5` or `Ctrl+R` reload, `Alt+←` / `Alt+→` history.
- **Opt-in agent** — see below. Off until you turn it on.

## What it does not do

- ❌ No `api.deepseek.com` calls, no API key, no billing.
- ❌ No request interception and no reverse proxy — the site's own traffic is untouched.
- ❌ No credential scraping, no captcha / risk-control bypass, no auto-fill of accounts.
- ❌ No impersonation of the official product.

If the site shows a captcha or risk check, the shell shows the same thing a browser would. It does not try to get around it.

## The agent (opt-in)

The official site is a UI, not an API. So an agent that uses it has to *drive the page*: type into the composer, press send, read the answer back. That is what `src/page-bridge.js` does, and it is the one place this project touches the live DOM.

**It is off until you turn it on** (tray → `Agent 模式`), and enabling it shows this trade-off first:

- This is not an official API. The site may classify the automation as an abnormal environment. **Accounts can be rate-limited or restricted.** EAgent, the project this borrows the idea from, says the same thing in its own README, and it is right.
- The model's tool calls **really execute on your machine**. Dangerous tools (`run_command`, `delete_path`) always stop and ask you first, and every tool is confined to the workspace directory you pick.

### How it works

```
your task
   ↓
src/agent.js  ── plain-text protocol ──▶  chat.deepseek.com (your logged-in session)
   ↑                                          │
   │  ```tool {"tool":"read_file", ...} ```   │
   ↓                                          ▼
src/tools.js  ── reads/writes files, runs PowerShell ──▶ results back into the chat
```

There is no function-calling channel, so the model is instructed to reply with a single fenced `tool` block containing JSON. The loop parses it, runs the tool locally, and feeds the result back as the next user turn. A hard cap of 12 steps stops a confused model from grinding.

### Tools

| Tool | Does | Needs approval |
| --- | --- | --- |
| `list_dir` | list a directory | |
| `read_file` | read a text file (first 200 KB) | |
| `write_file` | create/overwrite a file | |
| `append_file` | append to a file | |
| `make_dir` | create directories | |
| `search_files` | literal search across the workspace | |
| `delete_path` | delete a file/directory | ✔ |
| `run_command` | run PowerShell in the workspace | ✔ |

Every path is resolved and re-checked after resolution, so `..` and absolute paths outside the workspace root are rejected rather than followed.

### Testing it

```powershell
npm run test:agent     # parser + path containment + every tool (no browser)
npm run test:bridge    # sends one real message to the site and reads the reply
npm run test:e2e       # full agent run in a throwaway folder: list, read, write
```

`test:e2e` creates a temp workspace with facts the model cannot guess, then checks the file it wrote — so a pass means the whole loop really worked, not just that it returned text.

## Requirements

- Windows 10/11 x64
- Node.js 18+ (developed against Node 22/24)
- npm


## Run it

```powershell
npm install
npm start
```

If `npm install` cannot download the Electron binary (corporate proxies, restricted environments, or a `spawn EPERM` from lifecycle scripts), fetch the runtime directly from the mirror instead:

```powershell
npm install --ignore-scripts
node scripts/fetch-electron.js
```

`scripts/fetch-electron.js` downloads the official Electron zip from `npmmirror.com` and unpacks it into `node_modules/electron/dist` — the same result as the postinstall step, but runnable by hand.

## Build the installer

```powershell
npm run dist
```

Output: `dist\DeepSeek-Desktop-Setup-<version>.exe` (NSIS, per-user install, optional directory choice, desktop + Start Menu shortcuts).

On machines where the build tool cannot reach the default caches, `build.cmd` pins every cache inside the project and points Electron at the already-downloaded runtime:

```powershell
build.cmd
```

## Verifying the shell

```powershell
npm run smoke          # loads the site headlessly, writes smoke-result.json
npm run check:persist  # writes a cookie in one process, reads it in another
```

`check:persist` is the honest test of "it keeps me logged in": two separate processes, one writes, one reads, and the second must find the cookie.

## Command-line flags

| Flag | Purpose |
| --- | --- |
| `--smoke-test` | Self-check mode: load the site, write `smoke-result.json`, exit. No tray, no window shown. |
| `--smoke-out=<path>` | Where the smoke result goes. |
| `--profile=<dir>` | Use a different Chromium profile folder. Handy for side-by-side runs. |

`DEEPSEEK_DESKTOP_NO_SANDBOX=1` adds `--no-sandbox`. Only needed in automation/service contexts where the process has no normal desktop logon token; ordinary desktop use should leave it unset.

## Notes on pinning Electron

This is pinned to Electron `43.3.0` on purpose. On some Windows machines Electron 45 aborts inside the renderer during start-up with an access violation (`0xc0000005`) before any app code runs. 43.3.0 starts reliably on the same machine. If you bump the major version, run `npm run smoke` first.

## Layout

```
main.js                        the whole shell
assets/icon-source.png         512x512 transparent master icon
assets/icon.png                generated window icon (256)
assets/tray.png                generated tray icon (32)
build/icon.ico                 generated multi-size Windows icon (16-256)
scripts/derive-icon-source.py  rebuilds the master from the official mark (Pillow)
scripts/make-icons.js          generates all icon sizes from the master (zero deps)
scripts/fetch-electron.js      manual Electron downloader/unpacker
scripts/verify-persistence.js  cookie-survives-restart check
scripts/smoke.cmd              smoke test helper for console-hostile environments
scripts/test-agent-core.js     parser + path containment + tool tests (no browser)
scripts/test-page-bridge.js    live check: send one message, read the reply
scripts/test-agent-run.js      full agent run in a throwaway workspace
src/page-bridge.js             types into the composer, reads the reply back
src/tools.js                   local file/command tools, confined to a workspace
src/agent.js                   the loop and the text tool-call protocol
src/panel.js                   the agent side panel (its own window + IPC)
src/panel-preload.js           the panel's narrow bridge to the main process
```

## Icons

`assets/icon-source.png` is derived from the mark that `chat.deepseek.com` itself
serves (`fe-static.deepseek.com/chat/icon-512.png`, the apple-touch-icon and
manifest icon). The official file is a blue whale on a solid white square; the
master here has that white keyed out by flood-filling from the border, so the
whale's white belly stays intact and the anti-aliased rim is recovered from the
red channel — no white halo on dark backgrounds.

`npm run icons` regenerates `icon.png`, `tray.png` and `icon.ico` from the master
using only Node built-ins. Rebuild the master itself (needs Pillow + numpy, not a
project dependency):

```
python scripts/derive-icon-source.py icon-512.png assets/icon-source.png
```

All logos and the whale mark belong to DeepSeek; see [NOTICE](NOTICE).

## License

MIT — see [LICENSE](LICENSE).

---

## 中文说明

把官方 [chat.deepseek.com](https://chat.deepseek.com/) 网页装进一个 Windows 桌面窗口。

- 窗口默认 420×800（可缩放），关窗最小化到托盘，托盘菜单可打开/刷新/前进/后退/退出。
- 登录态存在独立 Chromium 配置目录里，关掉再开不用重新登录。
- 站外链接交给系统浏览器，壳内只跑 deepseek.com。
- 不使用 API、不需要 Key、不拦截请求、不绕过验证码。
- 图标取自官方网页自己提供的鲸鱼标（`fe-static.deepseek.com/chat/icon-512.png`），
  把白底抠成透明后生成各尺寸，安装包、桌面快捷方式、任务栏、托盘都是它。

### Agent（默认关闭）

官方网页是给人操作的界面，不是 API。所以要用它当 Agent 的大脑，只能去**驱动页面**：
往输入框里打字、点发送、把回复读回来。这是本项目唯一碰页面 DOM 的地方，在
`src/page-bridge.js`。

托盘菜单 → `Agent 模式` 打开。打开时会先跟你说明两件事：

1. 这不是官方接口。官方有可能把这种用法判定成异常环境，**账号有被限流的风险**。
   EAgent 那个项目的 README 里也这么说，它说得对。
2. 模型调用的工具会**真的在你电脑上执行**。`run_command`、`delete_path` 属于危险工具，
   每次都会先弹确认；所有工具都被限制在你选的工作目录里，`..` 和绝对路径会被拒绝。

用法：托盘 → `Agent 面板` → 选工作目录 → 写一件具体的事 → 开始。面板会实时显示它每一步
在干什么，随时可以点停止。最多 12 步，防止模型自己绕圈。

自测命令：

```powershell
npm run test:agent    # 解析器 + 路径越界 + 每个工具，不碰浏览器
npm run test:bridge   # 真实发一条消息并读回回复
npm run test:e2e      # 在临时目录里跑完整任务：列目录、读文件、写文件
```

常用命令：`npm install` → `npm start` 运行；`npm run dist` 打包出 `dist\DeepSeek-Desktop-Setup-1.0.0.exe`。
本机若因代理/权限装不上 Electron 二进制，用 `node scripts/fetch-electron.js` 从国内镜像手动拉取。

本项目与 DeepSeek 官方无关，非官方、未获背书，自用为主。
