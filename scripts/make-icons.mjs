// Draws the app icons (amber tile, dark diamond) without image tools, so they can be regenerated anywhere.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const ss = 4;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const acc = [0, 0, 0, 0];
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const p = pixel((x + (sx + .5) / ss) / size, (y + (sy + .5) / ss) / size);
      acc[0] += p[0] * p[3]; acc[1] += p[1] * p[3]; acc[2] += p[2] * p[3]; acc[3] += p[3];
    }
    const o = y * (size * 4 + 1) + 1 + x * 4, a = acc[3] / (ss * ss);
    raw[o] = a ? acc[0] / acc[3] : 0; raw[o + 1] = a ? acc[1] / acc[3] : 0; raw[o + 2] = a ? acc[2] / acc[3] : 0; raw[o + 3] = a;
  }
  const head = Buffer.alloc(13); head.writeUInt32BE(size, 0); head.writeUInt32BE(size, 4); head[8] = 8; head[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const inRounded = (u, v, inset, radius) => {
  const x = Math.min(Math.max(u, inset + radius), 1 - inset - radius), y = Math.min(Math.max(v, inset + radius), 1 - inset - radius);
  return u >= inset && v >= inset && u <= 1 - inset && v <= 1 - inset && (u - x) ** 2 + (v - y) ** 2 <= radius ** 2;
};
const inDiamond = (u, v, r) => Math.abs(u - .5) + Math.abs(v - .5) <= r;
const app = (u, v) => !inRounded(u, v, .08, .2) ? [0, 0, 0, 0] : inDiamond(u, v, .22) ? [16, 19, 29, 255] : [255, 207, 64, 255];
const tray = (color) => (u, v) => inDiamond(u, v, .44) && !inDiamond(u, v, .2) ? [...color, 255] : [0, 0, 0, 0];

mkdirSync('assets/icons', { recursive: true });
writeFileSync('assets/icons/icon.png', png(1024, app));
writeFileSync('assets/icons/tray.png', png(32, tray([255, 207, 64])));
writeFileSync('assets/icons/trayTemplate.png', png(16, tray([0, 0, 0])));
writeFileSync('assets/icons/trayTemplate@2x.png', png(32, tray([0, 0, 0])));
