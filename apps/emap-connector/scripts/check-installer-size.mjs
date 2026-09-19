import { readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Decimal MB: an installer must be strictly smaller than 10,000,000 bytes.
const limit = 10_000_000;
const root = fileURLToPath(new URL('../src-tauri/target/release/bundle/', import.meta.url));
const formats = { dmg: /\.dmg$/i, nsis: /\.exe$/i, msi: /\.msi$/i,
  deb: /\.deb$/i, rpm: /\.rpm$/i, appimage: /\.AppImage$/i };
const results = [];
for (const [directory, extension] of Object.entries(formats)) {
  let names;
  try { names = await readdir(resolve(root, directory)); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  for (const name of names.filter(name => extension.test(name))) {
    const info = await stat(resolve(root, directory, name));
    if (!info.isFile()) continue;
    results.push({ file: `${directory}/${name}`, bytes: info.size,
      MB: (info.size / 1_000_000).toFixed(2), passed: info.size < limit });
  }
}
console.table(results);
if (!results.length || results.some(result => !result.passed)) {
  console.error('Installer size gate FAILED: every installer must be < 10,000,000 bytes.');
  process.exitCode = 1;
} else console.log('Installer size gate passed.');
