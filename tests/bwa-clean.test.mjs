import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../bwa-clean.js', import.meta.url), 'utf8');

function events() {
  const listeners = new Map();
  return {
    follow(type, fn) { const list = listeners.get(type) || []; if (!list.includes(fn)) list.push(fn); listeners.set(type, list); },
    remove(type, fn) { listeners.set(type, (listeners.get(type) || []).filter(item => item !== fn)); },
    send(type, data = {}) { for (const fn of (listeners.get(type) || []).slice()) fn(data); },
    count(type) { return (listeners.get(type) || []).length; },
  };
}

function fixture({ ready = true, patched = true } = {}) {
  let queue = [], component = 'bwa_online';
  const ads = [], played = [], pending = [], defaults = {};
  const playerEvents = events(), queueEvents = events(), appEvents = events();
  const L = {
    Activity: { active: () => ({ component }) },
    Params: { select: (key, _, value) => { defaults[key] = value; } },
    Listener: appEvents,
    PlayerPlaylist: { listener: queueEvents, get: () => queue },
    Player: {
      listener: playerEvents,
      playlist(items) { queue = items; queueEvents.send('set', { playlist: items, position: 0 }); },
      play(data, delayed = false) {
        playerEvents.send('create', { data });
        const launch = () => {
          // Lampa IMA.getMediaType: continue_play plus exact membership, not merely URL equality.
          if (!(data.continue_play && queue.length && queue.indexOf(data) !== -1)) ads.push('lampa');
          if (data.vast_url) ads.push('vast');
          played.push(data);
          playerEvents.send('start', data);
          if (data.playlist?.length) L.Player.playlist(data.playlist);
        };
        if (delayed) pending.push(launch); else launch();
      },
    },
  };
  const window = { Lampa: L, appready: ready };
  const context = vm.createContext({ window, console, Object, Array });
  const run = () => new vm.Script(source).runInContext(context, { timeout: 1000 });
  if (patched) run();
  return {
    L, window, ads, played, defaults, playerEvents, queueEvents, appEvents, run,
    component(value) { component = value; },
    flush() { while (pending.length) pending.shift()(); },
    next(index) {
      const saved = queue, item = saved[index];
      queue = []; playerEvents.send('destroy');
      item.continue_play = true;
      L.Player.play(item, true);
      L.Player.playlist(saved);
    },
  };
}

function video(extra = {}) {
  return { title: 'Film', url: 'https://media.invalid/1080.m3u8', vast_url: 'https://ads.invalid/vast.xml', vast_msg: 'Advert', ...extra };
}

test('the unpatched boundary exposes both ad paths', () => {
  const f = fixture({ patched: false }); f.L.Player.play(video());
  assert.deepEqual(f.ads, ['lampa', 'vast']);
});

test('BWA movie strips VAST and skips the Lampa preroll, preserving media options', () => {
  const f = fixture(), data = video({ subtitles: [{ url: 'https://media.invalid/sub.vtt' }], headers: { Referer: 'https://api.invalid/' }, quality: { '720p': 'https://media.invalid/720.m3u8', '1080p': 'https://media.invalid/1080.m3u8' }, timeline: { time: 123 } });
  const original = { ...data };
  f.L.Player.play(data, true);
  f.L.Player.playlist([video({ ...original, title: 'Film without voice suffix' })]);
  f.flush();
  assert.deepEqual(f.ads, []); assert.equal(f.played[0], data);
  for (const key of ['url', 'subtitles', 'headers', 'quality', 'timeline']) assert.equal(data[key], original[key]);
  assert.equal(data.vast_url, undefined); assert.equal(data.vast_msg, undefined);
  assert.ok(f.L.PlayerPlaylist.get().includes(data));
});

test('post-play quality selection still maps the unique movie queue entry', () => {
  const f = fixture(), data = video({ quality: { '720p': 'https://media.invalid/720.m3u8' } });
  f.L.Player.play(data, true);
  data.url = data.quality['720p'];
  f.L.Player.playlist([video({ quality: data.quality })]); f.flush();
  assert.deepEqual(f.ads, []); assert.equal(f.L.PlayerPlaylist.get()[0], data);
});

test('series preserves callbacks, lazy URLs, ordering and serializable native-player data', () => {
  const f = fixture(), callback = () => {}, lazy = () => { throw Error('must not resolve eagerly'); };
  const first = video({ season: 1, episode: 1, callback }), next = video({ title: 'Episode 2', season: 1, episode: 2, url: lazy });
  const original = [first, next], data = video({ season: 1, episode: 1, playlist: original });
  f.L.Player.play(data, true); f.L.Player.playlist(original); f.flush();
  const queue = f.L.PlayerPlaylist.get();
  assert.deepEqual(f.ads, []); assert.equal(queue.length, 2); assert.equal(queue[0], data); assert.equal(queue[1], next);
  assert.equal(data.callback, callback); assert.equal(next.url, lazy);
  assert.equal(first.vast_url, undefined); assert.equal(next.vast_url, undefined);
  assert.doesNotThrow(() => JSON.stringify(data)); assert.equal(original[0], first);
});

test('native next episode skips ads after destroy clears the playlist, even outside the BWA screen', () => {
  const f = fixture(), first = video({ season: 1, episode: 1 }), second = video({ season: 1, episode: 2, url: 'https://media.invalid/e2.m3u8' });
  f.L.Player.play(first); f.L.Player.playlist([first, second]);
  f.component('main'); f.next(1); f.flush();
  assert.deepEqual(f.ads, []); assert.equal(f.played.at(-1), second);
  assert.equal(f.L.PlayerPlaylist.get().length, 2); assert.ok(f.L.PlayerPlaylist.get().includes(second));
});

test('unrelated playback and queue keep their original ads and fields', () => {
  const f = fixture(); f.L.Player.play(video());
  f.component('other');
  const item = video({ title: 'Other plugin' }), before = { ...item }, queue = [item];
  f.L.Player.playlist(queue); f.L.Player.play(item);
  assert.deepEqual(item, before); assert.equal(f.L.PlayerPlaylist.get(), queue);
  assert.deepEqual(f.ads, ['lampa', 'vast']);
});

test('ambiguous or unknown queue identities are never guessed', () => {
  const f = fixture(), data = video(); f.L.Player.play(data);
  const a = video(), b = video(), queue = [a, b];
  f.L.Player.playlist(queue);
  assert.equal(f.L.PlayerPlaylist.get(), queue); assert.equal(queue[0], a); assert.equal(queue[1], b);
  const other = [video({ url: 'https://media.invalid/different.m3u8' })];
  f.L.Player.playlist(other); assert.equal(f.L.PlayerPlaylist.get(), other);
});

test('appready, duplicate loading and stop own exactly their listeners', () => {
  const f = fixture({ ready: false }), play = f.L.Player.play, playlist = f.L.Player.playlist; f.run();
  assert.equal(f.playerEvents.count('create'), 0); assert.equal(f.appEvents.count('app'), 1);
  f.appEvents.send('app', { type: 'ready' }); f.appEvents.send('app', { type: 'ready' }); f.run();
  assert.equal(f.playerEvents.count('create'), 1); assert.equal(f.queueEvents.count('set'), 1);
  assert.equal(f.defaults.bwa_clean_version, '0.1.0');
  assert.equal(f.L.Player.play, play); assert.equal(f.L.Player.playlist, playlist);
  const foreign = () => {}; f.playerEvents.follow('create', foreign);
  f.window.__bwaClean.stop();
  assert.equal(f.playerEvents.count('create'), 1); assert.equal(f.queueEvents.count('set'), 0); assert.equal(f.appEvents.count('app'), 0);
  assert.equal(f.window.__bwaClean, undefined);
});

test('the public companion URL keeps appended Lampa account data in the fragment', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const install = readme.match(/https:\/\/krajcik\.github\.io\/lampa-online-mod\/bwa-clean\.js\?v=[^\s]+/)[0];
  const request = new URL(install + '&email=DUMMY&logged=true');
  assert.equal(request.search, '?v=0.1.0'); assert.match(request.hash, /email=DUMMY/);
});
