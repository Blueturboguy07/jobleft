// The match score on screen: one whole-number percent, the band word that follows from it, three part-scores and
// reasons. Card and detail read the SAME numbers from the API; nothing here recomputes or rounds a score.

import { useId } from 'react';
import { Tooltip } from './Tip.tsx';
import { MATCH_BAND_LABELS, SUB_SCORE_LABELS, bandFor, type MatchBand, type MatchResult, type MatchSummary, type WhyFitChip } from '@jobleft/contracts';

/** Optional fields other lanes add (the match lane): shown when present, ignored when absent. */
export type MatchSummaryX = MatchSummary & { complete?: boolean; warning?: string | null; blockerCount?: number };
export type MatchResultX = MatchResult & { complete?: boolean; unknownParts?: string[]; notes?: string[]; cap?: { percent: number; reason: string } | null };

export const BAND_WORD: Record<MatchBand, string> = MATCH_BAND_LABELS;

/** One whole number everywhere: card, tile, detail and spoken labels all read the score through this. */
export function pct(n: number): number {
  return Math.round(n);
}

/** The band always follows the percent (STRONG 85 and above, GOOD 70 to 84, FAIR below 70). */
export function bandOf(percent: number): MatchBand {
  return bandFor(pct(percent));
}

/**
 * The words of a "why you fit" chip. A sponsorship chip is always the hedged statement, whatever label came with
 * it: past filings say "likely", and only the posting itself can say it offers sponsorship.
 */
export function chipText(c: WhyFitChip): string {
  if (c.kind === 'h1b_sponsor_likely') return 'H-1B sponsor likely';
  if (c.kind === 'post_says_sponsors') return 'Posting offers visa sponsorship';
  // One wording for one fact, on the card and the detail (JL-tracker-18).
  if (c.kind === 'post_says_no_sponsorship') return 'Posting says no sponsorship';
  return c.label;
}

export function Ring({ percent, size = 72, stroke = 7, dark = true, label }: { percent: number | null; size?: number; stroke?: number; dark?: boolean; label?: string }) {
  const id = useId().replace(/:/g, '');
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  const big = size >= 64;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label ?? (percent === null ? 'Not enough information' : `${percent} percent`)}>
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#22F6D0" />
          <stop offset="100%" stopColor="#00F0A0" />
        </linearGradient>
      </defs>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={dark ? 'rgba(255,255,255,0.18)' : '#E6F4EE'} strokeWidth={stroke} />
      {percent !== null && (
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={dark ? `url(#g${id})` : '#0A8F5C'} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={`${(c * p) / 100} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      )}
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" fill={dark ? '#fff' : '#000'} style={{ fontFamily: 'var(--jl-font)' }}>
        {percent === null ? <tspan fontSize={big ? 20 : 14} fontWeight={600}>–</tspan> : (
          <><tspan fontSize={big ? 26 : 15} fontWeight={600}>{percent}</tspan><tspan fontSize={big ? 12 : 9} fontWeight={600} dx="1">%</tspan></>
        )}
      </text>
    </svg>
  );
}

function chipLine(c: WhyFitChip, i: number) {
  return (
    <span className="ln" key={i}>
      <span aria-hidden="true">{c.positive ? '✓' : '•'}</span>
      <span>{chipText(c)}</span>
    </span>
  );
}

export interface TileProps {
  match: MatchSummaryX | null;
  profileSet: boolean;
  expanded: boolean;
  onToggle: () => void;
  onAddProfile: () => void;
  sponsorLine: string | null;
}

/** The dark tile at the right of a job card. */
export function MatchTile({ match, profileSet, expanded, onToggle, onAddProfile, sponsorLine }: TileProps) {
  if (!profileSet) {
    return (
      <div className="jl-tile none" role="group" aria-label="Match score">
        <Ring percent={null} label="No match score yet" />
        <span className="band" style={{ fontSize: 12 }}>Match not scored</span>
        <span className="note">Add your profile to see how well you match.</span>
        <button type="button" onClick={onAddProfile} style={{ marginTop: 'auto', background: '#fff', color: '#000', border: 0, borderRadius: 14, padding: '4px 12px', fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>Add profile</button>
      </div>
    );
  }
  if (!match) {
    return (
      <div className="jl-tile none" role="group" aria-label="Match score">
        <Ring percent={null} label="Not enough information to score" />
        <span className="band" style={{ fontSize: 12 }}>Not scored</span>
        <span className="note">This posting has too little information to score.</span>
      </div>
    );
  }
  const lines = [...match.whyFit.slice(0, 2)];
  const percent = pct(match.percent);
  const band = bandOf(match.percent);
  return (
    <Tooltip title="How well this job fits your profile: experience level, skills and industry experience. Select it to see the three parts." placement="left" mouseEnterDelay={0.6}>
      <button type="button" className={`jl-tile ${band}`} onClick={onToggle} aria-expanded={expanded}
        aria-label={`Match ${percent} percent, ${BAND_WORD[band].toLowerCase()}. ${expanded ? 'Hide' : 'Show'} the parts of this score.`}>
        <Ring percent={percent} />
        <span className="band">{BAND_WORD[band]}</span>
        <span className="rule" />
        <span className="lines">
          {lines.map(chipLine)}
          {sponsorLine && lines.every((l) => !/sponsor/i.test(chipText(l))) && <span className="ln"><span aria-hidden="true">•</span><span>{sponsorLine}</span></span>}
          {match.complete === false && <span className="ln"><span aria-hidden="true">•</span><span>Limited information</span></span>}
        </span>
      </button>
    </Tooltip>
  );
}

/** The three part-scores as small rings (card back face). */
export function PartRings({ m }: { m: MatchResult | null }) {
  const parts = [
    ['experienceLevel', m?.subScores.experienceLevel.percent == null ? null : pct(m.subScores.experienceLevel.percent)],
    ['skills', m?.subScores.skills.percent == null ? null : pct(m.subScores.skills.percent)],
    ['industryExperience', m?.subScores.industryExperience.percent == null ? null : pct(m.subScores.industryExperience.percent)],
  ] as const;
  return (
    <div className="jl-row" style={{ gap: 24, flexWrap: 'wrap' }}>
      {parts.map(([k, v]) => (
        <div className="jl-row" key={k} style={{ gap: 8 }}>
          <Ring percent={m ? v : null} size={52} stroke={5} dark={false} label={`${SUB_SCORE_LABELS[k]}: ${v === null ? 'not enough information' : `${v} percent`}`} />
          <span style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.2, maxWidth: 90 }}>{SUB_SCORE_LABELS[k]}{m && v === null && <span className="jl-muted" style={{ display: 'block', fontWeight: 400, fontSize: 11 }}>Not enough info</span>}</span>
        </div>
      ))}
    </div>
  );
}

/** One short summary sentence for the card back face, taken from the result's own reasons. */
export function whySummary(m: MatchResult): string {
  const r = [...m.subScores.skills.reasons, ...m.subScores.experienceLevel.reasons, ...m.subScores.industryExperience.reasons];
  return r.slice(0, 2).map((x) => x.text).join(' ') || 'No reasons were recorded for this score.';
}
