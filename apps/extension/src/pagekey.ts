// The key of a job page address, so one job opened from two links (with and without tracking parameters) is one
// job, and two jobs whose links differ only in a job ID stay two jobs (extension O14).

const TRACKING = new Set([
  'gclid', 'fbclid', 'msclkid', 'dclid', 'yclid', 'igshid', 'mc_cid', 'mc_eid', '_hsenc', '_hsmi', 'hsctatracking',
  'ref', 'referrer', 'referer', 'source', 'src', 'gh_src', 'lever-source', 'lever-origin', 'lever-via', 'trk',
  'trackingid', 'tracking_id', 'campaign', 'si', 'share', 'from', 'utm', 'ashby_src', 'jobsource', 'source_id',
  'sourceid', 'mode', 'jr_id', '_ga', '_gl', 'spm', 'cmp', 'cid', 'ccuid', 'bid', 'ss', 'feedid',
]);

function isTracking(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith('utm_') || n.startsWith('pk_') || n.startsWith('mtm_') || TRACKING.has(n);
}

/**
 * A stable key: "<ats>:<id>" for the known systems (their job ids are global), else "<host><path>?<id params>".
 * null for a string that is not an http(s) address.
 */
export function pageKey(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = u.pathname.replace(/\/+$/, '');
  const seg = path.split('/').filter(Boolean);
  const q = (k: string): string | null => u.searchParams.get(k);

  const ghJid = q('gh_jid');
  if (ghJid && /^\d+$/.test(ghJid)) return `greenhouse:${ghJid}`;
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    const i = seg.indexOf('jobs');
    if (i >= 0 && seg[i + 1] && /^\d+$/.test(seg[i + 1] as string)) return `greenhouse:${seg[i + 1]}`;
    const token = q('token');
    if (token && /^\d+$/.test(token)) return `greenhouse:${token}`;
  }
  if (/(^|\.)lever\.co$/.test(host) && seg[1] && /^[0-9a-f-]{36}$/i.test(seg[1])) return `lever:${seg[1].toLowerCase()}`;
  const ashbyJid = q('ashby_jid');
  if (ashbyJid && /^[0-9a-f-]{36}$/i.test(ashbyJid)) return `ashby:${ashbyJid.toLowerCase()}`;
  if (/(^|\.)ashbyhq\.com$/.test(host)) {
    const id = seg.find((s) => /^[0-9a-f-]{36}$/i.test(s));
    if (id) return `ashby:${id.toLowerCase()}`;
  }
  if (/(^|\.)workable\.com$/.test(host)) {
    const j = seg.indexOf('j');
    if (j >= 1 && seg[j + 1]) return `workable:${(seg[0] as string).toLowerCase()}:${(seg[j + 1] as string).toUpperCase()}`;
  }
  if (/(^|\.)(myworkdayjobs\.com|myworkdaysite\.com)$/.test(host)) {
    // .../job/<location>/<Title>_<REQ-ID>[/apply[/applyManually]]
    const j = seg.indexOf('job');
    const jobSeg = seg.slice(j + 1).find((s) => /_[A-Za-z]*-?\d[\w-]*$/.test(s));
    const tenant = host.split('.')[0];
    const req = jobSeg?.split('_').pop();
    if (j >= 0 && req) return `workday:${tenant}:${req.toUpperCase()}`;
  }
  if (/(^|\.)icims\.com$/.test(host)) {
    const i = seg.indexOf('jobs');
    if (i >= 0 && seg[i + 1] && /^\d+$/.test(seg[i + 1] as string)) return `icims:${host}:${seg[i + 1]}`;
  }

  // Generic: host, path without an "apply" tail, and the parameters that are not tracking, sorted.
  const trimmed = path.replace(/\/(apply|application|apply-now|applynow)$/i, '');
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !isTracking(k))
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  const port = u.port ? `:${u.port}` : '';
  return `${host}${port}${trimmed || '/'}${params.length ? `?${params.join('&')}` : ''}`;
}
