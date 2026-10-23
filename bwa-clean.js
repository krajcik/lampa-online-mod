// SPDX-License-Identifier: MIT
(function () {
  'use strict';
  if (window.__bwaClean || !window.Lampa) return;
  var L = window.Lampa, selected = null;
  var state = { version: '0.2.0', ready: false, checks: 0, repairs: 0, stop: stop };
  var generation = 0, pending = [];
  window.__bwaClean = state;
  L.Manifest.plugins = { type: 'other', name: 'BWA Clean', version: state.version, component: 'bwa_clean', description: 'BWA playback without client VAST and Lampa prerolls' };

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
    wrapResolver(item);
  }

  function qualityStatus(reason) {
    if (L.Storage && L.Storage.set) {
      L.Storage.set('bwa_clean_quality', 'checked=' + state.checks + ';repaired=' + state.repairs + ';last=' + reason);
    }
  }

  function masterWidth(text, compatible) {
    if (typeof text !== 'string' || text.length > 1048576 || text.indexOf('#EXTM3U') !== 0) return -1;
    var width = 0, match;
    var expression = /^#EXT-X-STREAM-INF:.*$/gmi;
    while ((match = expression.exec(text))) {
      var resolution = /RESOLUTION=(\d+)x\d+/i.exec(match[0]);
      if (!resolution) continue;
      if (compatible) {
        var codecs = /CODECS="([^"]+)"/i.exec(match[0]), mediaSource = window.MediaSource || window.WebKitMediaSource;
        try {
          if (!codecs || !mediaSource || !mediaSource.isTypeSupported('video/mp4; codecs="' + codecs[1] + '"')) continue;
        } catch (error) { continue; }
      }
      width = Math.max(width, Number(resolution[1]));
    }
    return width;
  }

  function cancelChecks(resume) {
    pending.slice().forEach(function (cancel) { cancel(resume); });
  }

  function wrapResolver(item) {
    if (typeof item.url !== 'function' || item.url.bwa_clean_owner === state) return;
    var activity = L.Activity.active();
    var component = activity && activity.component === 'bwa_online' && activity.activity && activity.activity.component;
    if (!component || typeof component.resolveEpisodeLink !== 'function' || typeof L.Reguest !== 'function') return;
    var original = item.url.bwa_clean_original || item.url;
    var wrapped = function (callback) {
      if (!state.ready) return original.apply(this, arguments);
      generation++;
      cancelChecks(false);
      var context = this, token = generation, originalDone = false;
      var source = L.Storage && L.Storage.get ? L.Storage.get('bwa_balanser', '') : '';
      function current() {
        return generation === token && L.Activity.active() === activity && !component.destroyed &&
          (!L.Storage || !L.Storage.get || L.Storage.get('bwa_balanser', '') === source);
      }
      return original.call(context, function () {
        if (originalDone) return;
        originalDone = true;
        if (!current()) return;
        var args = arguments, callbackContext = this;
        if (!state.ready || typeof item.url !== 'string') return callback.apply(this, args);
        var fallback = item.url, network = new L.Reguest(), finished = false;
        var timer = setTimeout(function () { finish(false, 'timeout'); }, 5000);
        state.checks++;
        function cancel(resume) { finish(false, 'cancelled', !resume); }
        pending.push(cancel);
        function finish(repair, reason, discard) {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          pending = pending.filter(function (entry) { return entry !== cancel; });
          try { network.clear(); } catch (error) {}
          if (repair) state.repairs++;
          qualityStatus(reason);
          if (!discard && current()) callback.apply(callbackContext, args);
        }
        function get(url, complete) {
          if (!/^https?:\/\//i.test(url)) return finish(false, 'unsupported-url');
          try {
            network.silent(url, function (text) {
              if (!finished && current()) complete(text);
              else if (!finished) finish(false, 'stale', true);
            }, function () { finish(false, 'read-failed'); }, false, { dataType: 'text' });
          } catch (error) { finish(false, 'read-failed'); }
        }
        var resolved = false;
        try {
          component.resolveEpisodeLink(item.season, item.episode, function (url, qualities) {
            if (finished || resolved) return;
            resolved = true;
            if (!current()) return finish(false, 'stale', true);
            if (typeof url !== 'string' || url === fallback) return finish(false, 'unchanged');
            try {
              var preferredURL = new URL(url), fallbackURL = new URL(fallback);
              if (!/^https?:$/.test(preferredURL.protocol) || preferredURL.username || preferredURL.password || fallbackURL.username || fallbackURL.password) return finish(false, 'unsupported-url');
              if (item.headers && Object.keys(item.headers).length && preferredURL.origin !== fallbackURL.origin) return finish(false, 'headers');
            } catch (error) { return finish(false, 'unsupported-url'); }
            get(url, function (preferred) {
              var width = masterWidth(preferred, true);
              if (width < 1280) return finish(false, 'no-hd-master');
              get(fallback, function (existing) {
                var previousWidth = masterWidth(existing);
                if (previousWidth < 0 || previousWidth >= width) return finish(false, 'unchanged');
                // Prefer the adaptive master; never force an ABR rendition or trust a quality label.
                item.url = url;
                if (qualities && typeof qualities === 'object') item.quality = qualities;
                else delete item.quality;
                finish(true, 'hd-master');
              });
            });
          });
        } catch (error) { finish(false, 'resolve-failed'); }
      });
    };
    wrapped.bwa_clean_owner = state;
    wrapped.bwa_clean_original = original;
    item.url = wrapped;
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
    generation++;
    cancelChecks(false);
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.bwa_clean_item !== true && !inBwa()) { selected = null; return; }
    selected = data;
    clean(data);
    if (Array.isArray(data.playlist)) data.playlist.forEach(clean);
    // Lampa's continuation check requires the exact object in PlayerPlaylist.
    L.Player.playlist([data]);
  }

  function onDestroy() { generation++; cancelChecks(false); selected = null; }

  function install() {
    if (state.ready) return;
    if (!L.Player || !L.Player.listener || !L.PlayerPlaylist || !L.PlayerPlaylist.listener || !L.Params || !L.Params.select) {
      console.error('BWA Clean: unsupported player API');
      return;
    }
    L.Player.listener.follow('create', onCreate);
    L.Player.listener.follow('destroy', onDestroy);
    L.PlayerPlaylist.listener.follow('set', onSet);
    L.Params.select('bwa_clean_version', { '0.2.0': '0.2.0' }, '0.2.0');
    L.Params.select('bwa_clean_quality', {}, 'checked=0;repaired=0;last=idle');
    qualityStatus('idle');
    state.ready = true;
  }

  function onReady(event) { if (event.type === 'ready') install(); }

  function stop() {
    if (state.ready) {
      L.Player.listener.remove('create', onCreate);
      L.Player.listener.remove('destroy', onDestroy);
      L.PlayerPlaylist.listener.remove('set', onSet);
    }
    state.ready = false;
    cancelChecks(true);
    L.PlayerPlaylist.get().forEach(function (item) {
      if (item && item.url && item.url.bwa_clean_owner === state) item.url = item.url.bwa_clean_original;
    });
    L.Listener.remove('app', onReady);
    selected = null;
    if (window.__bwaClean === state) delete window.__bwaClean;
  }

  if (window.appready) install();
  else L.Listener.follow('app', onReady);
})();
