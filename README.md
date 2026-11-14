# DeepSeek Desktop Shell

A thin Electron shell that loads the **official** [chat.deepseek.com](https://chat.deepseek.com/) web app as a Windows desktop window.

It is deliberately tiny: no API client, no API key, no injected scripts, no page rewrites. You log in with your own account on the real site, exactly as you would in a browser. The shell only adds what a browser tab cannot do — a fixed phone-shaped window, a tray icon, and a login that survives restarts.

> Not affiliated with DeepSeek. Unofficial, unendorsed, use at your own risk.

## What it does

- Opens `https://chat.deepseek.com/` in a 420×800 window (resizable, mobile-ish proportions).
- Keeps cookies and `localStorage` in a private Chromium profile, so you stay logged in after closing and reopening.
- Closing the window hides it to the system tray instead of quitting.
- Tray menu: open window / reload / back / forward / quit.
- Sends off-site links to your default browser.
- Keyboard: `F5` or `Ctrl+R` reload, `Alt+←` / `Alt+→` history.

## What it does not do

- ❌ No `api.deepseek.com` calls, no API key, no billing.
- ❌ No script injection, no DOM changes, no request interception.
- ❌ No credential scraping, no captcha / risk-control bypass, no auto-fill of accounts.
- ❌ No impersonation of the official product.

If the site shows a captcha or risk check, the shell shows the same thing a browser would. It does not try to get around it.

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
main.js                      the whole shell
assets/                      generated window + tray icons
build/icon.ico               generated Windows icon
scripts/make-icons.js        draws the icons (no external art)
scripts/fetch-electron.js    manual Electron downloader/unpacker
scripts/verify-persistence.js  cookie-survives-restart check
scripts/smoke.cmd            smoke test helper for console-hostile environments
```

## License

MIT — see [LICENSE](LICENSE).

---

## 中文说明

把官方 [chat.deepseek.com](https://chat.deepseek.com/) 网页装进一个 Windows 桌面窗口。**不接 API、不需要 Key、不改网页。**

- 窗口默认 420×800（可缩放），关窗最小化到托盘，托盘菜单可打开/刷新/前进/后退/退出。
- 登录态存在独立 Chromium 配置目录里，关掉再开不用重新登录。
- 站外链接交给系统浏览器，壳内只跑 deepseek.com。
- 不注入脚本、不改 DOM、不拦截请求、不绕过验证码。

常用命令：`npm install` → `npm start` 运行；`npm run dist` 打包出 `dist\DeepSeek-Desktop-Setup-1.0.0.exe`。
本机若因代理/权限装不上 Electron 二进制，用 `node scripts/fetch-electron.js` 从国内镜像手动拉取。

本项目与 DeepSeek 官方无关，非官方、未获背书，自用为主。
