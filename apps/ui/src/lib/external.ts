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

/**
 * A job added from pasted text with no link carries a reserved address that never resolves (RFC 2606,
 * "jobleft.invalid"; the server's NO_LINK_HOST). It is not a page: the screens show "no link" instead (JL-tracker-12).
 */
export function realLink(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname === 'jobleft.invalid' || u.hostname.endsWith('.invalid') ? null : url;
  } catch { return null; }
}

export const NO_LINK_TEXT = 'No apply link: this job was added from pasted text without one. Look for it on the employer\'s own site.';
