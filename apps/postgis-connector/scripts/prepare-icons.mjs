import { readFile, writeFile } from 'node:fs/promises';

// One vector source for the application, desktop icons and monochrome tray.
const mark = await readFile(new URL('../assets/postgis-mark.svg', import.meta.url), 'utf8');
const root = 'width="256" height="256"';
if (!mark.includes(root)) throw new Error('Unexpected PostGIS mark dimensions');
await writeFile(new URL('../assets/icon.svg', import.meta.url), mark.replace(root, 'width="1024" height="1024"'));
await writeFile(new URL('../assets/tray-template.svg', import.meta.url), mark.replaceAll(/#[0-9a-f]{6}/gi, '#000000'));
console.log('Prepared PostGIS app icon and monochrome tray mark.');
