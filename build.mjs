import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('./', import.meta.url);
const upstream = JSON.parse(readFileSync(new URL('upstream.json', root), 'utf8'));
export const version = '0.1.3';

export function patch(source) {
  if (createHash('sha256').update(source).digest('hex') !== upstream.sha256) throw Error('Upstream SHA256 mismatch; review the new source before patching.');
  function replace(from, to) {
    if (source.split(from).length !== 2) throw Error('Patch boundary changed: ' + from.trim().slice(0, 80));
    source = source.replace(from, to);
  }
  replace('return !isNaN(qualitys) && qualitys <= filmix_max_qualitie;', 'return isFinite(qualitys) && qualitys > 0 && qualitys <= 2160 && (!low_quality || qualitys <= filmix_max_qualitie);');
  replace('return !isNaN(quality) && quality <= filmix_max_qualitie;', 'return isFinite(quality) && quality > 0 && quality <= 2160 && (!low_quality || quality <= filmix_max_qualitie);');
  for (const [owner, spaces] of [['element', 16], ['elem', 22]]) {
    for (const key of ['vast_url', 'vast_msg']) replace(' '.repeat(spaces) + key + ': ' + owner + '.' + key + ',\r\n', '');
  }
  for (const [from, to, count] of [
    ['Lampa.Player.play(first);', 'playClean(first);', 21],
    ['Lampa.Player.playlist(playlist);', 'playlistClean(playlist);', 21],
    ['Lampa.Player.playlist([first]);', 'playlistClean([first]);', 11],
  ]) {
    if (source.split(from).length - 1 !== count) throw Error('Player call sites changed; review the patch.');
    source = source.split(from).join(to);
  }
  const helpers = `
    var cleanPlaying, cleanQueue = [];
    function playClean(data) {
      var selected = Object.assign({}, data, { continue_play: true, online_mod_clean: true });
      delete selected.vast_url; delete selected.vast_msg;
      cleanPlaying = { request: data, selected: selected };
      // Lampa skips the preroll for a continued item already present in its playlist.
      cleanQueue = [selected];
      Lampa.Player.playlist(cleanQueue);
      Lampa.Player.play(selected);
    }
    function playlistClean(items) {
      cleanQueue = items.map(function (item) {
        item.online_mod_clean = true;
        return cleanPlaying && (item === cleanPlaying.request || (item.url === cleanPlaying.request.url && item.title === cleanPlaying.request.title)) ? cleanPlaying.selected : item;
      });
      Lampa.Player.playlist(cleanQueue);
    }
    function continueClean(event) {
      var data = event.data;
      if (!data || data.online_mod_clean !== true) return;
      data.continue_play = true;
      if (cleanQueue.indexOf(data) < 0) cleanQueue = [data];
      // Native next-episode handling clears PlayerPlaylist before calling Player.play.
      Lampa.Player.playlist(cleanQueue);
    }
`;
  replace('    var myIp =', helpers.replace(/\n/g, '\r\n') + '\r\n    var myIp =');
  replace('version: mod_version,', `version: '${version}',`);
  replace("name: Lampa.Lang.translate('online_mod_title_full') + ' - ' + mod_version,", "name: 'Online Mod Clean',");
  replace("    'use strict';", "    'use strict';\r\n    if (window.__onlineModClean) return;");
  replace('    startPlugin();', `    startPlugin();\r\n    Lampa.Player.listener.follow('create', continueClean);\r\n    window.__onlineModClean = { version: '${version}', upstream: '${upstream.commit}' };\r\n    Lampa.Params.select('online_mod_clean_version', { '${version}': '${version}' }, '${version}');\r\n    console.warn('Online Mod Clean ${version}: ready');`);
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
