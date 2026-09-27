// One job in a list. Shows the facts the posting states and says which ones it does not state. The same numbers as the
// detail view: the match comes from the API as-is. Icon-only buttons have spoken names; hover content (the three
// part-scores) is also reachable with the keyboard through the match tile button.

import { openExternal } from '../lib/external.ts';
import { memo, useRef, useState } from 'react';
import { Button, Dropdown, Popover } from 'antd';
import { Tooltip } from './Tip.tsx';
import {
  ClockCircleOutlined, CalendarOutlined, DollarOutlined, EllipsisOutlined, EnvironmentOutlined, HeartFilled, HeartOutlined, HomeOutlined,
  IdcardOutlined, StopOutlined, TeamOutlined, ExportOutlined,
} from '@ant-design/icons';
import type { JobSummary, MatchResult, TrackerStatus } from '@jobleft/contracts';
import { NOT_STATED, ago, dateText, initials, jobLink, levelsText, monoColor, payText, placesText, statusLabel, typeText, workModelText, yearsText } from '../lib/format.ts';
import { IconAssistant } from './Icons.tsx';
import { MatchTile, PartRings, whySummary, type MatchSummaryX } from './Match.tsx';
import { useApi } from '../app/data.ts';
import { call } from '../app/api.ts';
import { useH1bSource } from '../app/session.ts';

export interface CardItem {
  job: JobSummary;
  match: MatchSummaryX | null;
  liked: boolean;
  hidden: boolean;
  trackerStatus: TrackerStatus | null;
  networkCount: number | null;
  h1bTag: 'likely_by_history' | 'post_says_yes' | 'post_says_no' | null;
  external?: boolean;
}

export interface CardActions {
  open: (jobId: string) => void;
  like: (item: CardItem) => void;
  hide: (item: CardItem) => void;
  ask: (item: CardItem) => void;
  markApplied: (item: CardItem) => void;
  addProfile: () => void;
}

export function CompanyMark({ name, keyText, size = 72 }: { name: string; keyText: string; size?: number }) {
  return <div className="jl-mono" style={{ width: size, height: size, background: monoColor(keyText), fontSize: size * 0.34 }} aria-hidden="true">{initials(name)}</div>;
}

export function sponsorChip(tag: CardItem['h1bTag']): { text: string; tip: string } | null {
  if (tag === 'likely_by_history') return { text: 'H-1B sponsor likely', tip: 'Based on past H-1B filings in US Department of Labor data. Past filings do not promise sponsorship for this role.' };
  if (tag === 'post_says_yes') return { text: 'Posting offers visa sponsorship', tip: 'The posting itself says it offers visa sponsorship.' };
  if (tag === 'post_says_no') return { text: 'Posting says no sponsorship', tip: 'The posting itself says it cannot sponsor a visa. This comes from the posting, not from missing data.' };
  return null;
}

/** The tooltip of a sponsorship chip. History-based chips also name the public data and its date. */
export function sponsorTip(tag: CardItem['h1bTag'], src: { name: string; through: string | null } | null): string | null {
  const c = sponsorChip(tag);
  if (!c) return null;
  if (tag !== 'likely_by_history' || !src) return c.tip;
  return `${c.tip} Source: ${src.name}${src.through ? `, data through ${dateText(src.through)}` : ''}.`;
}

function Fact({ icon, text, tip, unknown }: { icon: React.ReactNode; text: string | null; tip?: string; unknown: string }) {
  if (!text) return <div className="jl-fact">{icon}<span className="txt jl-muted" title={unknown}>{unknown}</span></div>;
  return (
    <div className="jl-fact">
      {icon}
      {tip ? <Tooltip title={tip}><span className="txt" tabIndex={0}>{text}</span></Tooltip> : <span className="txt" title={text}>{text}</span>}
    </div>
  );
}

function CardView({ item, profileSet, actions, now }: { item: CardItem; profileSet: boolean; actions: CardActions; now: number }) {
  const j = item.job;
  const [why, setWhy] = useState(false);
  const [askApplied, setAskApplied] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const full = useApi<MatchResult>(why && item.match ? `match:${j.id}` : null, () => call('getMatch', { params: { jobId: j.id } }));
  const closed = j.status === 'closed';
  const places = placesText(j.places);
  const posted = ago(j.postedAt, now);
  const sponsor = sponsorChip(item.h1bTag);
  const h1bSrc = useH1bSource();
  // A job pasted without a link has no page to open (its placeholder address never loads).
  const link = jobLink(j.url);
  const applyUrl = jobLink(j.applyUrl) ?? link;
  const titleId = `t-${j.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const pay = payText(j.pay);

  const menu = {
    items: [
      { key: 'hide', label: item.hidden ? 'Show this job again' : 'Not interested (hide)' },
      ...(link ? [{ key: 'orig', label: 'Open the original posting' }, { key: 'copy', label: 'Copy the posting link' }] : []),
      ...(item.trackerStatus ? [] : [{ key: 'applied', label: 'Mark as applied' }]),
    ],
    onClick: ({ key }: { key: string }) => {
      if (key === 'hide') actions.hide(item);
      if (key === 'orig' && link) openExternal(link);
      if (key === 'copy' && link) void navigator.clipboard?.writeText(link);
      if (key === 'applied') actions.markApplied(item);
    },
  };

  return (
    <article className="jl-card" aria-labelledby={titleId} data-job-id={j.id}
      onMouseLeave={() => { if (hoverTimer.current) clearTimeout(hoverTimer.current); }}>
      <div className="jl-card-body">
        <div className="jl-card-top">
          <CompanyMark name={j.company} keyText={j.companyKey} />
          <div className="jl-card-head">
            <div className="jl-card-chips">
              {closed && <span className="jl-chip closed">Closed{j.closedAt ? ` ${dateText(j.closedAt)}` : ''}</span>}
              {!closed && posted && <span className="jl-chip time" title={`Posted ${dateText(j.postedAt)}`}>{posted}</span>}
              {item.trackerStatus && <span className="jl-chip dark">{statusLabel(item.trackerStatus)}</span>}
              {item.external && <span className="jl-chip">Added by you</span>}
              {sponsor && <Tooltip title={sponsorTip(item.h1bTag, h1bSrc)}><span className="jl-chip cyan" tabIndex={0}>{sponsor.text}</span></Tooltip>}
              <span style={{ marginLeft: 'auto' }} />
              <Dropdown menu={menu} trigger={['click']}>
                <Button size="small" shape="circle" className="jl-icon-btn" icon={<EllipsisOutlined />} aria-label={`More actions for ${j.title}`} />
              </Dropdown>
            </div>
            {!why && (
              <>
                <Tooltip title={j.title} mouseEnterDelay={0.5}>
                  <h3 className="jl-card-title" id={titleId}>
                    <a href={`#/jobs/${encodeURIComponent(j.id)}`} onClick={(e) => { e.preventDefault(); actions.open(j.id); }}>{j.title}</a>
                  </h3>
                </Tooltip>
                <div className="jl-card-company" title={j.company}>{j.company}{j.department && <span className="sub"> / {j.department}</span>}</div>
              </>
            )}
            {why && (
              <div className="jl-card-why">
                <h3 className="jl-card-title" id={titleId} style={{ fontSize: 16 }}>
                  <a href={`#/jobs/${encodeURIComponent(j.id)}`} onClick={(e) => { e.preventDefault(); actions.open(j.id); }}>Why this match: {j.title}</a>
                </h3>
                <p className="summary">{full.data ? whySummary(full.data) : full.error ? full.error.message : 'Loading the reasons…'}</p>
              </div>
            )}
          </div>
        </div>
        {!why ? (
          <div className="jl-card-facts">
            <Fact icon={<EnvironmentOutlined />} text={places ? `${places.first}` : null} tip={places && places.more ? `All ${places.all.length} places: ${places.all.join('; ')}` : undefined} unknown={NOT_STATED.place} />
            <Fact icon={<ClockCircleOutlined />} text={typeText(j.employmentType)} unknown={NOT_STATED.type} />
            <Fact icon={<DollarOutlined />} text={pay} unknown={NOT_STATED.pay} />
            <Fact icon={<HomeOutlined />} text={workModelText(j)} unknown={NOT_STATED.workModel} />
            <Fact icon={<IdcardOutlined />} text={levelsText(j.levels)} unknown={NOT_STATED.level} />
            <Fact icon={<CalendarOutlined />} text={yearsText(j.yearsRequired)} unknown={NOT_STATED.years} />
            {places && places.more > 0 && <span className="jl-sr">and {places.more} more places</span>}
          </div>
        ) : (
          <div style={{ padding: '10px 0 12px' }}><PartRings m={full.data ?? null} /></div>
        )}
        <div className="jl-card-foot">
          <div className="left">
            {places && places.more > 0 && !why && <span className="jl-more" aria-hidden="true">+{places.more} more places</span>}{' '}
            {item.networkCount ? <span><TeamOutlined /> You know {item.networkCount} {item.networkCount === 1 ? 'person' : 'people'} at {j.company}</span> : null}
          </div>
          <Tooltip title={item.hidden ? 'Show this job again' : 'Not interested'}>
            <Button shape="circle" className={`jl-icon-btn${item.hidden ? ' on' : ''}`} icon={<StopOutlined />} aria-label={item.hidden ? `Show ${j.title} again` : `Not interested in ${j.title}`} aria-pressed={item.hidden} onClick={() => actions.hide(item)} />
          </Tooltip>
          <Tooltip title={item.liked ? 'Liked' : 'Like'}>
            <Button shape="circle" className="jl-icon-btn" icon={item.liked ? <HeartFilled style={{ color: '#C8232A' }} /> : <HeartOutlined />} aria-label={item.liked ? `Unlike ${j.title}` : `Like ${j.title}`} aria-pressed={item.liked} onClick={() => actions.like(item)} />
          </Tooltip>
          <Button shape="round" className="jl-soft-btn jl-caps" icon={<IconAssistant size={16} />} onClick={() => actions.ask(item)} aria-label={`Ask the assistant about ${j.title}`}>Ask</Button>
          {closed ? (
            <Tooltip title={`This posting closed${j.closedAt ? ` on ${dateText(j.closedAt)}` : ''}. The employer page may be gone.`}>
              <Button shape="round" className="jl-caps" disabled>Closed</Button>
            </Tooltip>
          ) : !applyUrl ? (
            <Tooltip title="This job was pasted without a link, so there is no employer page to open.">
              <Button shape="round" className="jl-caps" disabled>No link</Button>
            </Tooltip>
          ) : (
            <Popover open={askApplied} onOpenChange={(o) => { if (!o) setAskApplied(false); }} trigger="click" placement="topRight"
              content={
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 240 }}>
                  <span>Did you apply on the employer's site?</span>
                  <div className="jl-row">
                    <Button size="small" type="primary" shape="round" onClick={() => { setAskApplied(false); actions.markApplied(item); }}>Mark as applied</Button>
                    <Button size="small" shape="round" onClick={() => setAskApplied(false)}>Not yet</Button>
                  </div>
                </div>
              }>
              <Button shape="round" className="jl-accent-btn jl-caps" href={applyUrl} target="_blank" rel="noopener noreferrer"
                icon={<ExportOutlined />} iconPosition="end" aria-label={`Apply for ${j.title} on the employer's site (opens your browser)`}
                onClick={() => { if (!item.trackerStatus) setTimeout(() => setAskApplied(true), 400); }}>
                Apply
              </Button>
            </Popover>
          )}
        </div>
      </div>
      <div onMouseEnter={() => { if (item.match) hoverTimer.current = setTimeout(() => setWhy(true), 250); }}
        onMouseLeave={() => { if (hoverTimer.current) clearTimeout(hoverTimer.current); setWhy(false); }}>
        <MatchTile match={item.match} profileSet={profileSet} expanded={why} onToggle={() => setWhy((w) => !w)} onAddProfile={actions.addProfile}
          sponsorLine={item.h1bTag === 'post_says_no' ? 'Posting says no sponsorship' : null} />
      </div>
    </article>
  );
}

export const JobCard = memo(CardView);
