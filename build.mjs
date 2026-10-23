import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('./', import.meta.url);
const upstream = JSON.parse(readFileSync(new URL('upstream.json', root), 'utf8'));
export const version = '0.1.0';

export function patch(source) {
  if (createHash('sha256').update(source).digest('hex') !== upstream.sha256) throw Error('Upstream SHA256 mismatch; review the new source before patching.');
  function replace(from, to) {
    if (source.split(from).length !== 2) throw Error('Patch boundary changed: ' + from.trim().slice(0, 80));
    source = source.replace(from, to);
  }
  replace('return !isNaN(qualitys) && qualitys <= filmix_max_qualitie;', 'return !isNaN(qualitys) && (!low_quality || qualitys <= filmix_max_qualitie);');
  replace('return !isNaN(quality) && quality <= filmix_max_qualitie;', 'return !isNaN(quality) && (!low_quality || quality <= filmix_max_qualitie);');
  for (const [owner, spaces] of [['element', 16], ['elem', 22]]) {
    for (const key of ['vast_url', 'vast_msg']) replace(' '.repeat(spaces) + key + ': ' + owner + '.' + key + ',\r\n', '');
  }
  replace("    'use strict';", "    'use strict';\r\n    if (window.__onlineModClean) return;");
  replace('    startPlugin();', `    startPlugin();\r\n    window.__onlineModClean = { version: '${version}', upstream: '${upstream.commit}' };\r\n    Lampa.Manifest.plugins.name = 'Online Mod Clean';\r\n    Lampa.Manifest.plugins.version = '${version}';\r\n    console.warn('Online Mod Clean ${version}: ready');`);
  return source.replace(/\r\n/g, '\n');
}

async function build() {
  const cache = new URL('.cache/upstream.js', root);
  if (!existsSync(cache)) {
    const response = await fetch(upstream.url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Error('Upstream HTTP ' + response.status);
    const source = await response.text();
    patch(source);
    mkdirSync(new URL('.cache/', root), { recursive: true });
    writeFileSync(cache, source);
  }
  const source = patch(readFileSync(cache, 'utf8'));
  const output = new URL('online_mod.js', root), temporary = new URL('online_mod.js.tmp', root);
  writeFileSync(temporary, source); renameSync(temporary, output);
  console.log(`Online Mod Clean ${version}: ${Buffer.byteLength(source)} bytes`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await build();
