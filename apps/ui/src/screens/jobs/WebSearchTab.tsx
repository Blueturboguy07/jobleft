// Jobs > Web search: searches the web for jobs through the person's own SearXNG (Settings > Web search). The results
// are only links until the person acts: "Add job" reads the page once (the same read as a pasted link), "Follow"
// adds the board to the board list. Sites jobleft never contacts are listed for the browser only.

import { useEffect, useState } from 'react';
import { Alert, Button, Collapse, Input, Select, Tag } from 'antd';
import { GlobalOutlined, LinkOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import type { WebSearchBoard, WebSearchRequest, WebSearchResponse, WebSearchResult } from '@jobleft/contracts';
import { call, openExternal, type UiError } from '../../app/api.ts';
import { invalidate } from '../../app/data.ts';
import { ui } from '../../app/layers.ts';
import { navigate } from '../../app/router.ts';
import { afterTrackerChange, useAppSettings, useProfile } from '../../app/session.ts';
import { EmptyState, InlineError, Loading } from '../../components/States.tsx';
import { countryName } from '../../lib/countries.ts';
import { ago } from '../../lib/format.ts';

const SYSTEM: Record<string, string> = {
  greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', workable: 'Workable', recruitee: 'Recruitee', personio: 'Personio', teamtailor: 'Teamtailor', gem: 'Gem',
};

type Range = NonNullable<WebSearchRequest['timeRange']> | 'any';

/** The last search and its answer, kept while the app runs, so switching tabs does not lose them. */
let last: { q: string; place: string; range: Range; answer: WebSearchResponse | null; page: number } | null = null;

export function WebSearchTab() {
  const settings = useAppSettings();
  const profile = useProfile();
  const p = profile.data;
  const country = (p as unknown as { personal?: { country?: string | null } } | undefined)?.personal?.country ?? null;
  const [q, setQ] = useState(last?.q ?? p?.preferences.targetTitles[0] ?? p?.preferences.jobFunctions[0] ?? '');
  const [place, setPlace] = useState(last?.place ?? p?.preferences.places[0]?.text ?? (country ? countryName(country) : ''));
  const [range, setRange] = useState<Range>(last?.range ?? 'month');
  const [answer, setAnswer] = useState<WebSearchResponse | null>(last?.answer ?? null);
  const [page, setPage] = useState(last?.page ?? 1);
  const [busy, setBusy] = useState<'search' | 'more' | null>(null);
  const [err, setErr] = useState<UiError | null>(null);
  // The profile may load after the first draw: fill the boxes from it once, unless the person typed already.
  useEffect(() => {
    if (!p || last) return;
    setQ((v) => v || p.preferences.targetTitles[0] || p.preferences.jobFunctions[0] || '');
    setPlace((v) => v || p.preferences.places[0]?.text || (country ? countryName(country) : ''));
  }, [!!p]);

  if (settings.error && !settings.data) return <div className="jl-list-pane"><InlineError error={settings.error} /></div>;
  if (!settings.data) return <div className="jl-list-pane"><Loading label="Loading" /></div>;
  if (!settings.data.webSearch?.url) {
    return (
      <div className="jl-list-pane">
        <EmptyState art="search" title="Web search is not set up"
          text="Web search finds jobs all over the web through your own SearXNG, a search engine you run yourself. Add its address once in Settings, then search here."
          action={<Button type="primary" shape="round" onClick={() => navigate('settings/websearch')}>Set up web search</Button>} />
      </div>
    );
  }

  const request = (n: number): WebSearchRequest => ({ q: q.trim(), ...(place.trim() ? { place: place.trim() } : {}), ...(range !== 'any' ? { timeRange: range } : {}), ...(n > 1 ? { page: n } : {}) });
  const search = async () => {
    if (!q.trim()) return;
    setBusy('search'); setErr(null);
    try {
      const r = await call('webSearchJobs', { body: request(1) });
      setAnswer(r); setPage(1);
      last = { q, place, range, answer: r, page: 1 };
    } catch (e) { setErr(e as UiError); } finally { setBusy(null); }
  };
  // The next page of the same searches, added below what is shown (a result already shown is not repeated).
  const more = async () => {
    if (!answer) return;
    setBusy('more'); setErr(null);
    try {
      const r = await call('webSearchJobs', { body: request(page + 1) });
      const merged = mergeAnswers(answer, r);
      setAnswer(merged); setPage(page + 1);
      last = { q, place, range, answer: merged, page: page + 1 };
      if (merged.results.length === answer.results.length) ui.message?.info('No more new results. Try other words or a wider place.');
    } catch (e) { setErr(e as UiError); } finally { setBusy(null); }
  };
  const update = (fn: (a: WebSearchResponse) => WebSearchResponse) => setAnswer((a) => { const n = a ? fn(a) : a; if (last) last.answer = n; return n; });

  const results = answer?.results ?? [];
  const groups: Array<{ key: WebSearchResult['kind']; title: string; hint: string }> = [
    { key: 'board_job', title: 'Jobs on boards jobleft reads', hint: 'Add a job to read its facts and see your match. Follow its board to get every job there from now on.' },
    { key: 'page', title: 'Job pages on other sites', hint: 'Add job reads the page once, if the site allows it (robots.txt).' },
    { key: 'board', title: 'Board pages', hint: 'Whole job boards. Follow one to get its jobs in your feed.' },
    { key: 'list', title: 'Job lists on job sites', hint: 'Search pages that list many jobs. Open one in your browser; to keep a job from it, add that job\'s own link.' },
  ];
  const never = results.filter((r) => r.kind === 'never');

  return (
    <div className="jl-list-pane" style={{ overflow: 'auto' }}>
      <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 1100 }}>
        <form className="jl-row jl-wrap" onSubmit={(e) => { e.preventDefault(); void search(); }} style={{ gap: 8 }}>
          <Input size="large" style={{ flex: '2 1 240px' }} prefix={<SearchOutlined aria-hidden="true" />} value={q} onChange={(e) => setQ(e.target.value)} maxLength={200} placeholder="What: a job title, skills or a company" aria-label="What to search for" />
          <Input size="large" style={{ flex: '1 1 160px' }} prefix={<GlobalOutlined aria-hidden="true" />} value={place} onChange={(e) => setPlace(e.target.value)} maxLength={200} placeholder="Where: a city or country" aria-label="Where" />
          <Select size="large" style={{ width: 150 }} value={range} onChange={setRange} aria-label="How recent"
            options={[{ value: 'week', label: 'Past week' }, { value: 'month', label: 'Past month' }, { value: 'year', label: 'Past year' }, { value: 'any', label: 'Any time' }]} />
          <Button size="large" type="primary" shape="round" htmlType="submit" loading={busy === 'search'} disabled={!q.trim() || !!busy}>Search the web</Button>
        </form>
        <p className="jl-small jl-muted" style={{ margin: 0 }}>
          Your words go to your SearXNG ({settings.data.webSearch.url}), which asks the search engines. jobleft opens no result until you add it, and never opens LinkedIn, Indeed or Glassdoor. A search takes a few seconds.
        </p>
        <InlineError error={err} />
        {busy === 'search' && <Loading label="Searching the web" />}
        {answer && busy !== 'search' && (
          <>
            <Alert type={answer.failedQueries ? 'warning' : 'info'} showIcon message={answer.message}
              description={answer.unresponsive.length ? `Search engines that did not answer: ${answer.unresponsive.join(', ')}.` : undefined} />
            <Boards boards={answer.boards} onChange={(b) => update((a) => ({ ...a, boards: a.boards.map((x) => (x.boardId === b.boardId ? b : x)) }))} />
            {groups.map((g) => {
              const list = results.filter((r) => r.kind === g.key);
              if (!list.length) return null;
              return (
                <section key={g.key} aria-label={g.title} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <h2 className="jl-subhead" style={{ margin: '8px 0 0' }}>{g.title} <span className="jl-muted">({list.length})</span></h2>
                  <p className="jl-small jl-muted" style={{ margin: 0 }}>{g.hint}</p>
                  {list.map((r) => <ResultRow key={r.url} r={r} onAdded={(jobId) => update((a) => ({ ...a, results: a.results.map((x) => (x.url === r.url ? { ...x, jobId } : x)) }))} />)}
                </section>
              );
            })}
            {page < 5 && results.length > 0 && (
              <Button shape="round" style={{ alignSelf: 'center' }} loading={busy === 'more'} disabled={!!busy} onClick={() => { void more(); }}>More results</Button>
            )}
            {never.length > 0 && (
              <Collapse items={[{
                key: 'never', label: `Sites jobleft never opens (${never.length})`,
                children: (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <p className="jl-small jl-muted" style={{ margin: 0 }}>LinkedIn, Indeed, Glassdoor, Workday and some others do not allow programs like jobleft. Open a job in your browser; to keep it, paste its text in the External tab.</p>
                    {never.map((r) => <ResultRow key={r.url} r={r} onAdded={() => undefined} />)}
                  </div>
                ),
              }]} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Two answers as one: results by address (first one wins), boards with their counts added up. */
function mergeAnswers(a: WebSearchResponse, b: WebSearchResponse): WebSearchResponse {
  const urls = new Set(a.results.map((r) => r.url));
  const boards = new Map(a.boards.map((x) => [x.boardId, { ...x }]));
  for (const x of b.boards) {
    const have = boards.get(x.boardId);
    if (have) have.results += x.results; else boards.set(x.boardId, x);
  }
  return {
    ...b,
    results: [...a.results, ...b.results.filter((r) => !urls.has(r.url))],
    boards: [...boards.values()],
    queries: a.queries + b.queries,
    failedQueries: a.failedQueries + b.failedQueries,
    unresponsive: [...new Set([...a.unresponsive, ...b.unresponsive])].sort(),
  };
}

function ResultRow({ r, onAdded }: { r: WebSearchResult; onAdded: (jobId: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const add = async () => {
    setBusy(true); setErr(null);
    try {
      const res = await call('addExternalJob', { body: { url: r.url } });
      onAdded(res.job.id);
      afterTrackerChange();
      ui.message?.success(`Added: ${res.job.title} at ${res.job.company}.`);
    } catch (e) { setErr((e as UiError).message); } finally { setBusy(false); }
  };
  return (
    <article className="jl-card-box" style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 14px' }}>
      <div className="jl-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <a href={r.url} target="_blank" rel="noopener noreferrer" style={{ fontWeight: 600, fontSize: 15 }}>{r.title}</a>
          <div className="jl-small jl-muted">
            {r.host}{r.ats ? ` · ${SYSTEM[r.ats] ?? r.ats}` : ''}{r.publishedAt ? ` · ${ago(r.publishedAt)}` : ''}{r.engines.length ? ` · ${r.engines.join(', ')}` : ''}
          </div>
        </div>
        <div className="jl-row" style={{ flex: '0 0 auto', gap: 6 }}>
          {r.jobId
            ? <Button size="small" shape="round" onClick={() => navigate(`jobs/${encodeURIComponent(r.jobId!)}`)}>Open in jobleft</Button>
            : (r.kind === 'board_job' || r.kind === 'page') && <Button size="small" shape="round" className="jl-accent-btn" icon={<PlusOutlined />} loading={busy} onClick={() => { void add(); }}>Add job</Button>}
          {r.kind === 'never' && <Button size="small" shape="round" onClick={() => navigate('jobs/external')}>Paste in External</Button>}
          <Button size="small" shape="round" icon={<LinkOutlined />} onClick={() => openExternal(r.url)} aria-label={`Open ${r.title} in the browser`}>Open</Button>
        </div>
      </div>
      {r.snippet && <p className="jl-small" style={{ margin: 0, color: 'var(--jl-text2)' }}>{r.snippet}</p>}
      {r.note && <p className="jl-small jl-muted" style={{ margin: 0 }}>{r.note}</p>}
      {err && <p role="alert" className="jl-small" style={{ margin: 0, color: 'var(--jl-error, #B3261E)' }}>{err}</p>}
    </article>
  );
}

function Boards({ boards, onChange }: { boards: WebSearchBoard[]; onChange: (b: WebSearchBoard) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  if (!boards.length) return null;
  const follow = async (b: WebSearchBoard) => {
    setBusy(b.boardId);
    try {
      const e = b.added
        ? await call('updateBoard', { params: { boardId: b.boardId }, body: { followed: true } })
        : await call('addBoard', { body: { ats: b.ats, board: b.board, ...(b.region ? { region: b.region } : {}) } });
      await call('crawlRun', { body: { boardIds: [e.id] } }).catch(() => undefined);
      onChange({ ...b, added: true, followed: true, company: e.company });
      invalidate('boards', 'crawl');
      ui.message?.success(`Following ${e.company}. Its jobs appear in your feed as soon as jobleft has read the board.`);
    } catch (e) { ui.message?.error((e as UiError).message); } finally { setBusy(null); }
  };
  return (
    <section aria-label="Boards found" className="jl-card-box" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 14px' }}>
      <h2 className="jl-subhead" style={{ margin: 0 }}>Boards found <span className="jl-muted">({boards.length})</span></h2>
      <p className="jl-small jl-muted" style={{ margin: 0 }}>Each board is an employer's whole job list. Following one brings all its jobs into your feed, refreshed on their own.</p>
      <div className="jl-row jl-wrap" style={{ gap: 8 }}>
        {boards.map((b) => (
          <span key={b.boardId} className="jl-row" style={{ gap: 6, border: '1px solid var(--jl-line)', borderRadius: 16, padding: '2px 4px 2px 10px' }}>
            <span>{b.company ?? b.board}</span>
            <Tag style={{ margin: 0 }}>{SYSTEM[b.ats] ?? b.ats}</Tag>
            <span className="jl-small jl-muted">{b.results} {b.results === 1 ? 'result' : 'results'}</span>
            {b.followed
              ? <Tag color="green" style={{ margin: 0 }}>Following</Tag>
              : <Button size="small" shape="round" loading={busy === b.boardId} onClick={() => { void follow(b); }}>Follow</Button>}
          </span>
        ))}
      </div>
    </section>
  );
}
