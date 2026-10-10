// Jobs > Web jobs: jobs found all over the web through the person's own SearXNG (Settings > Web search). A search
// sends a few searches through SearXNG; the job pages it finds are then read in the background, once each (a board
// job from its board's feed, any other page once, robots.txt obeyed), and every one that is an open job becomes a
// card here, with the match score, the job's details and Apply. The search's other results (job sites' lists,
// LinkedIn and the other sites jobleft never opens) are one click away, for the browser.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Collapse, Drawer, Input, Segmented, Select, Tag } from 'antd';
import { GlobalOutlined, LinkOutlined, PlusOutlined, SearchOutlined, UnorderedListOutlined } from '@ant-design/icons';
import type { JobFilter, JobSort, WebReadStatus, WebSearchBoard, WebSearchRequest, WebSearchResponse, WebSearchResult } from '@jobleft/contracts';
import { call, openExternal, type UiError } from '../../app/api.ts';
import { invalidate, load as reload, useApi } from '../../app/data.ts';
import { ui } from '../../app/layers.ts';
import { navigate } from '../../app/router.ts';
import { afterTrackerChange, profileIsSet, useAppSettings, useProfile } from '../../app/session.ts';
import { JobCard } from '../../components/JobCard.tsx';
import { EmptyState, InlineError, Loading, SkeletonCards } from '../../components/States.tsx';
import { VirtualList } from '../../components/VirtualList.tsx';
import { countryName } from '../../lib/countries.ts';
import { cleanFilter } from '../../lib/filters.ts';
import { ago } from '../../lib/format.ts';
import { useCardActions } from './cardActions.tsx';
import { GAP, ROW, useJobPages } from './Feed.tsx';

const SYSTEM: Record<string, string> = {
  greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', workable: 'Workable', recruitee: 'Recruitee', personio: 'Personio', teamtailor: 'Teamtailor', gem: 'Gem',
};

type Range = NonNullable<WebSearchRequest['timeRange']> | 'any';

/** The last search, its answer and the list settings, kept while the app runs, so switching tabs loses nothing. */
let last: { q: string; place: string; range: Range; answer: WebSearchResponse | null; page: number } | null = null;
let view: { where: 'mine' | 'all'; sort: JobSort } = { where: 'mine', sort: 'recommended' };

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
  const [where, setWhere] = useState(view.where);
  const [sort, setSort] = useState(view.sort);
  const [showAll, setShowAll] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // The profile may load after the first draw: fill the boxes from it once, unless the person typed already.
  useEffect(() => {
    if (!p || last) return;
    setQ((v) => v || p.preferences.targetTitles[0] || p.preferences.jobFunctions[0] || '');
    setPlace((v) => v || p.preferences.places[0]?.text || (country ? countryName(country) : ''));
  }, [!!p]);
  useEffect(() => { view = { where, sort }; }, [where, sort]);

  // The cards: every job web search found, in the person's places (jobs that do not state a place included) or all.
  const hasPlaces = !!(p?.preferences.countries.length || p?.preferences.places.length);
  const filter: JobFilter = useMemo(() => (where === 'mine' && p && hasPlaces
    ? cleanFilter({ sources: ['external:web'], countries: p.preferences.countries, places: p.preferences.places, includeUnknown: ['place'] })
    : { sources: ['external:web'] }), [where, p, hasPlaces]);
  const { st, load, more: moreJobs, ops } = useJobPages(filter, sort, '');
  const actions = useCardActions(ops);
  const profileSet = profileIsSet(p);

  // The background reading: while it runs, the progress line and the cards follow it.
  const reading = useApi<WebReadStatus>('websearch:reading', () => call('webReadStatus'));
  const active = !!reading.data && (reading.data.running || reading.data.queued > 0);
  const jobsBefore = useRef(reading.data?.jobs ?? 0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => { void reload('websearch:reading'); }, 1500);
    return () => clearInterval(t);
  }, [active]);
  useEffect(() => {
    const n = reading.data?.jobs ?? 0;
    if (n !== jobsBefore.current) { jobsBefore.current = n; void load(true); }
  }, [reading.data?.jobs]);

  if (settings.error && !settings.data) return <div className="jl-list-pane"><InlineError error={settings.error} /></div>;
  if (!settings.data) return <div className="jl-list-pane"><Loading label="Loading" /></div>;
  if (!settings.data.webSearch?.url) {
    return (
      <div className="jl-list-pane">
        <EmptyState art="search" title="Web search is not set up"
          text="Web jobs finds jobs all over the web through your own SearXNG, a search engine you run yourself. Add its address once in Settings, then search here."
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
      void reload('websearch:reading');
    } catch (e) { setErr(e as UiError); } finally { setBusy(null); }
  };
  // The next page of the same searches: its job pages join the reading, its other results join the list.
  const more = async () => {
    if (!answer) return;
    setBusy('more'); setErr(null);
    try {
      const r = await call('webSearchJobs', { body: request(page + 1) });
      const merged = mergeAnswers(answer, r);
      setAnswer(merged); setPage(page + 1);
      last = { q, place, range, answer: merged, page: page + 1 };
      void reload('websearch:reading');
      if (merged.results.length === answer.results.length) ui.message?.info('No more new results. Try other words or a wider place.');
    } catch (e) { setErr(e as UiError); } finally { setBusy(null); }
  };
  const update = (fn: (a: WebSearchResponse) => WebSearchResponse) => setAnswer((a) => { const n = a ? fn(a) : a; if (last) last.answer = n; return n; });

  const results = answer?.results ?? [];
  const r = reading.data;
  let body;
  if (st.error && !st.items.length) body = <InlineError error={st.error} />;
  else if (st.loading && !st.items.length) body = <SkeletonCards n={3} />;
  else if (!st.items.length) {
    if (active) body = <EmptyState art="search" title="Reading the job pages found" text={`Each one becomes a job card here as soon as it is read: ${r!.queued} left.`} />;
    else if (where === 'mine' && hasPlaces && (r?.jobs ?? 0) > 0) body = <EmptyState art="search" title="None in your places yet" text="Web search found jobs, but none in the places of your profile." action={<Button shape="round" type="primary" onClick={() => setWhere('all')}>Show jobs everywhere</Button>} />;
    else body = <EmptyState art="search" title={answer ? 'No job pages found yet' : 'Search the web for jobs'} text={answer ? 'Try other words, a wider place or a longer time, or More results.' : 'Type what you are looking for and where. jobleft searches the web through your SearXNG and turns every job it finds into a card here, with your match.'} />;
  } else {
    body = (
      <VirtualList items={st.items} rowHeight={ROW} gap={GAP} keyOf={(x) => x.job.id} scrollRef={scrollRef} onNearEnd={moreJobs} label="Web jobs"
        render={(it) => <JobCard item={it} profileSet={profileSet} actions={actions} now={Date.now()} />} />
    );
  }

  return (
    <div className="jl-list-pane">
      <div style={{ padding: '12px 16px 8px', display: 'flex', flexDirection: 'column', gap: 8, borderBottom: '1px solid var(--jl-line)' }}>
        <form className="jl-row jl-wrap" onSubmit={(e) => { e.preventDefault(); void search(); }} style={{ gap: 8 }}>
          <Input size="large" style={{ flex: '2 1 240px' }} prefix={<SearchOutlined aria-hidden="true" />} value={q} onChange={(e) => setQ(e.target.value)} maxLength={200} placeholder="What: a job title, skills or a company" aria-label="What to search for" />
          <Input size="large" style={{ flex: '1 1 160px' }} prefix={<GlobalOutlined aria-hidden="true" />} value={place} onChange={(e) => setPlace(e.target.value)} maxLength={200} placeholder="Where: a city or country" aria-label="Where" />
          <Select size="large" style={{ width: 140 }} value={range} onChange={setRange} aria-label="How recent"
            options={[{ value: 'week', label: 'Past week' }, { value: 'month', label: 'Past month' }, { value: 'year', label: 'Past year' }, { value: 'any', label: 'Any time' }]} />
          <Button size="large" type="primary" shape="round" htmlType="submit" loading={busy === 'search'} disabled={!q.trim() || !!busy}>Search the web</Button>
        </form>
        <InlineError error={err} />
        {answer && (
          <div className="jl-row jl-wrap" style={{ gap: 8 }}>
            <span className="jl-small" style={{ color: answer.failedQueries ? 'var(--jl-warn, #8A5300)' : 'var(--jl-text2)' }}>{answer.message}</span>
            <Button size="small" shape="round" icon={<UnorderedListOutlined />} onClick={() => setShowAll(true)}>All {results.length} results</Button>
            {page < 5 && <Button size="small" shape="round" loading={busy === 'more'} disabled={!!busy} onClick={() => { void more(); }}>More results</Button>}
          </div>
        )}
        {r && active && <ReadingLine r={r} />}
        {answer && <Boards boards={answer.boards} onChange={(b) => update((a) => ({ ...a, boards: a.boards.map((x) => (x.boardId === b.boardId ? b : x)) }))} />}
        <div className="jl-row jl-wrap" style={{ gap: 8, justifyContent: 'space-between' }}>
          <span className="jl-small jl-muted">{st.total !== null ? `${st.total} web ${st.total === 1 ? 'job' : 'jobs'}` : ''}{r && r.jobs ? ` · ${r.jobs} found so far` : ''}</span>
          <div className="jl-row" style={{ gap: 8 }}>
            {hasPlaces && <Segmented size="small" value={where} onChange={(v) => setWhere(v as 'mine' | 'all')} aria-label="Where the jobs are" options={[{ value: 'mine', label: 'In my places' }, { value: 'all', label: 'Everywhere' }]} />}
            <Select size="small" style={{ width: 150 }} value={sort} onChange={setSort} aria-label="Sort"
              options={[{ value: 'recommended', label: 'Recommended' }, { value: 'top_matched', label: 'Top matched' }, { value: 'most_recent', label: 'Most recent' }]} />
          </div>
        </div>
      </div>
      <div ref={scrollRef} className="jl-list-scroll" style={{ paddingTop: 8 }}>{body}</div>
      <Drawer open={showAll} onClose={() => setShowAll(false)} width={720} title={`All search results (${results.length})`}>
        <AllResults results={results} onAdded={(url, jobId) => update((a) => ({ ...a, results: a.results.map((x) => (x.url === url ? { ...x, jobId } : x)) }))} />
      </Drawer>
    </div>
  );
}

function ReadingLine({ r }: { r: WebReadStatus }) {
  const done = r.read;
  const total = r.read + r.queued;
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="jl-row" style={{ gap: 10 }} role="status" aria-live="polite">
      <div style={{ flex: '0 0 160px', height: 6, borderRadius: 3, background: 'var(--jl-input)', overflow: 'hidden' }}>
        <div className="jl-web-progress" style={{ width: `${Math.max(pct, 4)}%`, height: '100%', background: 'var(--jl-accent, #0A8F5C)', transition: 'width 400ms ease' }} />
      </div>
      <span className="jl-small jl-muted">Reading the job pages found: {r.queued} left · {r.added} new {r.added === 1 ? 'job' : 'jobs'}{r.closed ? ` · ${r.closed} closed` : ''}. One page a second per site.</span>
    </div>
  );
}

/** The search's results by kind, for the browser (the job pages among them are cards already, or being read). */
function AllResults({ results, onAdded }: { results: WebSearchResult[]; onAdded: (url: string, jobId: string) => void }) {
  const groups: Array<{ key: WebSearchResult['kind']; title: string; hint: string }> = [
    { key: 'board_job', title: 'Jobs on boards jobleft reads', hint: 'Each one becomes a card in Web jobs once it is read.' },
    { key: 'page', title: 'Job pages on other sites', hint: 'Read once each, if the site allows it (robots.txt); open jobs become cards.' },
    { key: 'board', title: 'Board pages', hint: 'Whole job boards. Follow one (above the cards) to get its jobs in your feed.' },
    { key: 'list', title: 'Job lists on job sites', hint: 'Search pages that list many jobs. Open one in your browser; to keep a job from it, add that job\'s own link in External.' },
  ];
  const never = results.filter((x) => x.kind === 'never');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p className="jl-small jl-muted" style={{ margin: 0 }}>Your words went to your SearXNG, which asked the search engines. jobleft never opens LinkedIn, Indeed or Glassdoor.</p>
      {groups.map((g) => {
        const list = results.filter((x) => x.kind === g.key);
        if (!list.length) return null;
        return (
          <section key={g.key} aria-label={g.title} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h2 className="jl-subhead" style={{ margin: '4px 0 0' }}>{g.title} <span className="jl-muted">({list.length})</span></h2>
            <p className="jl-small jl-muted" style={{ margin: 0 }}>{g.hint}</p>
            {list.map((x) => <ResultRow key={x.url} r={x} onAdded={(jobId) => onAdded(x.url, jobId)} />)}
          </section>
        );
      })}
      {never.length > 0 && (
        <Collapse items={[{
          key: 'never', label: `Sites jobleft never opens (${never.length})`,
          children: (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <p className="jl-small jl-muted" style={{ margin: 0 }}>LinkedIn, Indeed, Glassdoor, Workday and some others do not allow programs like jobleft. Open a job in your browser; to keep it, paste its text in the External tab.</p>
              {never.map((x) => <ResultRow key={x.url} r={x} onAdded={() => undefined} />)}
            </div>
          ),
        }]} />
      )}
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
