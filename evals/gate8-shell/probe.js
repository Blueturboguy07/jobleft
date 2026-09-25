// Runs inside the app window (WKWebView) and inside headless Chrome: the same page, the same measurements.
// It leaves a JSON report in the URL fragment as "#probe=<encoded json>" (the shell reads the webview's URL from Rust;
// Chrome reads location.hash) and in document.title behind "PROBE:".
(function () {
  function rect(el) { if (!el) return null; var r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; }
  function font(el) { if (!el) return null; var c = getComputedStyle(el); return c.fontFamily.split(',')[0].replace(/["']/g, '').trim() + ' ' + c.fontSize + ' ' + c.fontWeight; }
  function done() {
    var cards = Array.prototype.slice.call(document.querySelectorAll('.jl-card[data-job-id]'), 0, 8);
    var report = {
      ua: navigator.userAgent.indexOf('AppleWebKit') >= 0 && navigator.userAgent.indexOf('Chrome') < 0 ? 'webkit' : 'chromium',
      hash: location.hash,
      title: document.title,
      viewport: [window.innerWidth, window.innerHeight],
      shell: !!document.querySelector('.jl-shell'),
      onboarding: !!document.querySelector('.jl-onboard') || /onboarding/.test(location.hash),
      cards: cards.map(function (c) {
        var t = c.querySelector('.jl-tile');
        return { id: c.getAttribute('data-job-id'), title: (c.querySelector('.jl-card-title') || {}).innerText || '', tile: t ? t.getAttribute('aria-label') : null, rect: rect(c), titleRect: rect(c.querySelector('.jl-card-title')), tileRect: rect(t) };
      }),
      fonts: { body: font(document.body), title: font(document.querySelector('.jl-card-title')), tile: font(document.querySelector('.jl-tile .band')) },
      nav: rect(document.querySelector('[aria-label="Main"]')),
      textLength: (document.body.innerText || '').length,
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      errorsText: /undefined|\[object Object\]|NaN/.test(document.body.innerText || ''),
    };
    var json = JSON.stringify(report);
    var before = location.hash;
    document.title = 'PROBE:' + json;
    location.hash = '#probe=' + encodeURIComponent(json);
    // The readers poll the fragment every 250 ms; after 3 s the page goes back to where it was, so a capture shows the feed.
    setTimeout(function () { location.hash = before || '#/jobs'; }, 3000);
  }
  var start = Date.now();
  (function wait() {
    var ready = document.querySelector('.jl-card[data-job-id]') || document.querySelector('.jl-onboard') || (document.querySelector('.jl-shell') && !document.querySelector('.ant-spin-spinning') && Date.now() - start > 3000);
    if (ready || Date.now() - start > 12000) { setTimeout(done, 600); return; }
    setTimeout(wait, 200);
  })();
})();
