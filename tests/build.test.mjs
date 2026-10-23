import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { patch } from '../build.mjs';

test('build is pinned, reproducible and refuses an unreviewed upstream', () => {
  const original = readFileSync(new URL('../.cache/upstream.js', import.meta.url), 'utf8');
  const shipped = readFileSync(new URL('../online_mod.js', import.meta.url), 'utf8');
  assert.equal(patch(original), shipped);
  assert.throws(() => patch(original + '\n'), /SHA256 mismatch/);
  assert.throws(() => patch(shipped), /SHA256 mismatch/);
});

test('the documented installation URL keeps Lampa account parameters out of the HTTP query', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const install = readme.match(/https:\/\/krajcik\.github\.io\/lampa-online-mod\/online_mod\.js\?v=[^\s]+/)[0];
  const request = new URL(install + '&email=DUMMY&logged=true&origin=DUMMY');
  assert.equal(request.search, '?v=0.1.0'); assert.match(request.hash, /email=DUMMY/);
});
