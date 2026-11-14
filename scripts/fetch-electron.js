// Downloads the Electron runtime from the npmmirror mirror and unpacks it into
// node_modules/electron/dist — the exact thing electron's own postinstall does,
// but runnable from PowerShell because this machine blocks npm's child spawns.
//
// Usage: node scripts/fetch-electron.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'node_modules', 'electron');
const MIRROR = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';
const VERSION = process.env.ELECTRON_VERSION || require(path.join(OUT_DIR, 'package.json')).version;

function get(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'node' } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        resolve(get(new URL(res.headers.location, url).toString(), redirects - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks = [];
      let received = 0;
      res.on('data', (c) => {
        chunks.push(c);
        received += c.length;
        if (received % (5 * 1024 * 1024) < c.length) {
          process.stdout.write(`  ...${(received / 1048576).toFixed(1)} MB\n`);
        }
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
  });
}

// Minimal ZIP extractor: stored (0) and deflate (8) entries only, which covers
// the official Electron Windows zip.
function unzipAll(buf, destDir) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory)');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  let files = 0;
  const dirs = [];

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    const target = path.join(destDir, name);
    if (!path.resolve(target).startsWith(path.resolve(destDir))) {
      throw new Error('zip entry escapes destination: ' + name);
    }
    if (name.endsWith('/')) { dirs.push(target); continue; }

    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('bad local header: ' + name);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = comp;
    else if (method === 8) data = zlib.inflateRawSync(comp);
    else throw new Error(`unsupported zip method ${method} for ${name}`);
    if (uncompSize !== data.length) throw new Error(`size mismatch for ${name}`);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    files++;
  }
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
  return files;
}

(async () => {
  const zipName = `electron-v${VERSION}-win32-x64.zip`;
  const url = `${MIRROR}${VERSION}/${zipName}`;
  const tmp = path.join(os.tmpdir(), zipName);

  console.log(`electron version: ${VERSION}`);
  console.log(`downloading: ${url}`);
  const t0 = Date.now();
  const buf = await get(url);
  fs.writeFileSync(tmp, buf);
  console.log(`downloaded ${(buf.length / 1048576).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const dist = path.join(OUT_DIR, 'dist');
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });
  const files = unzipAll(buf, dist);
  console.log(`extracted ${files} files to ${dist}`);

  const exe = path.join(dist, 'electron.exe');
  if (!fs.existsSync(exe)) throw new Error('electron.exe missing after extract');
  fs.writeFileSync(path.join(OUT_DIR, 'path.txt'), 'electron.exe');
  console.log('OK: electron.exe ready');
})().catch((err) => {
  console.error('FAILED: ' + err.message);
  process.exit(1);
});
