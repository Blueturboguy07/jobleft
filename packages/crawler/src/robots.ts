// Minimal robots.txt parser (RFC 9309 semantics). Pure, so it is unit-tested without a network.
//  - Group selection: the group naming our product token, else the `*` group. Groups sharing a token merge.
//  - Rule match: the longest matching pattern wins; on a tie Allow wins. `*` and a trailing `$` work.
//  - Fetch outcomes (decided by the http client): 2xx parse; 4xx (incl. 404, 401) = no rules = allow;
//    5xx or network failure = treat as full disallow for this run.

export interface RobotsRules {
  allows(pathWithQuery: string): boolean;
  /** Crawl-delay in milliseconds, or 0 when none. */
  crawlDelayMs: number;
}

interface Rule { allow: boolean; pattern: string; re: RegExp }

function patternToRegExp(pattern: string): RegExp {
  let p = pattern;
  let anchored = false;
  if (p.endsWith('$')) { anchored = true; p = p.slice(0, -1); }
  const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + (anchored ? '$' : ''));
}

export function parseRobots(body: string, productToken: string): RobotsRules {
  const token = productToken.toLowerCase();
  interface Group { agents: string[]; rules: Rule[]; delay: number }
  const groups: Group[] = [];
  let cur: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const field = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (field === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [], delay: 0 }; groups.push(cur); }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (field === 'allow' || field === 'disallow') {
      if (value === '') continue; // empty Disallow = allow everything; empty Allow = no-op
      cur.rules.push({ allow: field === 'allow', pattern: value, re: patternToRegExp(value) });
    } else if (field === 'crawl-delay') {
      const d = parseFloat(value);
      if (Number.isFinite(d) && d > 0) cur.delay = Math.max(cur.delay, d);
    }
  }
  const named = groups.filter((g) => g.agents.some((a) => a !== '*' && (token === a || token.startsWith(a))));
  const chosen = named.length > 0 ? named : groups.filter((g) => g.agents.includes('*'));
  const rules = chosen.flatMap((g) => g.rules);
  const delay = Math.max(0, ...chosen.map((g) => g.delay));
  return {
    crawlDelayMs: Math.round(delay * 1000),
    allows(pathWithQuery: string): boolean {
      let best: Rule | null = null;
      for (const r of rules) {
        if (!r.re.test(pathWithQuery)) continue;
        if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow && !best.allow)) best = r;
      }
      return best ? best.allow : true;
    },
  };
}

export const ALLOW_ALL: RobotsRules = { allows: () => true, crawlDelayMs: 0 };
export const DISALLOW_ALL: RobotsRules = { allows: () => false, crawlDelayMs: 0 };
