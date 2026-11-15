// Derives the app's icons from assets/icon-source.png (the official DeepSeek
// mark, with its white background keyed out).
//
//   assets/icon-source.png  512x512 transparent master (checked in)
//   assets/icon.png         256x256 window icon
//   assets/tray.png          32x32 tray icon
//   build/icon.ico          multi-size Windows icon for electron-builder
//
// Zero dependencies on purpose: a small PNG decoder/encoder plus a bilinear
// resize is all this needs, and it keeps `npm install` light.
//
// Usage: node scripts/make-icons.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'assets', 'icon-source.png');
const OUT_ASSETS = path.join(ROOT, 'assets');
const OUT_BUILD = path.join(ROOT, 'build');

/* ------------------------------------------------------------------ */
/* PNG decode                                                          */
/* ------------------------------------------------------------------ */

function readPNG(file) {
  const buf = fs.readFileSync(file);
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== SIG[i]) throw new Error('not a PNG: ' + file);
  }

  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (bitDepth !== 8) throw new Error('only 8-bit PNGs are supported');
  if (interlace !== 0) throw new Error('interlaced PNGs are not supported');

  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('unsupported color type ' + colorType);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = channels;
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);

  // Undo the per-scanline filters (None / Sub / Up / Average / Paeth).
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let value = src[x];

      switch (filter) {
        case 0: break;
        case 1: value += a; break;
        case 2: value += b; break;
        case 3: value += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: throw new Error('bad PNG filter ' + filter);
      }
      cur[x] = value & 0xff;
    }
  }

  // Normalise to RGBA.
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, p = 0; i < width * height; i++, p += channels) {
    let r;
    let g;
    let b;
    let a = 255;
    if (channels === 4) { r = out[p]; g = out[p + 1]; b = out[p + 2]; a = out[p + 3]; }
    else if (channels === 3) { r = out[p]; g = out[p + 1]; b = out[p + 2]; }
    else if (channels === 2) { r = g = b = out[p]; a = out[p + 1]; }
    else { r = g = b = out[p]; }
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = a;
  }

  return { width, height, data: rgba };
}

/* ------------------------------------------------------------------ */
/* resize (bilinear, premultiplied so edges don't fringe)              */
/* ------------------------------------------------------------------ */

function resize(img, size) {
  const { width: sw, height: sh, data: src } = img;
  const dst = Buffer.alloc(size * size * 4);
  const scaleX = sw / size;
  const scaleY = sh / size;

  // Pre-multiply source alpha once.
  const pm = new Float64Array(sw * sh * 4);
  for (let i = 0; i < sw * sh; i++) {
    const a = src[i * 4 + 3] / 255;
    pm[i * 4] = src[i * 4] * a;
    pm[i * 4 + 1] = src[i * 4 + 1] * a;
    pm[i * 4 + 2] = src[i * 4 + 2] * a;
    pm[i * 4 + 3] = a;
  }

  for (let y = 0; y < size; y++) {
    const sy = Math.min(sh - 1, Math.max(0, (y + 0.5) * scaleY - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = sy - y0;

    for (let x = 0; x < size; x++) {
      const sx = Math.min(sw - 1, Math.max(0, (x + 0.5) * scaleX - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = sx - x0;

      const acc = [0, 0, 0, 0];
      for (let c = 0; c < 4; c++) {
        const p00 = pm[(y0 * sw + x0) * 4 + c];
        const p01 = pm[(y0 * sw + x1) * 4 + c];
        const p10 = pm[(y1 * sw + x0) * 4 + c];
        const p11 = pm[(y1 * sw + x1) * 4 + c];
        const top = p00 + (p01 - p00) * fx;
        const bot = p10 + (p11 - p10) * fx;
        acc[c] = top + (bot - top) * fy;
      }

      const a = acc[3];
      const o = (y * size + x) * 4;
      if (a <= 0.0001) {
        dst[o] = dst[o + 1] = dst[o + 2] = dst[o + 3] = 0;
      } else {
        dst[o] = Math.min(255, Math.round(acc[0] / a));
        dst[o + 1] = Math.min(255, Math.round(acc[1] / a));
        dst[o + 2] = Math.min(255, Math.round(acc[2] / a));
        dst[o + 3] = Math.min(255, Math.round(a * 255));
      }
    }
  }

  return { width: size, height: size, data: dst };
}

/* ------------------------------------------------------------------ */
/* PNG encode                                                          */
/* ------------------------------------------------------------------ */

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(img) {
  const { width, height, data } = img;
  const stride = width * 4;
  const rows = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    rows[y * (stride + 1)] = 0; // filter: none
    data.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/* ICO                                                                 */
/* ------------------------------------------------------------------ */

// Vista+ ICO container: PNG-compressed entries.
function encodeICO(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);           // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const img of images) {
    const png = encodePNG(img);
    const e = Buffer.alloc(16);
    e[0] = img.width >= 256 ? 0 : img.width;
    e[1] = img.height >= 256 ? 0 : img.height;
    e.writeUInt16LE(1, 4);              // planes
    e.writeUInt16LE(32, 6);             // bpp
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push({ entry: e, png });
  }

  return Buffer.concat([header, ...entries.map((x) => x.entry), ...entries.map((x) => x.png)]);
}

/* ------------------------------------------------------------------ */

if (!fs.existsSync(SOURCE)) {
  console.error('missing ' + SOURCE);
  console.error('assets/icon-source.png is the 512x512 transparent master; restore it from git.');
  process.exit(1);
}

const master = readPNG(SOURCE);
if (master.width !== master.height) {
  console.error('icon-source.png must be square, got ' + master.width + 'x' + master.height);
  process.exit(1);
}

fs.mkdirSync(OUT_ASSETS, { recursive: true });
fs.mkdirSync(OUT_BUILD, { recursive: true });

fs.writeFileSync(path.join(OUT_ASSETS, 'icon.png'), encodePNG(resize(master, 256)));
fs.writeFileSync(path.join(OUT_ASSETS, 'tray.png'), encodePNG(resize(master, 32)));
fs.writeFileSync(
  path.join(OUT_BUILD, 'icon.ico'),
  encodeICO([16, 24, 32, 48, 64, 128, 256].map((s) => resize(master, s)))
);

console.log('icons written from assets/icon-source.png:');
console.log('  assets/icon.png (256), assets/tray.png (32), build/icon.ico (16-256)');
