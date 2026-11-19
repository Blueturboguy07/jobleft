// Installs an app from an open dmg as a person does: drags its icon onto the Applications link in the dmg's Finder
// window, with real mouse events (GitHub macOS runner only; apps/shell/test/live-proof/macos.sh).
//   osascript -l JavaScript drag.js <volume path> <app name without .app>
// Prints "dragged <app> from x,y to x,y", or "no ..." when an icon was not found.
ObjC.import('CoreGraphics');

const MOVED = 5, DOWN = 1, UP = 2, DRAGGED = 6, LEFT = 0, HID_TAP = 0;
function post(type, x, y) {
  $.CGEventPost(HID_TAP, $.CGEventCreateMouseEvent(null, type, $.CGPointMake(x, y), LEFT));
}

function attr(e, name) {
  try { return e.attributes.byName(name).value(); } catch (err) { return null; }
}

// The first element under `root` (depth-first, to a depth of 8) whose title, name or description is one of `names`.
function find(root, names, depth) {
  let kids = [];
  try { kids = root.uiElements(); } catch (err) { kids = []; }
  for (const k of kids) {
    const texts = [attr(k, 'AXTitle'), attr(k, 'AXDescription'), attr(k, 'AXFilename')];
    try { texts.push(k.name()); } catch (err) {}
    const role = attr(k, 'AXRole') || '';
    if (texts.some((t) => t && names.includes(String(t))) && role !== 'AXStaticText' && role !== 'AXTextField') return k;
    if (depth < 8) {
      const hit = find(k, names, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

function center(e) {
  const [x, y] = e.position();
  const [w, h] = e.size();
  return [x + w / 2, y + h / 2];
}

function run(argv) {
  const [volume, app] = argv;
  const finder = Application('Finder');
  finder.activate();
  finder.open(Path(volume));
  delay(3);
  const se = Application('System Events');
  const proc = se.processes.byName('Finder');
  const volName = volume.split('/').filter(Boolean).pop();
  let win = null;
  for (let i = 0; i < 20 && !win; i++) {
    try { if (proc.windows.byName(volName).exists()) win = proc.windows.byName(volName); } catch (err) {}
    if (!win) delay(0.5);
  }
  if (!win) return 'no Finder window ' + volName;
  const source = find(win, [app, app + '.app'], 0);
  const target = find(win, ['Applications'], 0);
  if (!source || !target) return 'no ' + (source ? '' : app + ' icon ') + (target ? '' : 'Applications icon ') + 'in the window ' + volName;
  const [sx, sy] = center(source);
  const [tx, ty] = center(target);
  post(MOVED, sx, sy); delay(0.3);
  post(DOWN, sx, sy); delay(0.3);
  const steps = 25;
  for (let i = 1; i <= steps; i++) {
    post(DRAGGED, sx + ((tx - sx) * i) / steps, sy + ((ty - sy) * i) / steps);
    delay(0.04);
  }
  delay(0.5);
  post(UP, tx, ty);
  return 'dragged ' + app + ' from ' + Math.round(sx) + ',' + Math.round(sy) + ' to ' + Math.round(tx) + ',' + Math.round(ty);
}
