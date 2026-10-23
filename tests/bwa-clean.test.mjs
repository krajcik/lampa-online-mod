import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(process.env.BWA_CLEAN_SOURCE || new URL('../bwa-clean.js', import.meta.url), 'utf8');

function events() {
  const listeners = new Map();
  return {
    follow(type, fn) { const list = listeners.get(type) || []; if (!list.includes(fn)) list.push(fn); listeners.set(type, list); },
    remove(type, fn) { listeners.set(type, (listeners.get(type) || []).filter(item => item !== fn)); },
    send(type, data = {}) { for (const fn of (listeners.get(type) || []).slice()) fn(data); },
    count(type) { return (listeners.get(type) || []).length; },
  };
}

function fixture({ ready = true, patched = true, quality = false } = {}) {
  let queue = [], activity = { component: 'bwa_online' }, timerId = 0;
  const values = new Map(), timers = new Map();
  const ads = [], played = [], pending = [], defaults = {}, manifests = [];
  const playerEvents = events(), queueEvents = events(), appEvents = events();
  const preferred = 'https://media.invalid/master.m3u8', low = 'https://media.invalid/sd.m3u8';
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1072,CODECS="avc1.640028,mp4a.40.2"\n1080.m3u8\n#EXT-X-STREAM-INF:RESOLUTION=1280x714,CODECS="avc1.640028,mp4a.40.2"\n720.m3u8';
  const requests = [], resolveCalls = [], network = { clears: 0,
    get(url, ok) { ok(url === preferred ? master : '#EXTM3U\n#EXTINF:6,\nsegment.ts'); },
  };
  const bwa = { resolveEpisodeLink(season, episode, callback) { resolveCalls.push([season, episode]); callback(preferred, { '1080p': preferred }); } };
  if (quality) activity.activity = { component: bwa };
  const L = {
    Manifest: Object.defineProperty({}, 'plugins', { get: () => manifests, set: value => manifests.push(value) }),
    Activity: { active: () => activity },
    Storage: { get: (key, fallback) => values.has(key) ? values.get(key) : fallback, set: (key, value) => values.set(key, value) },
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
  if (quality) L.Reguest = function () {
    this.silent = (url, ...args) => { requests.push(url); network.get(url, ...args); };
    this.clear = () => { network.clears++; };
  };
  const window = { Lampa: L, appready: ready, MediaSource: { isTypeSupported: () => true } };
  const context = vm.createContext({ window, console, Object, Array, URL,
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); },
  });
  const run = () => new vm.Script(source).runInContext(context, { timeout: 1000 });
  if (patched) run();
  return {
    L, window, ads, played, defaults, playerEvents, queueEvents, appEvents, run,
    values, timers, preferred, low, master, bwa, network, requests, resolveCalls,
    component(value) { activity = { component: value }; },
    expire() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
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
  assert.equal(f.defaults.bwa_clean_version, '0.2.0');
  assert.equal(f.L.Manifest.plugins.length, 1); assert.equal(f.L.Manifest.plugins[0].name, 'BWA Clean');
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
  assert.equal(request.search, '?v=0.2.0'); assert.match(request.hash, /email=DUMMY/);
});

function lazyFallback(f, extra = {}) {
  const item = video({ season: 1, episode: 2, timeline: { time: 123 }, ...extra });
  const original = function (callback) {
    assert.equal(this, item);
    this.url = f.low; this.quality = { '1080p': f.low };
    callback('resolved');
  };
  item.url = original;
  f.L.Player.play(video({ season: 1, episode: 1 }));
  f.L.Player.playlist([f.played[0], item]);
  return { item, original };
}

test('auto-next refreshes a cached static fallback to the preferred HD master once', () => {
  const f = fixture({ quality: true }), { item } = lazyFallback(f);
  const timeline = item.timeline, headers = { Referer: 'https://media.invalid/' }; item.headers = headers;
  let callbacks = 0;
  item.url.call(item, value => { assert.equal(value, 'resolved'); callbacks++; });
  assert.equal(item.url, f.preferred);
  assert.equal(item.quality['1080p'], f.preferred);
  assert.equal(callbacks, 1); assert.deepEqual(f.resolveCalls, [[1, 2]]);
  assert.deepEqual(f.requests, [f.preferred, f.low]);
  assert.equal(item.timeline, timeline); assert.equal(item.headers, headers);
  assert.equal(item.vast_url, undefined); assert.equal(f.window.__bwaClean.repairs, 1);
  assert.match(f.values.get('bwa_clean_quality'), /repaired=1;last=hd-master/);
  assert.equal(f.timers.size, 0);
});

test('an existing HD master is preserved even when ABR is currently showing SD', () => {
  const f = fixture({ quality: true }), { item } = lazyFallback(f);
  f.network.get = (_, ok) => ok(f.master);
  let callbacks = 0; item.url(() => callbacks++);
  assert.equal(item.url, f.low); assert.equal(callbacks, 1);
  assert.equal(f.window.__bwaClean.repairs, 0); assert.equal(f.timers.size, 0);
});

test('unsupported codecs are kept on the original compatible fallback', () => {
  const f = fixture({ quality: true }), { item } = lazyFallback(f);
  f.window.MediaSource.isTypeSupported = () => false;
  let callbacks = 0; item.url(() => callbacks++);
  assert.equal(item.url, f.low); assert.equal(callbacks, 1); assert.equal(f.requests.length, 1);
  assert.equal(f.window.__bwaClean.repairs, 0);
});

test('no HD master, invalid response and failed reads keep the original playback', () => {
  for (const response of ['#EXTM3U\n#EXTINF:6,\nfile.ts', '<html>error</html>', null, 'error']) {
    const f = fixture({ quality: true }), { item } = lazyFallback(f);
    f.network.get = (_, ok, error) => response === 'error' ? error() : ok(response);
    let callbacks = 0; item.url(() => callbacks++);
    assert.equal(item.url, f.low); assert.equal(callbacks, 1);
    assert.equal(f.window.__bwaClean.repairs, 0); assert.equal(f.timers.size, 0);
  }
});

test('a timed-out lookup resumes fallback once and ignores late results', () => {
  const f = fixture({ quality: true }), { item } = lazyFallback(f);
  let reply; f.bwa.resolveEpisodeLink = (_, __, callback) => { reply = callback; };
  let callbacks = 0; item.url(() => callbacks++); assert.equal(callbacks, 0);
  f.expire(); assert.equal(callbacks, 1); assert.equal(item.url, f.low);
  reply(f.preferred, { '1080p': f.preferred });
  assert.equal(callbacks, 1); assert.equal(item.url, f.low); assert.equal(f.requests.length, 0);
});

test('credential URLs and cross-origin playback headers are not used for quality probes', () => {
  for (const url of ['https://user:secret@media.invalid/master.m3u8', 'https://other.invalid/master.m3u8']) {
    const f = fixture({ quality: true }), { item } = lazyFallback(f);
    item.headers = { Authorization: 'private' };
    f.bwa.resolveEpisodeLink = (_, __, callback) => callback(url);
    let callbacks = 0; item.url(() => callbacks++);
    assert.equal(callbacks, 1); assert.equal(item.url, f.low); assert.equal(f.requests.length, 0);
  }
});

test('leaving the activity, changing source or starting new playback discards stale repair callbacks', () => {
  for (const change of ['activity', 'source', 'play', 'destroy']) {
    const f = fixture({ quality: true }), { item } = lazyFallback(f);
    let reply; f.bwa.resolveEpisodeLink = (_, __, callback) => { reply = callback; };
    let callbacks = 0; item.url(() => callbacks++);
    if (change === 'activity') f.component('other');
    if (change === 'source') f.values.set('bwa_balanser', 'other');
    if (change === 'play') f.L.Player.play(video());
    if (change === 'destroy') f.playerEvents.send('destroy');
    reply(f.preferred, { '1080p': f.preferred });
    assert.equal(callbacks, 0); assert.equal(item.url, f.low); assert.equal(f.timers.size, 0);
  }
});

test('stop releases pending checks and restores unresolved URL functions', () => {
  const f = fixture({ quality: true }), a = lazyFallback(f), b = lazyFallback(f);
  f.L.Player.playlist([f.played[0], a.item, b.item]);
  let reply; f.bwa.resolveEpisodeLink = (_, __, callback) => { reply = callback; };
  let callbacks = 0; a.item.url(() => callbacks++);
  assert.notEqual(b.item.url, b.original);
  f.window.__bwaClean.stop();
  assert.equal(callbacks, 1); assert.equal(b.item.url, b.original); assert.equal(f.timers.size, 0);
  reply(f.preferred); assert.equal(callbacks, 1); assert.equal(a.item.url, f.low);
});

test('a newer episode selection wins over an outstanding quality lookup', () => {
  const f = fixture({ quality: true }), a = lazyFallback(f), b = lazyFallback(f, { episode: 3 });
  f.L.Player.playlist([f.played[0], a.item, b.item]);
  const replies = []; f.bwa.resolveEpisodeLink = (_, __, callback) => replies.push(callback);
  let first = 0, second = 0;
  a.item.url(() => first++); b.item.url(() => second++);
  replies[0](f.preferred); replies[1](f.preferred);
  assert.equal(first, 0); assert.equal(second, 1); assert.equal(b.item.url, f.preferred);
  assert.equal(f.timers.size, 0);
});

test('duplicate resolver responses do not duplicate probes or continuations', () => {
  const f = fixture({ quality: true }), { item } = lazyFallback(f);
  let response; f.network.get = (_, ok) => { response = ok; };
  f.bwa.resolveEpisodeLink = (_, __, callback) => { callback(f.preferred); callback(f.preferred); };
  let calls = 0; item.url(() => calls++);
  assert.equal(f.requests.length, 1);
  response(f.master); response('#EXTM3U\n#EXTINF:6,\nseg.ts');
  assert.equal(calls, 1); assert.equal(f.timers.size, 0);
});
