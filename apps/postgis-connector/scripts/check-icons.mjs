import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const mark = await readFile(new URL('assets/postgis-mark.svg', root), 'utf8');
assert(mark.startsWith('<svg '), 'Logo must be UTF-8 SVG');
assert(Buffer.byteLength(mark) < 4096, 'Logo source must stay below 4 KiB');
assert(!/<(?:image|foreignObject)\b/.test(mark), 'Logo must remain self-contained vector artwork');
const expected = mark.replace('width="256" height="256"', 'width="1024" height="1024"');
assert.equal(await readFile(new URL('assets/icon.svg', root), 'utf8'), expected, 'Regenerate app icon from the one PostGIS source');
assert.equal(await readFile(new URL('assets/tray-template.svg', root), 'utf8'), mark.replaceAll(/#[0-9a-f]{6}/gi, '#000000'), 'Regenerate monochrome tray from the same source');
for (const [file, size] of [['32x32.png',32],['128x128.png',128],['128x128@2x.png',256],['icon.png',512],['tray/32x32.png',32]]) {
  const png = await readFile(new URL('src-tauri/icons/' + file, root));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), size); assert.equal(png.readUInt32BE(20), size);
  assert.equal(png[24], 8); assert.equal(png[25], 6, 'Tauri icon must have an alpha channel');
}
const config = JSON.parse(await readFile(new URL('src-tauri/tauri.conf.json', root), 'utf8'));
let bytes = 0;
for (const file of [...config.bundle.icon, 'icons/tray/32x32.png']) bytes += (await stat(new URL('src-tauri/' + file, root))).size;
assert(bytes < 512000, 'Configured desktop icons must stay below 512 KB combined');
console.log(JSON.stringify({ vectorBytes: Buffer.byteLength(mark), configuredIconBytes: bytes, displayPixels: '40x40', allChecksPassed: true }, null, 2));
