// Opens a link in the person's default browser from a click handler. A real anchor click is what both a browser and
// the desktop shell honour (the shell's opener hook watches anchor clicks with target="_blank"; it does not see
// window.open), so the menu items that used window.open go through here.
export function openExternal(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
