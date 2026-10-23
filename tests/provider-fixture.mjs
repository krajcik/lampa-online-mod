import vm from 'node:vm';

export function providerFixture(source, { response, failFirst = false, abuse = false, deny = false } = {}) {
  const rows = [], played = [], playlists = [], beforePlay = [], calls = [], values = new Map();
  let currentPlaylist = [];
  const params = { defaults: {}, select: (key, _, value) => { params.defaults[key] = value; } };
  const object = { movie: { id: 123, title: 'Fixture', original_title: 'Fixture', release_date: '2020-01-01' } };
  function item() { return { handlers: {}, append() { return this; }, find() { return this; }, on(event, fn) { this.handlers[event] = fn; return this; } }; }
  let postCalls = 0;
  function Request() {
    this.clear = () => {}; this.timeout = () => {}; this.errorDecode = () => 'fixture error';
    this.native = (url, success, error) => {
      calls.push(url);
      if (url.includes('/post/') && deny) return error({ status: 403 });
      if (url.includes('/post/') && failFirst && ++postCalls === 1) return error({ status: 500 });
      if (url.includes('/post/') || url.includes('/sId/')) return success(structuredClone(response));
      return success({ url: 'https://media.invalid/stream.m3u8', qualitys: { '1080p': 'https://media.invalid/1080.m3u8', '2160p': 'https://media.invalid/2160.m3u8' } });
    };
  }
  const sandbox = {
    window: { location: { href: 'http://lampa.mx/', origin: 'http://lampa.mx', hostname: 'lampa.mx', protocol: 'http:' } },
    navigator: { userAgent: 'Android' }, console: { log() {}, warn() {}, error() {} },
    atob: value => Buffer.from(value, 'base64').toString('binary'), btoa: value => Buffer.from(value, 'binary').toString('base64'),
    Lampa: {
      Reguest: Request, Params: params, Manifest: { plugins: [] }, Platform: { is: name => name === 'android', version: 'test' },
      Storage: { get: (key, fallback) => values.has(key) ? values.get(key) : fallback, field: key => values.get(key) ?? false, cache: (_, __, fallback) => fallback, set: (key, value) => values.set(key, value) },
      Lang: { translate: value => value }, Arrays: { getKeys: value => Object.keys(value) },
      Utils: { hash: value => String(value), shortText: value => value, addUrlComponent: (url, value) => url + '?' + value },
      Template: { get: () => item() }, Timeline: { view: () => ({}), render: () => item() }, Favorite: { add() {} },
      Player: { play: value => { beforePlay.push(currentPlaylist.slice()); played.push(value); }, playlist: value => { currentPlaylist = value; playlists.push(value); } },
      PlayerPlaylist: { get: () => currentPlaylist },
      Noty: { show: message => { throw Error(message); } },
    },
  };
  const marker = '    startPlugin();';
  if (source.split(marker).length !== 2) throw Error('Upstream initialization boundary changed');
  const instrumented = source.replace(marker, '    globalThis.providers = { filmix: filmix, lumex2: lumex2, Utils: Utils };');
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  new vm.Script(instrumented).runInContext(context, { timeout: 1000 });
  sandbox.providers.Utils.setMyIp('192.0.2.1');
  const component = {
    proxy: name => abuse && name === 'filmix_abuse' ? 'https://proxy.invalid/' : '', proxyLink: url => url,
    fixLinkProtocol: url => url, reset: () => { rows.length = 0; }, filter() {}, loading() {}, start() {}, contextmenu() {}, saveChoice() {},
    append: row => rows.push(row), getLastEpisode: () => 2, formatEpisodeTitle: (s, e) => `${s}:${e}`,
    empty: message => { throw Error(message || 'Unexpected empty result'); }, emptyForQuery: () => { throw Error('Unexpected no result'); },
    getDefaultQuality: (quality, fallback) => quality?.['2160p'] || quality?.['1080p'] || Object.values(quality || {})[0] || fallback,
    renameQualityMap: value => value,
  };
  return {
    rows, played, playlists, beforePlay, calls, object, values, sandbox,
    run: () => new vm.Script(instrumented).runInContext(context, { timeout: 1000 }),
    filmix() {
      const provider = new sandbox.providers.filmix(component, object, {});
      provider.wait_similars = true;
      provider.search(object, null, [{ is_similars: true, id: 1 }]);
      return provider;
    },
    lumex() { const provider = new sandbox.providers.lumex2({ ...component, checkMyIp: fn => fn() }, object, {}); provider.search(object, 1); return provider; },
    play(index = 0) { rows[index].handlers['hover:enter'](); },
  };
}
