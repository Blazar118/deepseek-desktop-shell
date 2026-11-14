// Generates the shell's own icons (no downloaded art, no external assets).
//   assets/icon.png  256x256 window/tray-adjacent icon
//   assets/tray.png   32x32 tray icon
//   build/icon.ico   multi-size Windows icon used by electron-builder
//
// Kept dependency-free so `npm install` stays light.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const OUT_ASSETS = path.join(ROOT, 'assets');
const OUT_BUILD = path.join(ROOT, 'build');

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

// Simple rounded-square "chat bubble" mark: blue gradient bg + white bubble.
function drawRGBA(size) {
  const px = Buffer.alloc(size * size * 4);
  const r = size * 0.22;              // corner radius of the plate
  const cx = size / 2;
  const cy = size / 2;

  const inRoundRect = (x, y, x0, y0, x1, y1, rad) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const dx = x < x0 + rad ? x0 + rad - x : x > x1 - rad ? x - (x1 - rad) : 0;
    const dy = y < y0 + rad ? y0 + rad - y : y > y1 - rad ? y - (y1 - rad) : 0;
    return dx * dx + dy * dy <= rad * rad;
  };

  const bubble = {
    x0: size * 0.20, y0: size * 0.24,
    x1: size * 0.80, y1: size * 0.68,
    rad: size * 0.16,
  };
  const tail = { x: size * 0.50, y: size * 0.78, w: size * 0.13 };
  const dotR = size * 0.038;
  const dots = [size * 0.35, size * 0.50, size * 0.65].map((x) => ({ x, y: size * 0.46 }));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const px0 = x + 0.5;
      const py0 = y + 0.5;

      if (!inRoundRect(px0, py0, 0, 0, size, size, r)) {
        px[i + 3] = 0; // transparent outside the plate
        continue;
      }

      // Diagonal gradient #4D6BFE -> #2B3FD8
      const t = (px0 / size + py0 / size) / 2;
      px[i] = Math.round(0x4d * (1 - t) + 0x2b * t);
      px[i + 1] = Math.round(0x6b * (1 - t) + 0x3f * t);
      px[i + 2] = Math.round(0xfe * (1 - t) + 0xd8 * t);
      px[i + 3] = 255;

      // White chat bubble
      let white = inRoundRect(px0, py0, bubble.x0, bubble.y0, bubble.x1, bubble.y1, bubble.rad);
      // little tail triangle under the bubble
      if (!white) {
        const ty = tail.y;
        const half = tail.w * (py0 - (bubble.y1 - size * 0.02)) / (ty - (bubble.y1 - size * 0.02));
        if (py0 <= ty && py0 >= bubble.y1 - size * 0.02 && Math.abs(px0 - cx) <= Math.max(0, half)) {
          white = true;
        }
      }
      if (white) {
        px[i] = 255; px[i + 1] = 255; px[i + 2] = 255; px[i + 3] = 255;
      }

      // Dots punched back to brand blue
      for (const d of dots) {
        const dx = px0 - d.x;
        const dy = py0 - d.y;
        if (dx * dx + dy * dy <= dotR * dotR) {
          px[i] = 0x4d; px[i + 1] = 0x6b; px[i + 2] = 0xfe; px[i + 3] = 255;
        }
      }
    }
  }
  return px;
}

function png(size) {
  const raw = drawRGBA(size);
  const stride = size * 4;
  const rows = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    rows[y * (stride + 1)] = 0; // filter: none
    raw.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ICO container with PNG-compressed entries (Vista+ format).
function ico(sizes) {
  const images = sizes.map((s) => ({ size: s, data: png(s) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);            // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const img of images) {
    const e = Buffer.alloc(16);
    e[0] = img.size >= 256 ? 0 : img.size;
    e[1] = img.size >= 256 ? 0 : img.size;
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4);               // planes
    e.writeUInt16LE(32, 6);              // bpp
    e.writeUInt32LE(img.data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += img.data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

fs.mkdirSync(OUT_ASSETS, { recursive: true });
fs.mkdirSync(OUT_BUILD, { recursive: true });

fs.writeFileSync(path.join(OUT_ASSETS, 'icon.png'), png(256));
fs.writeFileSync(path.join(OUT_ASSETS, 'tray.png'), png(32));
fs.writeFileSync(path.join(OUT_BUILD, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256]));

console.log('icons written: assets/icon.png, assets/tray.png, build/icon.ico');
