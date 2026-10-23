// SPDX-License-Identifier: MIT
(function () {
  'use strict';
  if (window.__bwaClean || !window.Lampa) return;
  var L = window.Lampa, selected = null;
  var state = { version: '0.1.0', ready: false, stop: stop };
  window.__bwaClean = state;

  function inBwa() {
    var activity = L.Activity.active();
    return activity && activity.component === 'bwa_online';
  }

  function clean(item) {
    if (!item || typeof item !== 'object') return;
    delete item.vast_url;
    delete item.vast_msg;
    item.bwa_clean_item = true;
    item.continue_play = true;
  }

  function matches(item) {
    if (!item || typeof item !== 'object') return false;
    if (selected.season != null && selected.episode != null) {
      return item.season === selected.season && item.episode === selected.episode;
    }
    if (typeof selected.url !== 'string') return false;
    return item.url === selected.url || (item.quality && Object.keys(item.quality).some(function (key) {
      return item.quality[key] === selected.url;
    }));
  }

  function onSet(event) {
    var items = event.playlist;
    if (!selected || !Array.isArray(items) || !items.length) return;
    if (!inBwa() && !items.some(function (item) { return item && item.bwa_clean_item === true; })) return;
    items.forEach(clean);
    if (items.indexOf(selected) !== -1) return;
    var indexes = [];
    items.forEach(function (item, index) { if (matches(item)) indexes.push(index); });
    if (indexes.length !== 1) return;
    var previous = items[indexes[0]];
    Object.keys(previous).forEach(function (key) {
      if (!(key in selected)) selected[key] = previous[key];
    });
    // A separate array avoids a cycle through selected.playlist in native-player JSON.
    var queue = items.slice();
    queue[indexes[0]] = selected;
    L.Player.playlist(queue);
  }

  function onCreate(event) {
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.bwa_clean_item !== true && !inBwa()) { selected = null; return; }
    selected = data;
    clean(data);
    if (Array.isArray(data.playlist)) data.playlist.forEach(clean);
    // Lampa's continuation check requires the exact object in PlayerPlaylist.
    L.Player.playlist([data]);
  }

  function onDestroy() { selected = null; }

  function install() {
    if (state.ready) return;
    if (!L.Player || !L.Player.listener || !L.PlayerPlaylist || !L.PlayerPlaylist.listener || !L.Params || !L.Params.select) {
      console.error('BWA Clean: unsupported player API');
      return;
    }
    L.Player.listener.follow('create', onCreate);
    L.Player.listener.follow('destroy', onDestroy);
    L.PlayerPlaylist.listener.follow('set', onSet);
    L.Params.select('bwa_clean_version', { '0.1.0': '0.1.0' }, '0.1.0');
    state.ready = true;
  }

  function onReady(event) { if (event.type === 'ready') install(); }

  function stop() {
    if (state.ready) {
      L.Player.listener.remove('create', onCreate);
      L.Player.listener.remove('destroy', onDestroy);
      L.PlayerPlaylist.listener.remove('set', onSet);
    }
    L.Listener.remove('app', onReady);
    state.ready = false;
    selected = null;
    if (window.__bwaClean === state) delete window.__bwaClean;
  }

  if (window.appready) install();
  else L.Listener.follow('app', onReady);
})();
