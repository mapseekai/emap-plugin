import { cp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = resolve(root, 'native-service/Cargo.toml');
execFileSync('cargo', ['build', '--manifest-path', manifest, '--release', '--locked'], { stdio: 'inherit' });
const out = resolve(root, 'dist/service');
await rm(out, { recursive: true, force: true }); await mkdir(out, { recursive: true });
const name = 'emap-connector-service' + (process.platform === 'win32' ? '.exe' : '');
await cp(resolve(root, 'native-service/target/release', name), resolve(out, name));
// Keep legally required notices, but no npm modules, Node, WASM or debug/type assets.
// Also include the native shell's transitive notices. Deduplicate identical license text.
const notices = new Map(); const texts = new Map();
for (const cargoManifest of [manifest, resolve(root, 'src-tauri/Cargo.toml')]) {
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--manifest-path', cargoManifest, '--locked', '--format-version', '1'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
  const nodes = new Map(metadata.resolve.nodes.map(n => [n.id, n]));
  const shipped = new Set();
  function visit(id) {
    if (shipped.has(id)) return; shipped.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) {
      if (dep.dep_kinds.some(k => k.kind === null)) visit(dep.pkg);
    }
  }
  visit(metadata.resolve.root);
  for (const pkg of metadata.packages.filter(p => shipped.has(p.id))) {
    const directory = dirname(pkg.manifest_path);
    const candidates = (await readdir(directory)).filter(n => /^(LICENSE|LICENCE|COPYING|NOTICE)(\..*)?$/i.test(n)).map(n => resolve(directory,n));
    if (pkg.license_file) candidates.push(resolve(directory,pkg.license_file));
    if (pkg.name === 'pg_query') candidates.push(resolve(directory,'libpg_query/LICENSE'));
    const refs = [];
    for (const path of [...new Set(candidates)]) {
      try {
        const text = (await readFile(path,'utf8')).trim();
        if (!texts.has(text)) texts.set(text,texts.size+1);
        refs.push(texts.get(text));
      } catch { /* A license-file directory is not a notice document. */ }
    }
    notices.set(pkg.id,{name:pkg.name,version:pkg.version,license:pkg.license,notices:[...new Set(refs)]});
  }
}
let document = 'emap Connector — third-party notices\n\n';
for (const n of [...notices.values()].sort((a,b)=>a.name.localeCompare(b.name))) document += `${n.name} ${n.version} | ${n.license ?? 'See license text'} | notices ${n.notices.join(', ')}\n`;
for (const [text,id] of texts) document += `\n========== NOTICE ${id} ==========\n${text}\n`;
await writeFile(resolve(out,'THIRD-PARTY-NOTICES.txt'),document);
await writeFile(resolve(out,'runtime-dependencies.json'),JSON.stringify([...notices.values()],null,2)+'\n');
console.log('Built native service; Node, npm modules and SQL-parser WASM are not shipped.');
