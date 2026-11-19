// Opens a menu bar (status) item's menu with a real mouse click and clicks one of its items, on a GitHub macOS runner
// (apps/shell/test/live-proof/macos.sh). A click through System Events would block until the menu closes, so the
// item is clicked with a mouse event at its place on screen; the open menu is then read and clicked through System
// Events, as a person does with the mouse.
//   osascript -l JavaScript menu.js <process> <item prefix>
// Prints "clicked <item> (the menu: [a] [b] ...)", or "no ..." when there was nothing to click.
ObjC.import('CoreGraphics');

function mouseClick(x, y) {
  const LEFT_DOWN = 1, LEFT_UP = 2, LEFT_BUTTON = 0, HID_TAP = 0;
  for (const type of [LEFT_DOWN, LEFT_UP]) {
    const e = $.CGEventCreateMouseEvent(null, type, $.CGPointMake(x, y), LEFT_BUTTON);
    $.CGEventPost(HID_TAP, e);
    delay(0.08);
  }
}

function run(argv) {
  const [pname, prefix] = argv;
  const se = Application('System Events');
  if (!se.processes.byName(pname).exists()) return 'no process ' + pname;
  const proc = se.processes.byName(pname);
  if (proc.menuBars.length < 2) return 'no menu bar item of ' + pname;
  const item = proc.menuBars[1].menuBarItems[0];
  const [x, y] = item.position();
  const [w, h] = item.size();
  mouseClick(x + w / 2, y + h / 2);
  let items = [];
  for (let i = 0; i < 20 && items.length === 0; i++) {
    delay(0.25);
    try { items = item.menus[0].menuItems(); } catch (e) { items = []; }
  }
  if (items.length === 0) return 'no menu opened (clicked the item at ' + Math.round(x + w / 2) + ',' + Math.round(y + h / 2) + ')';
  let seen = '';
  for (const mi of items) {
    let n = '';
    try { n = mi.name() || ''; } catch (e) { n = ''; }
    seen += '[' + n + '] ';
    if (n.startsWith(prefix)) {
      mi.click();
      return 'clicked ' + n + ' (the menu: ' + seen.trim() + ')';
    }
  }
  se.keyCode(53); // Escape closes the menu
  return 'no menu item ' + prefix + ' (the menu: ' + seen.trim() + ')';
}
