# Contributing

Thanks for looking. This project is intentionally small — the goal is a correct, boring shell around the official web app, not a feature platform.

## Ground rules

These are not negotiable, because they are what makes the project legitimate:

1. **No API.** No `api.deepseek.com`, no API keys, no token refresh, nothing that bills anyone.
2. **No page modification.** No `executeJavaScript` against the live site, no CSS injection, no DOM rewriting, no `webRequest` interception.
3. **No bypassing protections.** Captchas, risk checks, login flows stay exactly as the official page presents them.
4. **No credential handling.** The shell never reads, stores, or fills account credentials itself.
5. **No impersonation.** Do not make the app look like an official DeepSeek product.

A pull request that breaks any of these will be closed regardless of how useful the feature seems.

## Before you open a PR

```powershell
npm run smoke          # must report ok: true
npm run check:persist  # must report ok: true both times
```

If your change touches window creation, tray behaviour, or the profile directory, also build and install once:

```powershell
npm run dist
```

## Code style

- Plain CommonJS, Node built-ins only for the main process. Keep runtime dependencies at **zero**.
- Comments explain *why*, not *what*. If a line works around a specific machine or Chromium behaviour, say so.
- Keep `main.js` a single readable file. Splitting it into modules is fine only when it genuinely helps, not for tidiness.

## Reporting bugs

Include:

- Windows version
- Electron version (`npx electron --version`)
- whether it happens on `npm start`, on the installed build, or both
- the contents of `smoke-result.json` after `npm run smoke`
- any Windows Event Viewer entry under *Application Error* mentioning the app's exe

Start-up crashes on this stack are almost always one of: a shared profile directory, a missing desktop logon token, or an Electron major version that does not start on the machine.
