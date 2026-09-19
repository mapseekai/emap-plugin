import { readFile, writeFile } from 'node:fs/promises';

// One vector source for the in-app logo and square desktop icon.
// Preserve generous safe area so the EC terminals are not cropped at 16–32 px.
const source = new URL('../assets/ec-mark.svg', import.meta.url);
const mark = await readFile(source, 'utf8');
const root = 'width="230" height="154" viewBox="14 52 230 154"';
if (!mark.includes(root)) throw new Error('Unexpected EC mark dimensions');
const icon = mark.replace(root, 'width="1024" height="1024" viewBox="0 0 256 256"');
await writeFile(new URL('../assets/icon.svg', import.meta.url), icon);
const outline = mark.match(/<path id="ec-shape"[^>]*\bd="([^"]+)"/);
if (!outline) throw new Error('EC silhouette missing');
const template = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><path fill="#000" fill-rule="evenodd" d="${outline[1]}"/></svg>\n`;
await writeFile(new URL('../assets/tray-template.svg', import.meta.url), template);
console.log('Prepared square EC app icon and single-color tray silhouette.');
