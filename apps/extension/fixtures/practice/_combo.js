// A small custom dropdown that behaves like react-select (test tool): it opens on mousedown, lists options in a
// role=listbox named by aria-controls, filters on typing, commits on click, and shows the choice in its own markup.
// Typing text alone commits nothing (like the real widgets). Markup: <div class="combo" data-options="A|B|C" data-label-id="x-label" data-name="q"></div>
(function () {
  'use strict';
  var n = 0;
  document.querySelectorAll('.combo').forEach(function (box) {
    n++;
    var id = 'combo' + n;
    var opts = (box.getAttribute('data-options') || '').split('|');
    box.innerHTML = '';
    var control = document.createElement('div'); control.className = 'combo__control';
    var shown = document.createElement('div'); shown.className = 'combo__single-value'; shown.setAttribute('data-combo-value', ''); shown.id = id + '-value';
    var ph = document.createElement('div'); ph.className = 'combo__placeholder'; ph.textContent = 'Select...';
    var input = document.createElement('input'); input.type = 'text'; input.id = box.getAttribute('data-input-id') || id + '-input';
    input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', id + '-list'); input.setAttribute('autocomplete', 'off');
    if (box.getAttribute('data-label-id')) input.setAttribute('aria-labelledby', box.getAttribute('data-label-id'));
    if (box.hasAttribute('data-required')) input.setAttribute('aria-required', 'true');
    var hidden = document.createElement('input'); hidden.type = 'hidden'; hidden.name = box.getAttribute('data-name') || id;
    var list = document.createElement('div'); list.id = id + '-list'; list.setAttribute('role', 'listbox'); list.className = 'combo__menu'; list.style.display = 'none';
    control.appendChild(ph); control.appendChild(shown); control.appendChild(input); box.appendChild(control); box.appendChild(hidden); box.appendChild(list);
    shown.style.display = 'none';
    function render(filter) {
      list.innerHTML = '';
      opts.filter(function (o) { return !filter || o.toLowerCase().indexOf(filter.toLowerCase()) >= 0; }).forEach(function (o) {
        var d = document.createElement('div'); d.setAttribute('role', 'option'); d.className = 'combo__option'; d.textContent = o;
        d.addEventListener('click', function () { choose(o); });
        list.appendChild(d);
      });
    }
    function open() { render(input.value); list.style.display = 'block'; input.setAttribute('aria-expanded', 'true'); }
    function close() { list.style.display = 'none'; input.setAttribute('aria-expanded', 'false'); }
    function choose(o) { hidden.value = o; shown.textContent = o; shown.style.display = 'block'; ph.style.display = 'none'; input.value = ''; close(); }
    control.addEventListener('mousedown', function () { if (list.style.display === 'none') open(); else close(); });
    input.addEventListener('input', function () { open(); });
    input.addEventListener('blur', function () { setTimeout(function () { input.value = ''; close(); }, 150); });
  });
})();
