// Practice-page logger (test tool): logs submit attempts, "Next"/"Save and Continue" presses and page changes to the
// practice server, and stops real submission so the page stays. window.__practiceDump() returns every field value.
(function () {
  'use strict';
  var page = location.pathname;
  function post(type, detail) {
    try { navigator.sendBeacon('/__event', new Blob([JSON.stringify({ type: type, page: page, detail: detail || '' })], { type: 'text/plain' })); } catch (e) {}
  }
  document.addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target;
    post('submit', 'form ' + (f.id || f.getAttribute('name') || f.action || '?') + (e.isTrusted ? ' (trusted)' : ' (script)'));
    var note = document.getElementById('__submitted') || document.createElement('div');
    note.id = '__submitted'; note.textContent = 'Practice page: a submit was attempted (logged).';
    note.style.cssText = 'position:fixed;bottom:8px;left:8px;background:#fde8e8;color:#9b1c1c;padding:6px 10px;border-radius:6px;font:13px system-ui;z-index:10';
    document.body.appendChild(note);
  }, true);
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-next], button, a') : null;
    if (b && b.matches('[data-next]')) { e.preventDefault(); post('next', (b.textContent || '').trim() + (e.isTrusted ? ' (trusted)' : ' (script)')); }
  }, true);
  window.addEventListener('pagehide', function () { post('page-change', 'pagehide'); });
  var push = history.pushState, rep = history.replaceState;
  history.pushState = function () { post('page-change', 'pushState'); return push.apply(this, arguments); };
  history.replaceState = function () { post('page-change', 'replaceState'); return rep.apply(this, arguments); };
  window.__practiceDump = function () {
    var out = [];
    document.querySelectorAll('input, select, textarea').forEach(function (el) {
      var v;
      if (el.type === 'checkbox' || el.type === 'radio') v = el.checked;
      else if (el.type === 'file') v = Array.prototype.map.call(el.files || [], function (f) { return f.name + ':' + f.size; }).join('|');
      else if (el.tagName === 'SELECT') v = el.selectedIndex >= 0 ? el.options[el.selectedIndex].text : '';
      else v = el.value;
      out.push({ id: el.id, name: el.name, type: el.type, value: v });
    });
    document.querySelectorAll('[data-combo-value]').forEach(function (el) { out.push({ id: el.id, name: 'combo', type: 'combo', value: el.textContent.trim() }); });
    return out;
  };
  post('event', 'loaded');
})();
