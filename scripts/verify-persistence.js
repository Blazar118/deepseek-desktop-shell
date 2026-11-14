// Proves the persistent-partition mechanism (the thing that keeps you logged in)
// actually survives a full process restart.
//
// Run twice as two separate processes:
//   electron scripts\verify-persistence.js --write
//   electron scripts\verify-persistence.js --read
//
// A writable profile dir is used so the check also runs on machines where the
// current process may not be allowed to write into %APPDATA%.

const { app, session } = require('electron');
const fs = require('fs');
const path = require('path');

const PARTITION = 'persist:deepseek';
const COOKIE_NAME = 'desk_persist_probe';
const mode = process.argv.includes('--write') ? 'write' : 'read';
const outFile = path.join(__dirname, '..', 'persist-check.json');

const profileDir = path.join(__dirname, '..', '.profile-check');
app.setPath('userData', profileDir);
app.setPath('sessionData', profileDir);

const report = (payload) => {
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf8');
  console.log('PERSIST ' + JSON.stringify(payload));
  app.exit(payload.ok ? 0 : 3);
};

app.whenReady().then(async () => {
  try {
    const ses = session.fromPartition(PARTITION);

    if (mode === 'write') {
      const value = 'probe-' + Date.now();
      await ses.cookies.set({
        url: 'https://chat.deepseek.com/',
        name: COOKIE_NAME,
        value,
        expirationDate: Math.floor(Date.now() / 1000) + 86400,
        secure: true,
      });
      await ses.cookies.flushStore();
      const stored = await ses.cookies.get({ name: COOKIE_NAME, url: 'https://chat.deepseek.com/' });
      report({ ok: stored.length === 1, mode, profileDir, wrote: value, found: stored.map((c) => c.value) });
      return;
    }

    const found = await ses.cookies.get({ name: COOKIE_NAME, url: 'https://chat.deepseek.com/' });
    report({ ok: found.length === 1, mode, profileDir, found: found.map((c) => c.value) });
  } catch (err) {
    report({ ok: false, mode, error: err && err.message ? err.message : String(err) });
  }
});
