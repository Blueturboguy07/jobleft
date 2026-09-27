// Before any AI step: where the text goes, and what it costs. With publik the note shows the expected charge to
// the balance (in dollars); with a model on this computer it says nothing leaves this computer. The first time text would
// leave this computer for a service, the person confirms once, naming that service.

import { Button, Space } from 'antd';
import { CloudOutlined, DesktopOutlined, WarningOutlined } from '@ant-design/icons';
import type { AiSettings } from '@jobleft/contracts';
import { formatDollars } from '@jobleft/contracts';
import { invalidate } from '../app/data.ts';
import { ui } from '../app/layers.ts';
import { navigate } from '../app/router.ts';
import { useAiSettings, usePublik } from '../app/session.ts';
import { hostOf } from '../lib/format.ts';
import { dailyLimitReached } from '../lib/dailyLimit.ts';

export type AiKind = 'chatTurn' | 'tailor' | 'coverLetter' | 'outreachDraft' | 'practice';

function isLoopback(url: string | null): boolean {
  if (!url) return false;
  try { const h = new URL(url).hostname; return h === '127.0.0.1' || h === 'localhost' || h === '[::1]'; } catch { return false; }
}

const VENDOR: Record<string, string> = { openai: 'OpenAI', anthropic: 'Anthropic', openrouter: 'OpenRouter', google: 'Google' };

export interface Destination {
  set: boolean;
  remote: boolean;
  label: string;
  charges: boolean;
  costMicros: number | null;
}

export function destinationOf(s: AiSettings | undefined, kind: AiKind): Destination {
  if (!s || !s.provider) return { set: false, remote: false, label: 'no AI provider', charges: false, costMicros: null };
  switch (s.provider) {
    case 'publik': return { set: true, remote: true, label: 'publik', charges: true, costMicros: s.costEstimates?.[kind] ?? null };
    case 'local': return isLoopback(s.baseUrl)
      ? { set: true, remote: false, label: `the model on this computer${s.baseUrl ? ` (${hostOf(s.baseUrl)})` : ''}`, charges: false, costMicros: null }
      : { set: true, remote: true, label: `the model server at ${s.baseUrl ? hostOf(s.baseUrl) : 'an unknown address'}`, charges: false, costMicros: null };
    case 'custom': return { set: true, remote: !isLoopback(s.baseUrl), label: `the AI server at ${s.baseUrl ? hostOf(s.baseUrl) : 'an unknown address'}`, charges: false, costMicros: null };
    case 'own_key': return { set: true, remote: true, label: `${VENDOR[s.vendor ?? ''] ?? 'your AI vendor'} (with your own key)`, charges: false, costMicros: null };
  }
}

/** One line under an AI button. */
export function AiNote({ kind, what }: { kind: AiKind; what: string }) {
  const ai = useAiSettings();
  const d = destinationOf(ai.data, kind);
  const pub = usePublik(d.charges);
  const limited = d.charges && dailyLimitReached(pub.data?.wallet);
  if (!ai.data) return null;
  if (!d.set) {
    return (
      <div className="jl-provider-note" role="note">
        <WarningOutlined /> <span>To {what}, choose where AI answers come from first.</span>
        <Button size="small" type="link" onClick={() => navigate('settings/ai')}>Choose</Button>
      </div>
    );
  }
  return (
    <div className="jl-provider-note" role="note">
      {d.remote ? <CloudOutlined /> : <DesktopOutlined />}
      <span>
        {d.charges
          ? <>Charges your publik balance{d.costMicros !== null ? <>: about <strong>{formatDollars(d.costMicros)}</strong></> : '. The exact charge shows when it finishes'}. Sends the text to publik.{limited ? <> Today's publik spending limit for this computer was reached: a step that would go over it is refused (see Settings &gt; Balance).</> : null}</>
          : d.remote ? <>Sends the text to {d.label}. No charge to your publik balance.</>
            : <>Runs on {d.label}. Nothing leaves this computer and nothing is charged.</>}
      </span>
    </div>
  );
}

const CONSENT_KEY = 'jobleft.ai.consent.v1';

function consentId(s: AiSettings): string {
  return `${s.provider}|${s.baseUrl ?? ''}|${s.vendor ?? ''}`;
}

/**
 * Resolves true when the step may run. The first time text would leave this computer for a service, asks once and names
 * the service. A model on this computer needs no question.
 */
export async function ensureAiConsent(s: AiSettings | undefined, kind: AiKind): Promise<boolean> {
  const d = destinationOf(s, kind);
  if (!d.set) {
    ui.message?.info('Choose where AI answers come from in Settings first.');
    navigate('settings/ai');
    return false;
  }
  if (!d.remote || !s) return true;
  let seen: string[] = [];
  try { seen = JSON.parse(localStorage.getItem(CONSENT_KEY) ?? '[]') as string[]; } catch { seen = []; }
  if (seen.includes(consentId(s))) return true;
  const ok = await ui.modal?.confirm({
    title: `Send text to ${d.label}?`,
    content: (
      <Space direction="vertical">
        <span>This AI step sends the job's text and a short summary of your profile to <strong>{d.label}</strong>. Your contact details, work authorization and equal-employment answers are never sent.</span>
        {d.charges && <span>Each step charges your publik balance{d.costMicros !== null ? ` (about ${formatDollars(d.costMicros)} each)` : ''}. You see the charge after each step.</span>}
        <span>jobleft asks once for each service. You can change the service in Settings at any time, or use a model on this computer so nothing leaves this computer.</span>
      </Space>
    ),
    okText: `Send to ${d.label}`,
    okButtonProps: { shape: 'round' },
    cancelText: 'Not now',
    cancelButtonProps: { shape: 'round' },
  });
  if (!ok) return false;
  try { localStorage.setItem(CONSENT_KEY, JSON.stringify([...seen, consentId(s)])); } catch { /* ask again next time */ }
  return true;
}

/** After a paid step: say what it cost and refresh the balance. */
export function afterAiStep(costMicros: number | null | undefined): void {
  invalidate('ai:publik', 'ai:settings');
  if (costMicros !== null && costMicros !== undefined && costMicros > 0) ui.message?.info(`This step cost ${formatDollars(costMicros)} from your publik balance.`);
}
