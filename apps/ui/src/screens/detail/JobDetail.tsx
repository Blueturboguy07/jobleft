// Job detail, opened over the list (the list stays mounted underneath, so closing returns to the same filters and
// scroll position). Esc or the close button closes it. Shows the full description, every stated fact, the match
// breakdown with its reasons (visible without hovering), sponsorship, company facts with sources, people you know,
// your notes and reminders, and the tools. The apply button opens the employer's own posting in your browser.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Button } from 'antd';
import { Tooltip } from '../../components/Tip.tsx';
import {
  CalendarOutlined, ClockCircleOutlined, CloseOutlined, CopyOutlined, DollarOutlined, EnvironmentOutlined, ExportOutlined, FileTextOutlined,
  HeartFilled, HeartOutlined, HomeOutlined, IdcardOutlined, StopOutlined, TeamOutlined, ApartmentOutlined, AimOutlined, ProfileOutlined, BulbOutlined,
} from '@ant-design/icons';
import { SUB_SCORE_LABELS, type JobDetail as JobDetailT, type TrackerEntry, type TrackerPatch } from '@jobleft/contracts';
import { call, type UiError } from '../../app/api.ts';
import { invalidate, setCached, useApi } from '../../app/data.ts';
import { confirmDiscard, dirtyLabels, ui, useLayer } from '../../app/layers.ts';
import { navigate } from '../../app/router.ts';
import { afterTrackerChange, profileIsSet, useH1bSource, useProfile } from '../../app/session.ts';
import { openChat } from '../../components/chatStore.ts';
import { IconAssistant, IconInterview, IconResume } from '../../components/Icons.tsx';
import { CompanyMark, sponsorChip, sponsorTip } from '../../components/JobCard.tsx';
import { BAND_WORD, bandOf, chipText, pct, type MatchResultX } from '../../components/Match.tsx';
import { EmptyState, ErrorState, Loading } from '../../components/States.tsx';
import {
  ago, dateText, dateTimeText, jobLink, levelsText, payConvertedText, payExactText, payNotes, payText, statusLabel, textBlocks, typeText, workModelText, yearsText,
} from '../../lib/format.ts';
import { CompanySection, NetworkSection, NotesSection, SecHead, SponsorSection } from './Panels.tsx';
import { CoverLetterDrawer, GapsDrawer, TailorDrawer } from './Tools.tsx';

/** One fact of the posting. `unknown` (JL-feed-10): what to say when the posting does not state it; without it, an unstated fact is left out. */
function Fact({ icon, label, children, unknown }: { icon: ReactNode; label: string; children: ReactNode; unknown?: string }) {
  const empty = children === null || children === undefined || children === '' || children === false;
  if (empty && !unknown) return null;
  return (
    <div className="jl-fact" style={{ alignItems: 'flex-start', whiteSpace: 'normal' }}>
      <span aria-hidden="true" style={{ marginTop: 2 }}>{icon}</span>
      <span><span className="jl-sr">{label}: </span>{empty ? <span className="jl-muted">{unknown}</span> : children}</span>
    </div>
  );
}

function Places({ job }: { job: JobDetailT['job'] }) {
  const [all, setAll] = useState(false);
  const list = job.places.map((p) => p.text).filter(Boolean);
  if (!list.length) return null;
  const shown = all ? list : list.slice(0, 3);
  return (
    <span>
      {shown.join('; ')}
      {list.length > 3 && <Button type="link" size="small" onClick={() => setAll(!all)} style={{ padding: '0 4px', height: 'auto' }}>{all ? 'Show fewer' : `+${list.length - 3} more`}</Button>}
    </span>
  );
}

function MatchPanel({ m, profileSet }: { m: MatchResultX | null; profileSet: boolean }) {
  if (!profileSet) {
    return (
      <div className="jl-match-panel" role="group" aria-label="Match score">
        <strong>Match not scored</strong>
        <p className="jl-small" style={{ marginTop: 6 }}>Add your profile to see how well you match this job.</p>
        <Button size="small" shape="round" style={{ marginTop: 8 }} onClick={() => navigate('profile')}>Add profile</Button>
      </div>
    );
  }
  if (!m) {
    return (
      <div className="jl-match-panel" role="group" aria-label="Match score">
        <strong>Not scored</strong>
        <p className="jl-small" style={{ marginTop: 6 }}>This posting has too little information to score against your profile.</p>
      </div>
    );
  }
  const rows = [
    ['experienceLevel', 'Experience Level'], ['skills', 'Skills'], ['industryExperience', 'Industry Exp.'],
  ] as const;
  return (
    <div className="jl-match-panel" role="group" aria-label={`Match ${pct(m.percent)} percent, ${BAND_WORD[bandOf(m.percent)].toLowerCase()}`}>
      <div className="jl-row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span className="big">{pct(m.percent)}<span style={{ fontSize: 16 }}>%</span></span>
        <span style={{ fontWeight: 700, fontSize: 13 }}>{BAND_WORD[bandOf(m.percent)]}</span>
      </div>
      <div className="inner">
        {rows.map(([k, label]) => {
          const v = m.subScores[k].percent;
          return (
            <div className="row" key={k}>
              <span title={SUB_SCORE_LABELS[k]}>{label}</span>
              {v === null ? <span className="jl-small jl-muted">Not enough info</span> : <b>{pct(v)}<span style={{ fontSize: 11 }}>%</span></b>}
            </div>
          );
        })}
      </div>
      {m.complete === false && <p className="jl-small" style={{ marginTop: 8 }}>Limited information: parts of this posting could not be judged.</p>}
      <a href="#sec-why" onClick={(e) => { e.preventDefault(); document.getElementById('sec-why')?.scrollIntoView({ behavior: 'smooth' }); }} className="jl-small" style={{ display: 'inline-block', marginTop: 6 }}>See why</a>
    </div>
  );
}

function Why({ m }: { m: MatchResultX }) {
  const parts = [['experienceLevel', m.subScores.experienceLevel], ['skills', m.subScores.skills], ['industryExperience', m.subScores.industryExperience]] as const;
  return (
    <section className="jl-detail-sec" aria-labelledby="sec-why-h" id="sec-why">
      <SecHead icon={<AimOutlined />} title="Why this score" id="sec-why-h" />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        {parts.map(([k, s]) => (
          <div key={k} className="jl-factbox">
            <strong>{SUB_SCORE_LABELS[k]}: {s.percent === null ? 'not enough information' : `${pct(s.percent)}%`}</strong>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{s.reasons.map((r, i) => <li key={i}>{r.text}</li>)}</ul>
          </div>
        ))}
      </div>
      {(m.skills.matched.length > 0 || m.skills.missing.length > 0) && (
        <>
          <h3 className="jl-subhead">Skills the posting names</h3>
          <div className="jl-row jl-wrap">
            {m.skills.matched.map((s) => <span key={s} className="jl-tag have">✓ {s}<span className="jl-sr"> (in your profile)</span></span>)}
            {m.skills.missing.map((s) => <span key={s} className="jl-tag grey">{s}<span className="jl-sr"> (not in your profile)</span></span>)}
          </div>
          <p className="jl-small jl-muted" style={{ marginTop: 6 }}>Green: in your profile. Grey: not in your profile. Change your skills in your profile.</p>
        </>
      )}
      {m.notes && m.notes.length > 0 && <p className="jl-small" style={{ marginTop: 8 }}>{m.notes.join(' ')}</p>}
      <p className="jl-small jl-muted" style={{ marginTop: 8 }}>The score stays the same until your profile or this posting changes.</p>
    </section>
  );
}

export function JobDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const d = useApi<JobDetailT>(`job:${id}`, () => call('getJob', { params: { jobId: id } }), { revalidate: true });
  const profile = useProfile();
  const h1bSrc = useH1bSource();
  const [tab, setTab] = useState<'overview' | 'company'>('overview');
  const [tool, setTool] = useState<'tailor' | 'letter' | 'gaps' | null>(null);
  const [hint, setHint] = useState(() => { try { return sessionStorage.getItem('jobleft.eschint') !== '1'; } catch { return true; } });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const close = async () => {
    if (dirtyLabels().length && !(await confirmDiscard())) return;
    onClose();
  };
  useLayer(true, () => { void close(); });
  // focus goes to the close button once the job is on screen (not before: the button does not exist while it loads)
  useEffect(() => { closeRef.current?.focus({ preventScroll: true }); scrollRef.current?.scrollTo({ top: 0 }); }, [id, !!d.data]);
  useEffect(() => {
    const pane = scrollRef.current;
    if (!pane) return;
    const onScroll = () => {
      const c = document.getElementById('sec-company-anchor');
      if (!c) return;
      setTab(c.getBoundingClientRect().top - pane.getBoundingClientRect().top < 160 ? 'company' : 'overview');
    };
    pane.addEventListener('scroll', onScroll, { passive: true });
    return () => pane.removeEventListener('scroll', onScroll);
  }, [d.data]);

  const setEntry = (e: TrackerEntry) => setCached<JobDetailT>(`job:${id}`, (old) => (old ? { ...old, tracker: e } : old!));
  const patch = async (body: TrackerPatch, ok: string) => {
    try {
      const e = await call('updateTracker', { params: { jobId: id }, body });
      setEntry(e);
      afterTrackerChange();
      ui.message?.success(ok);
    } catch (err) { ui.message?.error((err as UiError).message); }
  };

  if (d.error && !d.data) {
    return (
      <div className="jl-detail-main">
        <div className="jl-actionbar"><Button ref={closeRef} shape="circle" icon={<CloseOutlined />} aria-label="Close job detail" onClick={() => { void close(); }} /></div>
        {d.error.status === 404
          ? <EmptyState art="box" title="This job is not in your saved jobs" text="It may have been removed. Go back to your list." action={<Button type="primary" shape="round" onClick={onClose}>Back to the list</Button>} />
          : <ErrorState error={d.error} onRetry={() => { void d.reload(); }} />}
      </div>
    );
  }
  if (!d.data) return (
    <div className="jl-detail-main">
      <div className="jl-actionbar"><Button ref={closeRef} shape="circle" icon={<CloseOutlined />} aria-label="Close job detail and return to the list" onClick={() => { void close(); }} /></div>
      <Loading label="Opening the job" onRetry={() => { void d.reload(); }} />
    </div>
  );

  const { job, company, tracker, networkCount, h1bTag } = d.data;
  const match = d.data.match as MatchResultX | null;
  const profileSet = profileIsSet(profile.data);
  const closed = job.status === 'closed';
  // A job pasted without a link has no page to open or copy (JL-feed-16: never the placeholder address).
  const link = jobLink(job.url);
  const applyUrl = jobLink(job.applyUrl) ?? link;
  const sponsor = sponsorChip(h1bTag);
  const posted = job.postedAt ? `Posted ${ago(job.postedAt)}` : 'Posted date not listed';
  const blocks = textBlocks(job.description);
  const tools = [
    { k: 'tailor' as const, icon: <IconResume size={18} />, t: 'Tailor your resume', s: 'Draft changes from your profile; you choose what to keep', hi: true },
    { k: 'letter' as const, icon: <FileTextOutlined />, t: 'Write a cover letter', s: 'A short letter that only uses your facts' },
    { k: 'gaps' as const, icon: <ProfileOutlined />, t: 'Check keyword gaps', s: 'Free, on this Mac: what your resume is missing' },
  ];
  const toolButtons = (
    <>
      {tools.map((x) => (
        <button type="button" key={x.k} className={`jl-tool${x.hi ? ' hi' : ''}`} onClick={() => setTool(x.k)}>
          <span className="t">{x.icon} {x.t}</span><span className="s">{x.s}</span>
        </button>
      ))}
      <button type="button" className="jl-tool" onClick={() => navigate(`interview?job=${encodeURIComponent(job.id)}`)}>
        <span className="t"><IconInterview size={18} /> Practice interview questions</span><span className="s">Questions made from this posting</span>
      </button>
      <button type="button" className="jl-tool" onClick={() => openChat({ jobId: job.id, title: `${job.title} at ${job.company}` })}>
        <span className="t"><IconAssistant size={18} /> Ask the assistant</span><span className="s">Questions about this job and your fit</span>
      </button>
    </>
  );

  return (
    <div className="jl-2col">
      <div className="jl-detail-main" ref={scrollRef} role="region" aria-label={`Job: ${job.title} at ${job.company}`}>
        <div className="jl-actionbar">
          <Tooltip title="Close (Esc)"><Button ref={closeRef} shape="circle" icon={<CloseOutlined />} aria-label="Close job detail and return to the list" onClick={() => { void close(); }} /></Tooltip>
          {closed && <span className="jl-chip closed" style={{ height: 32, padding: '0 10px' }}>Posting closed {dateText(job.closedAt)}</span>}
          {tracker?.status && <span className="jl-chip dark" style={{ height: 32, padding: '0 10px' }}>{statusLabel(tracker.status)}</span>}
          {networkCount && <span className="jl-chip" style={{ height: 32, padding: '0 10px' }}><TeamOutlined /> You know {networkCount} {networkCount === 1 ? 'person' : 'people'} at {job.company}</span>}
          <span style={{ marginLeft: 'auto' }} />
          <Tooltip title={tracker?.hidden ? 'Show again' : 'Not interested'}>
            <Button shape="circle" className={`jl-icon-btn${tracker?.hidden ? ' on' : ''}`} icon={<StopOutlined />} aria-pressed={!!tracker?.hidden} aria-label={tracker?.hidden ? 'Show this job again' : 'Not interested in this job'}
              onClick={() => { void patch({ hidden: !tracker?.hidden }, tracker?.hidden ? 'Shown again.' : 'Hidden. It will not show in your results.'); }} />
          </Tooltip>
          <Tooltip title={tracker?.liked ? 'Liked' : 'Like'}>
            <Button shape="circle" className="jl-icon-btn" icon={tracker?.liked ? <HeartFilled style={{ color: '#C8232A' }} /> : <HeartOutlined />} aria-pressed={!!tracker?.liked} aria-label={tracker?.liked ? 'Unlike this job' : 'Like this job'}
              onClick={() => { void patch({ liked: !tracker?.liked }, tracker?.liked ? 'Removed from Liked.' : 'Added to Liked.'); }} />
          </Tooltip>
          {!tracker?.status && <Button shape="round" onClick={() => { void patch({ status: 'applied' }, 'Marked as applied.'); }}>Mark as applied</Button>}
          {closed ? (
            <Tooltip title="The employer closed this posting. The page may be gone.">
              <Button shape="round" className="jl-caps" disabled>Posting closed</Button>
            </Tooltip>
          ) : !applyUrl ? (
            <Tooltip title="This job was pasted without a link, so there is no employer page to open.">
              <Button shape="round" className="jl-caps" disabled>No apply link</Button>
            </Tooltip>
          ) : (
            <Button shape="round" className="jl-accent-btn jl-caps" href={applyUrl} target="_blank" rel="noopener noreferrer" icon={<ExportOutlined />} iconPosition="end" aria-label="Apply on the employer's site (opens your browser)">
              Apply on employer site
            </Button>
          )}
        </div>
        {hint && (
          <div className="jl-row" style={{ background: '#111', color: '#fff', borderRadius: 10, padding: '8px 12px', marginBottom: 10, fontSize: 13 }} role="note">
            <span className="jl-grow">Press <span className="jl-kbd">Esc</span> to close this job and return to your list where you were.</span>
            <Button size="small" type="text" style={{ color: '#fff' }} onClick={() => { setHint(false); try { sessionStorage.setItem('jobleft.eschint', '1'); } catch { /* ignore */ } }} aria-label="Hide this tip">Got it</Button>
          </div>
        )}
        {closed && <Alert type="warning" showIcon style={{ marginBottom: 10 }} message={`This posting closed on ${dateText(job.closedAt)}. It is kept here with your status, notes and reminders.`} />}
        <div className="jl-detail-card">
          <div className="jl-detail-tabs" role="tablist" aria-label="Job sections">
            <button type="button" role="tab" aria-selected={tab === 'overview'} className="jl-detail-tab" onClick={() => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}>Overview</button>
            <button type="button" role="tab" aria-selected={tab === 'company'} className="jl-detail-tab" onClick={() => document.getElementById('sec-company-anchor')?.scrollIntoView({ behavior: 'smooth' })}>Company</button>
            <span style={{ marginLeft: 'auto' }} />
            {link ? (<>
              <Button type="text" icon={<CopyOutlined />} onClick={() => { void navigator.clipboard?.writeText(link).then(() => ui.message?.success('Link copied.')); }}>Copy link</Button>
              <Button type="text" icon={<FileTextOutlined />} href={link} target="_blank" rel="noopener noreferrer">Original posting</Button>
            </>) : <span className="jl-small jl-muted">Pasted without a link</span>}
          </div>

          <section className="jl-detail-sec" aria-label="Job summary">
            <div className="jl-row" style={{ gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div className="jl-grow" style={{ minWidth: 300 }}>
                <div className="jl-row" style={{ gap: 12 }}>
                  <CompanyMark name={job.company} keyText={job.companyKey} size={48} />
                  <span><strong>{job.company}</strong> · <span title={job.postedAt ? dateTimeText(job.postedAt) ?? undefined : undefined}>{posted}</span></span>
                </div>
                <h1 style={{ fontSize: 24, fontWeight: 700, margin: '12px 0', overflowWrap: 'anywhere' }}>{job.title}</h1>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '8px 24px' }}>
                  <Fact icon={<EnvironmentOutlined />} label="Location" unknown="Place not stated">{job.places.some((p) => p.text) ? <Places job={job} /> : null}</Fact>
                  <Fact icon={<HomeOutlined />} label="Work model" unknown="Work model not stated">{workModelText(job)}</Fact>
                  <Fact icon={<ClockCircleOutlined />} label="Job type" unknown="Job type not stated">{typeText(job.employmentType)}</Fact>
                  <Fact icon={<IdcardOutlined />} label="Level" unknown="Level not stated">{levelsText(job.levels)}</Fact>
                  <Fact icon={<CalendarOutlined />} label="Experience" unknown="Years of experience not stated">{yearsText(job.yearsRequired)}</Fact>
                  <Fact icon={<ApartmentOutlined />} label="Department">{job.department}</Fact>
                  <Fact icon={<DollarOutlined />} label="Pay" unknown="Pay not listed in the posting">
                    {payText(job.pay) && (
                      <span>
                        {payText(job.pay)}
                        {payExactText(job.pay) && <span className="jl-small jl-muted" style={{ display: 'block' }}>{payExactText(job.pay)}</span>}
                        {payConvertedText(job.pay) && <span className="jl-small jl-muted" style={{ display: 'block' }}>{payConvertedText(job.pay)}</span>}
                        {payNotes(job.pay).map((n) => <span key={n} className="jl-small jl-muted" style={{ display: 'block' }}>{n}</span>)}
                      </span>
                    )}
                  </Fact>
                </div>
                <div className="jl-row jl-wrap" style={{ marginTop: 12 }}>
                  {sponsor && <Tooltip title={sponsorTip(h1bTag, h1bSrc)}><span className="jl-fitchip" tabIndex={0}><span className="tick" aria-hidden="true">✓</span>{sponsor.text}</span></Tooltip>}
                  {match?.whyFit.filter((c) => !(sponsor && /sponsor/i.test(chipText(c)))).map((c, i) => (
                    <span key={i} className={`jl-fitchip${c.positive ? '' : ' neg'}`}><span className="tick" aria-hidden="true">{c.positive ? '✓' : '•'}</span>{chipText(c)}</span>
                  ))}
                </div>
              </div>
              <MatchPanel m={match} profileSet={profileSet} />
            </div>
            {match && match.blockers.length > 0 && (
              <Alert type="warning" showIcon style={{ marginTop: 16 }} message="Before you apply"
                description={<ul style={{ margin: 0, paddingLeft: 18 }}>{match.blockers.map((b, i) => <li key={i}>{b.message}{b.evidence && <span className="jl-muted"> (“{b.evidence.text}”)</span>}</li>)}</ul>} />
            )}
            <div className="jl-tools-inline" style={{ marginTop: 16 }}>
              <Button shape="round" onClick={() => setTool('tailor')}>Tailor resume</Button>
              <Button shape="round" onClick={() => setTool('letter')}>Cover letter</Button>
              <Button shape="round" onClick={() => setTool('gaps')}>Keyword gaps</Button>
              <Button shape="round" onClick={() => navigate(`interview?job=${encodeURIComponent(job.id)}`)}>Practice</Button>
              <Button shape="round" onClick={() => openChat({ jobId: job.id, title: `${job.title} at ${job.company}` })}>Ask the assistant</Button>
            </div>
          </section>

          {match && <Why m={match} />}

          <section className="jl-detail-sec jl-desc" aria-labelledby="sec-desc-h">
            <SecHead icon={<BulbOutlined />} title="The posting" id="sec-desc-h" />
            {blocks.length ? blocks.map((b, i) => b.kind === 'h' ? <h3 key={i}>{b.text}</h3> : b.kind === 'p' ? <p key={i}>{b.text}</p> : <ul key={i}>{b.items.map((x, j) => <li key={j}>{x}</li>)}</ul>)
              : <p className="jl-muted">The posting has no description text.</p>}
            <p className="jl-source" style={{ marginTop: 12 }}>
              Seen on {job.sources.map((s, i) => <span key={s.sourceId + i}>{i > 0 && ', '}{jobLink(s.url) ? <a href={jobLink(s.url)!} target="_blank" rel="noopener noreferrer">{s.name}</a> : s.name}{s.credit && <> ({s.credit.text})</>}</span>)}. First seen by jobleft {dateText(job.firstSeenAt)}.
            </p>
          </section>

          <SponsorSection job={job} company={company} />
          <div id="sec-company-anchor" />
          <CompanySection job={job} company={company} />
          <NetworkSection job={job} networkCount={networkCount} />
          <NotesSection job={job} entry={tracker} onChange={setEntry} />
        </div>
      </div>
      <aside className="jl-tools" aria-label="Tools for this job">
        <h2 style={{ fontSize: 16, fontWeight: 700 }}>Tools</h2>
        {toolButtons}
      </aside>
      <TailorDrawer job={job} open={tool === 'tailor'} onClose={() => setTool(null)} />
      <CoverLetterDrawer job={job} open={tool === 'letter'} onClose={() => setTool(null)} />
      <GapsDrawer job={job} open={tool === 'gaps'} onClose={() => setTool(null)} />
    </div>
  );
}

export function invalidateJob(id: string): void {
  invalidate(`job:${id}`);
}
