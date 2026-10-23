import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { providerFixture } from './provider-fixture.mjs';
import { version } from '../build.mjs';

const source = readFileSync(new URL('../online_mod.js', import.meta.url), 'utf8');
const film = { player_links: { movie: { voice: { translation: 'Voice', link: 'https://media.invalid/movie_[480,720,1080,2160].mp4' } } } };
const serial = { player_links: { playlist: { 1: { Voice: { 1: { link: 'https://media.invalid/s1e1_%s.mp4', qualities: [480, 720, 1080, 2160] }, 2: { link: 'https://media.invalid/s1e2_%s.mp4', qualities: [480, 1080] } } } } } };

for (const [name, response] of [['movie', film], ['series', serial]]) {
  test(`Filmix ${name} keeps server-declared qualities without inventing variants or a premium account`, () => {
    const f = providerFixture(source, { response }); f.filmix(); f.play();
    assert.equal(f.sandbox.window.mod_filmix.max_qualitie, 480);
    assert.deepEqual(Object.keys(f.played[0].quality).sort(), ['1080p', '2160p', '480p', '720p']);
    assert.match(f.played[0].url, /2160\.mp4$/);
    if (name === 'series') { const list = f.playlists.at(-1); assert.equal(list.length, 2); assert.deepEqual(Object.keys(list[1].quality).sort(), ['1080p', '480p']); }
    assert.equal(f.played[0].continue_play, true);
    assert.ok(f.beforePlay[0].includes(f.played[0]));
    assert.ok(f.sandbox.Lampa.PlayerPlaylist.get().includes(f.played[0]));
  });
}

test('Filmix preserves its explicit low-quality fallback after a failed normal request', () => {
  const f = providerFixture(source, { response: film, failFirst: true, abuse: true }); f.filmix(); f.play();
  assert.deepEqual(Object.keys(f.played[0].quality), ['480p']);
  assert.match(f.played[0].url, /480\.mp4$/);
});

test('Filmix does not synthesize 4K when the response has no declared quality variants', () => {
  const f = providerFixture(source, { response: { player_links: { movie: { voice: { translation: 'Voice', link: 'https://media.invalid/480.mp4' } } } } }); f.filmix(); f.play();
  assert.equal(f.played[0].url, 'https://media.invalid/480.mp4'); assert.deepEqual(Object.keys(f.played[0].quality), []);
});

for (const isSeries of [false, true]) {
  test(`Lumex Ads ${isSeries ? 'series' : 'movie'} leaves VAST out of play and playlist options`, () => {
    const media = { url: 'https://api.invalid/item', title: 'Fixture', season: 1, episode: 1, subtitles: [{ label: 'English', url: 'https://media.invalid/sub.vtt' }], vast_url: 'https://ads.invalid/pre.xml', vast_msg: 'advert' };
    const response = { folder: isSeries ? { Voice: { 1: [media, { ...media, episode: 2 }] } } : [media] };
    const f = providerFixture(source, { response }); f.lumex(); f.play();
    assert.equal(f.played.length, 1); assert.equal(f.played[0].vast_url, undefined); assert.equal(f.played[0].vast_msg, undefined);
    assert.equal(f.played[0].subtitles[0].url, 'https://media.invalid/sub.vtt');
    const list = f.playlists.at(-1);
    for (const item of list) { assert.equal(item.vast_url, undefined); assert.equal(item.vast_msg, undefined); }
    assert.equal(f.played[0].continue_play, true); assert.ok(f.beforePlay[0].includes(f.played[0])); assert.ok(list.includes(f.played[0]));
    if (isSeries) { const next = list[1]; let resolved = false; next.url(() => { resolved = true; }); assert.equal(resolved, true); assert.equal(next.url, 'https://media.invalid/2160.m3u8'); assert.equal(next.vast_url, undefined); }
  });
}

test('a server refusal remains an error without playback or additional requests', () => {
  const f = providerFixture(source, { response: film, deny: true });
  assert.throws(() => f.filmix(), /fixture error/);
  assert.equal(f.played.length, 0); assert.equal(f.calls.length, 1);
});

test('the clean build is identifiable and does not initialize twice', () => {
  const f = providerFixture(source); const providers = f.sandbox.providers;
  assert.equal(f.sandbox.window.__onlineModClean.version, version);
  assert.equal(f.sandbox.Lampa.Params.defaults.online_mod_clean_version, version);
  f.run(); assert.equal(f.sandbox.providers, providers);
});

test('native series continuation recovers its queue after the player destroys the previous video', () => {
  const f = providerFixture(source, { response: serial }); f.filmix(); f.play();
  f.next(1);
  assert.equal(f.played.length, 2);
  assert.ok(f.beforePlay[1].includes(f.played[1]));
  assert.equal(f.beforePlay[1].length, 2);
});

test('the continuation hook leaves unrelated player requests and their queue alone', () => {
  const f = providerFixture(source);
  const queue = [{ url: 'https://other.invalid/a.mp4' }], unrelated = { url: 'https://other.invalid/b.mp4' };
  f.sandbox.Lampa.Player.playlist(queue); f.sandbox.Lampa.Player.play(unrelated);
  assert.equal(unrelated.continue_play, undefined);
  assert.equal(f.sandbox.Lampa.PlayerPlaylist.get(), queue);
});
