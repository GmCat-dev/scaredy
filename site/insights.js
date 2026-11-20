/* GmCat Site Insights: cookieless page analytics for the GmCat sites.
   Stores nothing in the browser. Honors Do Not Track / Global Privacy Control.
   Usage: load this file with a data-site attribute naming the site, e.g. data-site="blog".
   Custom events: window.gmcatInsights.track('art_search', { term: 'coffee', results: 22 }) */
(function () {
  if (window.gmcatInsights) return;
  var script = document.currentScript;
  var site = (script && script.dataset.site) || 'main';
  var endpoint = (script && script.dataset.endpoint) || 'https://home.gmcat.io/insights/event';
  var host = location.hostname;
  var debug = /[?&]insights=debug\b/.test(location.search);
  var onGmcat = host === 'gmcat.io' || /\.gmcat\.io$/.test(host);
  var optedOut = navigator.doNotTrack === '1' || navigator.doNotTrack === 'yes' || window.doNotTrack === '1' || navigator.globalPrivacyControl === true;
  var enabled = (onGmcat || debug) && !optedOut;

  var coarse = window.matchMedia && matchMedia('(pointer:coarse)').matches;
  var device = coarse ? (innerWidth >= 700 ? 'tablet' : 'phone') : 'desktop';
  var params = new URLSearchParams(location.search);
  var source = params.get('utm_source') || params.get('ref') || null;
  var campaign = params.get('utm_campaign') || null;
  var firstView = true;
  var hashRoutes = !!(script && script.dataset.hashRoutes === 'true');
  function currentPath() {
    var h = location.hash.replace(/^#\/?/, '');
    return hashRoutes && /^[\w-]+$/.test(h) ? '/' + h : location.pathname;
  }

  function send(event, meta, path) {
    var payload = {
      site: site, event: event, path: path || currentPath(), device: device,
      referrer: firstView && event === 'page_view' ? document.referrer : null,
      source: source, campaign: campaign, meta: meta || {}
    };
    if (debug) console.info('[GmCat insights] ' + (enabled ? 'send ' : (optedOut ? 'skipped (Do Not Track/GPC) ' : 'skipped ')) + JSON.stringify(payload));
    if (!enabled) return;
    var body = JSON.stringify(payload);
    try {
      /* text/plain keeps this a "simple" request: no CORS preflight, works during page unload. */
      if (!(navigator.sendBeacon && navigator.sendBeacon(endpoint, new Blob([body], { type: 'text/plain' })))) {
        fetch(endpoint, { method: 'POST', body: body, keepalive: true, mode: 'cors', headers: { 'Content-Type': 'text/plain' } }).catch(function () {});
      }
    } catch (e) { /* analytics must never break the page */ }
  }

  var lastPath = null;
  function pageView() {
    var p = currentPath();
    if (p === lastPath) return;
    lastPath = p;
    send('page_view');
    firstView = false;
  }

  /* Single-page sites (Wix, Brain Brew) change pages without reloading: watch history changes. */
  ['pushState', 'replaceState'].forEach(function (name) {
    var original = history[name];
    if (typeof original !== 'function') return;
    history[name] = function () { var result = original.apply(this, arguments); setTimeout(pageView, 0); return result; };
  });
  window.addEventListener('popstate', function () { setTimeout(pageView, 0); });
  window.addEventListener('hashchange', function () { setTimeout(pageView, 0); });

  /* Clicks to other sites (including other GmCat sites). */
  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a) return;
    var url;
    try { url = new URL(a.href, location.href); } catch (e) { return; }
    if (!/^https?:$/.test(url.protocol) || url.hostname === host) return;
    send('click_out', { target: (url.hostname + url.pathname).replace(/\/$/, '') });
  }, true);

  window.gmcatInsights = { track: function (event, meta) { send(event, meta); } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', pageView); else pageView();
})();
