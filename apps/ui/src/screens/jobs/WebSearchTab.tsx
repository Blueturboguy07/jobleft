// Jobs > Web jobs: a search of the whole web for jobs, through the person's own SearXNG (Settings > Web search).
// The results are a search engine's page: links to every kind of site (employers' own career pages, government and
// other job sites), each with what jobleft found when it read the page (a job posting and where it is, a list of
// jobs, closed, not a job). Job boards are left out: they are followed in Settings > Job sources. The big job
// sites jobleft never contacts (LinkedIn, Indeed, Glassdoor) are offered as the same search, in the browser.
// The job postings it read are also cards (Job postings), with the match, the details and Apply.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Dropdown, Input, Segmented, Select, Switch, Tag, Tooltip } from 'antd';
import { BellOutlined, DownOutlined, ExportOutlined, GlobalOutlined, LoadingOutlined, SearchOutlined, StarOutlined } from '@ant-design/icons';
import type { JobFilter, JobSort, WebReadStatus, WebResultOutcome, WebSavedSearch, WebSearchRequest, WebSearchResponse, WebSearchResult } from '@jobleft/contracts';
import { call, openExternal, type UiError } from '../../app/api.ts';
import { invalidate, load as reload, useApi } from '../../app/data.ts';
import { ui } from '../../app/layers.ts';
import { navigate } from '../../app/router.ts';
import { profileIsSet, useAiSettings, useAppSettings, useProfile } from '../../app/session.ts';
import { JobCard } from '../../components/JobCard.tsx';
import { EmptyState, InlineError, Loading, SkeletonCards } from '../../components/States.tsx';
import { VirtualList } from '../../components/VirtualList.tsx';
import { countryName } from '../../lib/countries.ts';
import { cleanFilter } from '../../lib/filters.ts';
import { ago } from '../../lib/format.ts';
import { useCardActions } from './cardActions.tsx';
import { GAP, ROW, useJobPages } from './Feed.tsx';

type Range = NonNullable<WebSearchRequest['timeRange']> | 'any';

/** The last search, its answer and the view, kept while the app runs, so switching tabs loses nothing. */
let last: { q: string; place: string; range: Range; answer: WebSearchResponse | null; page: number } | null = null;
let view: { mode: 'results' | 'jobs'; onlyHere: boolean; sort: JobSort } = { mode: 'results', onlyHere: true, sort: 'recommended' };
/** The person's choice for "Widen with AI" while the app runs (null: on when an AI provider is set up). */
let widenChoice: boolean | null = null;

/** The first of the profile's titles ("SOC Analyst, Security Analyst" -> "SOC Analyst"). */
function firstTitle(s: string | undefined): string {
  return (s ?? '').split(/\s*[,;|]\s*/)[0]?.trim() ?? '';
}

export function WebSearchTab() {
  const settings = useAppSettings();
  const profile = useProfile();
  const p = profile.data;
  const country = (p as unknown as { personal?: { country?: string | null } } | undefined)?.personal?.country ?? null;
  const defaultPlace = p?.preferences.places[0]?.text ?? (p?.preferences.countries[0] ? countryName(p.preferences.countries[0]) : country ? countryName(country) : '');
  const [q, setQ] = useState(last?.q ?? firstTitle(p?.preferences.targetTitles[0] ?? p?.preferences.jobFunctions[0]));
  const [place, setPlace] = useState(last?.place ?? defaultPlace);
  const [range, setRange] = useState<Range>(last?.range ?? 'month');
  const [answer, setAnswer] = useState<WebSearchResponse | null>(last?.answer ?? null);
  const [page, setPage] = useState(last?.page ?? 1);
  const [busy, setBusy] = useState<'search' | 'more' | null>(null);
  const [err, setErr] = useState<UiError | null>(null);
  const [mode, setMode] = useState(view.mode);
  const [onlyHere, setOnlyHere] = useState(view.onlyHere);
  const [sort, setSort] = useState(view.sort);
  const ai = useAiSettings();
  const aiOn = !!ai.data?.provider;
  const [widenPick, setWidenPick] = useState<boolean | null>(widenChoice);
  const widen = aiOn && (widenPick ?? true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!p || last) return;
    setQ((v) => v || firstTitle(p.preferences.targetTitles[0] ?? p.preferences.jobFunctions[0]));
    setPlace((v) => v || defaultPlace);
  }, [!!p]);
  useEffect(() => { view = { mode, onlyHere, sort }; }, [mode, onlyHere, sort]);

  // Saved searches; a click on one fills the boxes, then searches.
  const saved = useApi<WebSavedSearch[]>('websearch:saved', () => call('listWebSaved'));
  const pendingRun = useRef(false);
  const searchRef = useRef<() => void>(() => undefined);
  useEffect(() => { if (pendingRun.current) { pendingRun.current = false; searchRef.current(); } }, [q, place, range]);

  // What came of reading each result; asked again while pages are being read.
  const here = answer?.country ?? null;
  const urls = useMemo(() => (answer?.results ?? []).map((r) => r.url), [answer]);
  const [outcomes, setOutcomes] = useState<Map<string, WebResultOutcome>>(new Map());
  const reading = useApi<WebReadStatus>('websearch:reading', () => call('webReadStatus'));
  const active = !!reading.data && (reading.data.running || reading.data.queued > 0);
  useEffect(() => {
    if (!urls.length) { setOutcomes(new Map()); return; }
    let stop = false;
    const ask = async () => {
      try {
        const r = await call('webSearchOutcomes', { body: { urls, ...(here ? { country: here } : {}) } });
        if (!stop) setOutcomes(new Map(r.map((o) => [o.url, o])));
      } catch { /* the next look tries again */ }
    };
    void ask();
    const t = setInterval(() => { void ask(); void reload('websearch:reading'); }, 1500);
    return () => { stop = true; clearInterval(t); };
  }, [urls, here]);
  const pending = urls.some((u) => { const s = outcomes.get(u)?.state; return !s || s === 'queued' || s === 'reading'; });

  // The job postings it read, as cards: in the country asked for (postings that state no place included), or all.
  const filter: JobFilter = useMemo(() => (onlyHere && here
    ? cleanFilter({ sources: ['external:web'], countries: [here], includeUnknown: ['place'] })
    : { sources: ['external:web'] }), [onlyHere, here]);
  const { st, load, more: moreJobs, ops } = useJobPages(filter, sort, '');
  const actions = useCardActions(ops);
  const jobsSeen = useRef(reading.data?.jobs ?? 0);
  useEffect(() => { const n = reading.data?.jobs ?? 0; if (n !== jobsSeen.current) { jobsSeen.current = n; void load(true); } }, [reading.data?.jobs]);

  if (settings.error && !settings.data) return <div className="jl-list-pane"><InlineError error={settings.error} /></div>;
  if (!settings.data) return <div className="jl-list-pane"><Loading label="Loading" /></div>;
  if (!settings.data.webSearch?.url) {
    return (
      <div className="jl-list-pane">
        <EmptyState art="search" title="Web search is not set up"
          text="Web jobs searches the whole web for jobs through your own SearXNG, a search engine you run yourself. Add its address once in Settings, then search here."
          action={<Button type="primary" shape="round" onClick={() => navigate('settings/websearch')}>Set up web search</Button>} />
      </div>
    );
  }

  const request = (n: number): WebSearchRequest => ({ q: q.trim(), ...(place.trim() ? { place: place.trim() } : {}), ...(range !== 'any' ? { timeRange: range } : {}), ...(n > 1 ? { page: n } : {}), ...(widen ? { widen: true } : {}) });
  const search = async () => {
    if (!q.trim()) return;
    setBusy('search'); setErr(null);
    try {
      const r = await call('webSearchJobs', { body: request(1) });
      setAnswer(r); setPage(1); setMode('results');
      last = { q, place, range, answer: r, page: 1 };
      void reload('websearch:reading');
      scrollRef.current?.scrollTo({ top: 0 });
    } catch (e) { setErr(e as UiError); } finally { setBusy(null); }
  };
  searchRef.current = () => { void search(); };
  const more = async () => {
    if (!answer) return;
    setBusy('more'); setErr(null);
    try {
      const r = await call('webSearchJobs', { body: request(page + 1) });
      const have = new Set(answer.results.map((x) => x.url));
      const merged = { ...r, results: [...answer.results, ...r.results.filter((x) => !have.has(x.url))], unresponsive: [...new Set([...answer.unresponsive, ...r.unresponsive])].sort() };
      setAnswer(merged); setPage(page + 1);
      last = { q, place, range, answer: merged, page: page + 1 };
      void reload('websearch:reading');
      if (merged.results.length === answer.results.length) ui.message?.info('No more new results. Try other words or a wider place.');
    } catch (e) { setErr(e as UiError); } finally { setBusy(null); }
  };
  const saveSearch = async () => {
    try {
      await call('addWebSaved', { body: { q: q.trim(), ...(place.trim() ? { place: place.trim() } : {}), everyHours: 24, ...(widen ? { widen: true } : {}) } });
      invalidate('websearch:saved');
      ui.message?.success('Saved. jobleft runs this search every day while it runs and tells you about new job postings.');
    } catch (e) { ui.message?.error((e as UiError).message); }
  };
  const runSaved = (x: WebSavedSearch) => { setQ(x.q); setPlace(x.place ?? ''); setRange('week'); pendingRun.current = true; };

  const results = answer?.results ?? [];
  const hiddenElsewhere = onlyHere && here ? results.filter((r) => outcomes.get(r.url)?.inPlace === false).length : 0;
  const shown = results.filter((r) => !(onlyHere && here && outcomes.get(r.url)?.inPlace === false));
  const postings = results.filter((r) => { const s = outcomes.get(r.url)?.state; return s === 'job' || s === 'known'; }).length;
  const hereName = here ? countryName(here) : null;

  let body;
  if (mode === 'results') {
    if (!answer) body = <EmptyState art="search" title="Search the whole web for jobs" text="Type what you are looking for and where. jobleft searches the web through your SearXNG, then reads each result to tell you which are job postings and where they are." />;
    else if (!results.length) body = <EmptyState art="search" title="Nothing found" text={answer.message} />;
    else body = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '4px 16px 16px', maxWidth: 860 }}>
        {shown.map((r) => <SerpRow key={r.url} r={r} o={outcomes.get(r.url) ?? null} hereName={hereName} />)}
        {hiddenElsewhere > 0 && <p className="jl-small jl-muted" style={{ margin: '8px 0' }}>{hiddenElsewhere} {hiddenElsewhere === 1 ? 'job posting' : 'job postings'} outside {hereName} hidden. <Button size="small" type="link" onClick={() => setOnlyHere(false)}>Show them</Button></p>}
        {page < 5 && <Button shape="round" style={{ alignSelf: 'center', marginTop: 8 }} loading={busy === 'more'} disabled={!!busy} onClick={() => { void more(); }}>More results</Button>}
      </div>
    );
  } else {
    if (st.error && !st.items.length) body = <InlineError error={st.error} />;
    else if (st.loading && !st.items.length) body = <SkeletonCards n={3} />;
    else if (!st.items.length) body = <EmptyState art="search" title={pending ? 'Reading the results' : 'No job postings yet'} text={pending ? 'Each job posting becomes a card here as soon as jobleft has read it.' : 'None of the pages read so far was an open job posting here. Try other words, or More results.'} />;
    else body = <VirtualList items={st.items} rowHeight={ROW} gap={GAP} keyOf={(x) => x.job.id} scrollRef={scrollRef} onNearEnd={moreJobs} label="Web job postings"
      render={(it) => <JobCard item={it} profileSet={profileIsSet(p)} actions={actions} now={Date.now()} />} />;
  }

  return (
    <div className="jl-list-pane">
      <div style={{ padding: '12px 16px 8px', display: 'flex', flexDirection: 'column', gap: 8, borderBottom: '1px solid var(--jl-line)' }}>
        <form className="jl-row jl-wrap" onSubmit={(e) => { e.preventDefault(); void search(); }} style={{ gap: 8 }}>
          <Input size="large" style={{ flex: '2 1 240px' }} prefix={<SearchOutlined aria-hidden="true" />} value={q} onChange={(e) => setQ(e.target.value)} maxLength={200} placeholder="What: a job title, or several with commas" aria-label="What to search for" />
          <Input size="large" style={{ flex: '1 1 160px' }} prefix={<GlobalOutlined aria-hidden="true" />} value={place} onChange={(e) => setPlace(e.target.value)} maxLength={200} placeholder="Where: a city or country" aria-label="Where" />
          <Select size="large" style={{ width: 140 }} value={range} onChange={setRange} aria-label="How recent"
            options={[{ value: 'week', label: 'Past week' }, { value: 'month', label: 'Past month' }, { value: 'year', label: 'Past year' }, { value: 'any', label: 'Any time' }]} />
          <Button size="large" type="primary" shape="round" htmlType="submit" loading={busy === 'search'} disabled={!q.trim() || !!busy}>Search the web</Button>
          <Tooltip title={aiOn ? 'Your AI adds titles that mean the same job (in Dutch and English for a Dutch place), so postings that word it differently are found too. One small AI call per new search.' : 'Set up an AI provider in Settings to widen searches with titles that mean the same job.'}>
            <label className="jl-row jl-small" style={{ gap: 6, opacity: aiOn ? 1 : 0.55 }}>
              <Switch size="small" checked={widen} disabled={!aiOn} onChange={(v) => { widenChoice = v; setWidenPick(v); }} aria-label="Widen with AI" /> <StarOutlined aria-hidden="true" /> Widen with AI
            </label>
          </Tooltip>
          <Tooltip title="Run this search by itself every day and get an alert when it finds new job postings">
            <Button size="large" shape="round" icon={<BellOutlined />} disabled={!q.trim()} onClick={() => { void saveSearch(); }}>Save search</Button>
          </Tooltip>
        </form>
        {!!saved.data?.length && <SavedChips list={saved.data} onRun={runSaved} />}
        <InlineError error={err} />
        {busy === 'search' && <Loading label="Searching the web" />}
        {answer && busy !== 'search' && (
          <>
            <div className="jl-row jl-wrap" style={{ gap: 6 }}>
              <span className="jl-small jl-muted">{answer.message}{answer.unresponsive.length ? ` Not answering: ${answer.unresponsive.join(', ')}.` : ''}</span>
              {answer.widenedWith?.length ? (
                <span className="jl-row jl-wrap" style={{ gap: 4 }} aria-label="Titles your AI added">
                  <span className="jl-small jl-muted"><StarOutlined aria-hidden="true" /> Also searched:</span>
                  {answer.widenedWith.map((t) => <Tag key={t} color="purple" style={{ margin: 0 }}>{t}</Tag>)}
                </span>
              ) : null}
              {answer.widenProblem && <span className="jl-small jl-muted">{answer.widenProblem}</span>}
              {answer.searchLinks && answer.searchLinks.length > 0 && <span className="jl-small jl-muted">Also search on:</span>}
              {answer.searchLinks?.map((l) => (
                <Button key={l.name} size="small" shape="round" icon={<ExportOutlined />} iconPosition="end" onClick={() => openExternal(l.url)}>{l.name}</Button>
              ))}
            </div>
            <div className="jl-row jl-wrap" style={{ gap: 10, justifyContent: 'space-between' }}>
              <Segmented value={mode} onChange={(v) => setMode(v as 'results' | 'jobs')} aria-label="Show"
                options={[{ value: 'results', label: `All results (${results.length})` }, { value: 'jobs', label: `Job postings (${postings})` }]} />
              <div className="jl-row" style={{ gap: 10 }}>
                {pending && <span className="jl-small jl-muted"><LoadingOutlined /> Reading the results, one page a second per site</span>}
                {here && <label className="jl-row jl-small" style={{ gap: 6 }}><Switch size="small" checked={onlyHere} onChange={setOnlyHere} aria-label={`Only in ${hereName}`} /> Only in {hereName}</label>}
                {mode === 'jobs' && <Select size="small" style={{ width: 140 }} value={sort} onChange={setSort} aria-label="Sort"
                  options={[{ value: 'recommended', label: 'Recommended' }, { value: 'top_matched', label: 'Top matched' }, { value: 'most_recent', label: 'Most recent' }]} />}
              </div>
            </div>
          </>
        )}
      </div>
      <div ref={scrollRef} className="jl-list-scroll" style={{ paddingTop: 8 }}>{body}</div>
    </div>
  );
}

const AVATAR_COLORS = ['#0A8F5C', '#1F5FAD', '#8A4FBF', '#B5651D', '#2E7D7A', '#A23B5C', '#4E6E1E'];

/** One result, as a search engine shows it, with what jobleft found when it read the page. */
function SerpRow({ r, o, hereName }: { r: WebSearchResult; o: WebResultOutcome | null; hereName: string | null }) {
  let path = '';
  try { const u = new URL(r.url); path = decodeURIComponent(u.pathname).replace(/\/+$/, '').split('/').filter(Boolean).slice(0, 3).join(' › '); } catch { /* the host alone */ }
  const color = AVATAR_COLORS[[...r.host].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_COLORS.length];
  const dim = o && (o.state === 'not_job' || o.state === 'off_topic' || o.state === 'closed' || o.inPlace === false);
  return (
    <article className={`jl-serp${dim ? ' dim' : ''}`}>
      <div className="jl-row" style={{ gap: 10, alignItems: 'flex-start' }}>
        <span className="jl-serp-avatar" style={{ background: color }} aria-hidden="true">{r.host.charAt(0).toUpperCase()}</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="jl-serp-site">{r.host}{path ? <span className="jl-muted"> › {path}</span> : null}</div>
          <a className="jl-serp-title" href={r.url} target="_blank" rel="noopener noreferrer">{r.title}</a>
          {r.snippet && <p className="jl-serp-snippet">{r.snippet}</p>}
          <div className="jl-row jl-wrap" style={{ gap: 6, marginTop: 4 }}>
            <Status r={r} o={o} hereName={hereName} />
            {r.publishedAt && <span className="jl-small jl-muted">{ago(r.publishedAt)}</span>}
            {o?.job && <Button size="small" shape="round" type="primary" onClick={() => navigate(`jobs/${encodeURIComponent(o.job!.id)}`)}>View job</Button>}
          </div>
        </div>
      </div>
    </article>
  );
}

function Status({ r, o, hereName }: { r: WebSearchResult; o: WebResultOutcome | null; hereName: string | null }) {
  if (r.kind === 'never') return <Tooltip title={r.note ?? undefined}><Tag style={{ margin: 0 }}>Open in your browser</Tag></Tooltip>;
  if (r.kind === 'list') return <Tag color="blue" style={{ margin: 0 }}>List of jobs</Tag>;
  const s = o?.state ?? 'unread';
  if (s === 'unread' || s === 'queued' || s === 'reading') return <Tag icon={<LoadingOutlined />} style={{ margin: 0 }}>Checking</Tag>;
  if ((s === 'job' || s === 'known') && o?.job) {
    const where = o.job.places || (o.job.remote ? 'Remote' : 'place not stated');
    if (o.inPlace === false) return <Tag style={{ margin: 0 }}>Job posting outside {hereName}: {where}</Tag>;
    return <Tag color="green" style={{ margin: 0 }}>{s === 'known' ? 'In your jobs' : 'Job posting'} · {where}{o.job.postedAt ? ` · posted ${ago(o.job.postedAt)}` : ''}</Tag>;
  }
  if (s === 'likely_job') return <Tooltip title={o?.message ?? undefined}><Tag color="gold" style={{ margin: 0 }}>Probably a job posting · open to see details</Tag></Tooltip>;
  const label: Record<string, string> = { closed: 'Closed', not_job: 'Not a job posting', off_topic: 'Not about this search', refused: 'Site does not allow programs', failed: 'Could not be read' };
  return <Tooltip title={o?.message ?? undefined}><Tag style={{ margin: 0 }}>{label[s] ?? s}</Tag></Tooltip>;
}

const EVERY_LABEL: Record<number, string> = { 12: 'every 12 hours', 24: 'every day', 0: 'by hand' };

/** The saved searches: a click runs one; its menu changes how often it runs, or deletes it. */
function SavedChips({ list, onRun }: { list: WebSavedSearch[]; onRun: (x: WebSavedSearch) => void }) {
  const change = async (x: WebSavedSearch, key: string) => {
    try {
      if (key === 'delete') await call('deleteWebSaved', { params: { savedId: x.id } });
      else await call('updateWebSaved', { params: { savedId: x.id }, body: { everyHours: Number(key) } });
      invalidate('websearch:saved');
    } catch (e) { ui.message?.error((e as UiError).message); }
  };
  return (
    <div className="jl-row jl-wrap" style={{ gap: 6 }} aria-label="Saved web searches">
      <span className="jl-small jl-muted"><BellOutlined aria-hidden="true" /> Saved:</span>
      {list.map((x) => {
        const name = x.place ? `${x.q} · ${x.place}` : x.q;
        const tip = [`Runs ${EVERY_LABEL[x.everyHours] ?? `every ${x.everyHours} hours`}.`, x.lastRunAt ? `Last run ${ago(x.lastRunAt)}${x.lastNew !== null ? `: ${x.lastNew} new` : ''}.` : '', x.lastError ? `Last run failed: ${x.lastError}` : ''].filter(Boolean).join(' ');
        return (
          <span key={x.id} className="jl-row" style={{ gap: 0, border: `1px solid ${x.lastError ? 'var(--jl-error, #B3261E)' : 'var(--jl-line)'}`, borderRadius: 14 }}>
            <Tooltip title={tip}>
              <Button size="small" type="text" shape="round" onClick={() => onRun(x)} aria-label={`Run the saved search ${name}`}>
                {name}{x.lastNew ? <Tag color="green" style={{ margin: '0 0 0 6px' }}>{x.lastNew} new</Tag> : null}
              </Button>
            </Tooltip>
            <Dropdown trigger={['click']} menu={{
              items: [
                ...([['24', 'Run every day'], ['12', 'Run every 12 hours'], ['0', 'Only when I click it']] as const)
                  .map(([key, label]) => ({ key, label: key === String(x.everyHours) ? `${label} ✓` : label })),
                { type: 'divider' as const },
                { key: 'delete', label: 'Delete', danger: true },
              ],
              onClick: ({ key }) => { void change(x, key); },
            }}>
              <Button size="small" type="text" shape="circle" icon={<DownOutlined />} aria-label={`Options for ${name}`} />
            </Dropdown>
          </span>
        );
      })}
    </div>
  );
}

