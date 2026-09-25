// The service worker: the only part of the extension that talks to the app, and it talks to nothing else.
// Every request goes to http://127.0.0.1:<one of the app's ports>/api/v1/... with the pairing token in a header.
// It holds the token (chrome.storage.local, trusted contexts only), finds the app, runs a fill when the person asks,
// and relays the report to the panel. It never sends page text: only the fields' own labels and options.

import {
  DEFAULT_PORT, DraftResponseSchema, EXTENSION_PROTOCOL_VERSION, ExtensionStatusSchema, FillResponseSchema, HealthSchema, PageInfoSchema,
  PAIRING_TOKEN_HEADER, PairResponseSchema, PORT_SPAN, ReviewResponseSchema, formatDollars, validate,
} from '@jobleft/contracts';
import type { FillRequest, FillResponse, FormField, JsonSchema, PageInfo } from '@jobleft/contracts';
import type { ApplyInput, CollectResult, ConnState, PopupState, ProbeResult, Report, ToContent, ToWorker } from './messages.ts';
import { supportFor, supportFromUrl, type SupportInfo } from './support.ts';

const PORTS = Array.from({ length: PORT_SPAN }, (_, i) => DEFAULT_PORT + i);

interface Pairing { token: string; port: number; appVersion: string }
interface TabFill {
  fillId: string;
  requestId: string;
  formFrame: number;
  pageUrl: string;
  ats: FillRequest['ats'];
  jobId: string | null;
  resumeId: string | null;
  fields: FormField[];
  filledIds: string[];
}

// ------------------------------------------------------------------ storage

async function getPairing(): Promise<Pairing | null> {
  const r = await chrome.storage.local.get('pairing');
  const p = r.pairing as Pairing | undefined;
  return p && typeof p.token === 'string' && typeof p.port === 'number' ? p : null;
}

async function setPairing(p: Pairing | null): Promise<void> {
  if (p) await chrome.storage.local.set({ pairing: p });
  else await chrome.storage.local.remove('pairing');
}

async function getTab(tabId: number): Promise<TabFill | null> {
  const r = await chrome.storage.session.get(`tab:${tabId}`);
  return (r[`tab:${tabId}`] as TabFill | undefined) ?? null;
}

async function setTab(tabId: number, t: TabFill | null): Promise<void> {
  if (t) await chrome.storage.session.set({ [`tab:${tabId}`]: t });
  else await chrome.storage.session.remove(`tab:${tabId}`);
}

// Keep the pairing token away from content scripts.
function lockStorage(): void {
  try { void chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }); } catch { /* older Chrome */ }
  try { void chrome.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }); } catch { /* older Chrome */ }
}
lockStorage();
chrome.runtime.onInstalled.addListener(lockStorage);
chrome.runtime.onStartup.addListener(lockStorage);

// ------------------------------------------------------------------ talking to the app

class AppError extends Error {
  code: 'not_running' | 'unpaired' | 'refused' | 'bad_answer' | 'app_error';
  status: number;
  constructor(code: AppError['code'], message: string, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function request(port: number, path: string, init: { method: string; body?: unknown; token?: string | null; timeoutMs?: number }): Promise<{ status: number; data: unknown }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 8000);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.token) headers[PAIRING_TOKEN_HEADER] = init.token;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: init.method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: ctrl.signal,
      credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
    });
    const data: unknown = await res.json().catch(() => null);
    return { status: res.status, data };
  } catch {
    throw new AppError('not_running', 'The jobleft app is not running on this computer. Start the app, then try again.');
  } finally {
    clearTimeout(timer);
  }
}

async function isJobleft(port: number): Promise<string | null> {
  try {
    const r = await request(port, '/api/v1/health', { method: 'GET', timeoutMs: 900 });
    const v = validate(HealthSchema, r.data);
    return r.status === 200 && v.ok ? v.value.version : null;
  } catch {
    return null;
  }
}

/** Every port where a jobleft app answers now, the preferred one first. */
async function appPorts(prefer: number | null): Promise<Array<{ port: number; version: string }>> {
  const order = prefer ? [prefer, ...PORTS.filter((p) => p !== prefer)] : PORTS;
  const out: Array<{ port: number; version: string }> = [];
  for (const port of order) {
    const v = await isJobleft(port);
    if (v) out.push({ port, version: v });
  }
  return out;
}

async function findApp(prefer: number | null): Promise<{ port: number; version: string } | null> {
  return (await appPorts(prefer))[0] ?? null;
}

function errorMessage(data: unknown): string | null {
  const e = (data as { error?: { message?: unknown } } | null)?.error;
  return typeof e?.message === 'string' ? e.message : null;
}

/**
 * A call with the pairing token. The paired app is the one that accepts the token: when the app moved to another
 * port (a restart), or another jobleft app answers on the old port, the call finds the paired one again.
 */
async function call<T>(path: string, method: string, body: unknown, schema: JsonSchema, timeoutMs = 15000): Promise<T> {
  const p = await getPairing();
  if (!p) throw new AppError('unpaired', 'This browser is not paired with the jobleft app. Pair it first.');
  let res: { status: number; data: unknown } | null = null;
  try {
    res = await request(p.port, path, { method, body, token: p.token, timeoutMs });
  } catch {
    res = null;
  }
  if (res === null || res.status === 401) {
    const seen = res?.status === 401;
    let found = false;
    for (const a of await appPorts(null)) {
      if (a.port === p.port && res === null) continue;
      if (a.port === p.port && seen) continue;
      const r = await request(a.port, path, { method, body, token: p.token, timeoutMs }).catch(() => null);
      // Only an app that accepts the token is the paired app (another jobleft server answers 401, 403 or 404).
      if (r && r.status >= 200 && r.status < 300) {
        await setPairing({ ...p, port: a.port, appVersion: a.version });
        res = r;
        found = true;
        break;
      }
    }
    if (!found && !seen) throw new AppError('not_running', 'The jobleft app is not running on this computer. Start the app, then try again.');
  }
  if (!res || res.status === 401) {
    await setPairing(null);
    throw new AppError('unpaired', 'The jobleft app does not know this browser any more (the pairing was removed). Pair again.', 401);
  }
  if (res.status === 403) throw new AppError('refused', errorMessage(res.data) ?? 'The jobleft app refused the request.', 403);
  if (res.status < 200 || res.status >= 300) throw new AppError('app_error', errorMessage(res.data) ?? `The jobleft app answered with an error (HTTP ${res.status}).`, res.status);
  const v = validate(schema, res.data);
  if (!v.ok) throw new AppError('bad_answer', 'The jobleft app sent an answer this extension does not understand. Update the app or the extension.');
  return v.value as T;
}

async function connection(): Promise<ConnState> {
  const p = await getPairing();
  if (!p) {
    const found = await findApp(null);
    return { state: 'unpaired', appRunning: !!found, appVersion: found?.version ?? null };
  }
  try {
    const s = await call<{ paired: boolean; appVersion: string; profileComplete: boolean; missingProfileFields: string[] }>('/api/v1/extension/status', 'GET', undefined, ExtensionStatusSchema, 5000);
    if (!s.paired) { await setPairing(null); return { state: 'unpaired', appRunning: true, appVersion: s.appVersion }; }
    return { state: 'paired', appVersion: s.appVersion, profileComplete: s.profileComplete, missingProfileFields: s.missingProfileFields };
  } catch (e) {
    if (e instanceof AppError && e.code === 'not_running') return { state: 'app_not_running' };
    if (e instanceof AppError && e.code === 'unpaired') {
      const found = await findApp(null);
      return { state: 'unpaired', appRunning: !!found, appVersion: found?.version ?? null };
    }
    return { state: 'refused', message: e instanceof Error ? e.message : 'The jobleft app refused the request.' };
  }
}

async function pair(code: string): Promise<{ ok: boolean; message: string }> {
  if (!/^\d{6}$/.test(code)) return { ok: false, message: 'Type the 6 digits the jobleft app shows.' };
  const apps = await appPorts(null);
  if (apps.length === 0) return { ok: false, message: 'The jobleft app is not running on this computer. Start it, then try again.' };
  const body = {
    code, extensionId: chrome.runtime.id, extensionVersion: chrome.runtime.getManifest().version,
    protocolVersion: EXTENSION_PROTOCOL_VERSION, browser: browserName(),
  };
  let last = 'The code did not work. Check it, or make a new code in the app.';
  // The code is valid only in the app that showed it; with more than one jobleft app running, try each.
  for (const a of apps) {
    const r = await request(a.port, '/api/v1/extension/pair', { method: 'POST', body, timeoutMs: 8000 }).catch(() => null);
    if (!r) continue;
    if (r.status !== 200) { last = errorMessage(r.data) ?? last; continue; }
    const v = validate(PairResponseSchema, r.data);
    if (!v.ok) return { ok: false, message: 'The app sent an answer this extension does not understand.' };
    await setPairing({ token: v.value.pairingToken, port: a.port, appVersion: v.value.appVersion });
    return { ok: true, message: `Paired with jobleft ${v.value.appVersion} on this computer.` };
  }
  return { ok: false, message: last };
}

function browserName(): string {
  const m = navigator.userAgent.match(/Chrome\/(\d+)/);
  return `Chrome ${m?.[1] ?? ''}`.trim().slice(0, 80);
}

async function unpair(): Promise<void> {
  const p = await getPairing();
  if (p) {
    try { await request(p.port, '/api/v1/extension/pairing', { method: 'DELETE', token: p.token, timeoutMs: 3000 }); } catch { /* app closed */ }
  }
  await setPairing(null);
}

// ------------------------------------------------------------------ the page

async function inject(tabId: number, allFrames: boolean): Promise<number[]> {
  const res = await chrome.scripting.executeScript({ target: { tabId, allFrames }, files: ['content.js'] });
  return res.map((r) => r.frameId);
}

async function toFrame<T>(tabId: number, frameId: number, msg: ToContent): Promise<T | null> {
  try {
    return (await chrome.tabs.sendMessage(tabId, msg, { frameId })) as T;
  } catch {
    return null;
  }
}

async function panel(tabId: number, report: Report): Promise<void> {
  await toFrame(tabId, 0, { type: 'panel:show', report });
}

function emptyReport(fillId: string, support: SupportInfo, phase: Report['phase'], error: string | null = null): Report {
  return {
    fillId, phase, progress: null, support, job: null, items: [], drafts: [], draftOffer: null, draftCostNote: null, resume: null,
    notices: [], otherForms: [], hiddenIgnored: 0, error, applied: null, appliedMessage: null,
  };
}

function httpUrl(u: string | undefined): string | null {
  try {
    const x = new URL(u ?? '');
    return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : null;
  } catch {
    return null;
  }
}

async function pageInfo(url: string): Promise<PageInfo | null> {
  try {
    return await call<PageInfo>('/api/v1/extension/page', 'POST', { pageUrl: url }, PageInfoSchema, 5000);
  } catch {
    return null;
  }
}

async function popupState(tabId: number): Promise<PopupState> {
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url ?? null;
  let support = supportFromUrl(url);
  const conn = await connection();
  let page: PageInfo | null = null;
  let pageError: string | null = null;
  const pageUrl = httpUrl(url ?? undefined);
  if (conn.state === 'paired' && pageUrl && support.level !== 'never') {
    // The person opened jobleft on this tab: look at a few markers (never text) to name the system.
    if (!support.ats) {
      try {
        await inject(tabId, false);
        const probe = await toFrame<ProbeResult>(tabId, 0, { type: 'probe' });
        if (probe?.ats) support = supportFor(probe.ats, 'page');
        if (probe?.blockedFrames.length) pageError = `The application form is inside a frame from another site. jobleft can fill it on its own page: ${probe.blockedFrames[0]}`;
      } catch {
        pageError = 'jobleft cannot read this page.';
      }
    }
    page = await pageInfo(pageUrl);
  }
  return { conn, url, support, page, pageError };
}

async function startFill(tabId: number, resumeId: string | null): Promise<{ ok: boolean; message: string }> {
  const tab = await chrome.tabs.get(tabId);
  const pageUrl = httpUrl(tab.url);
  let support = supportFromUrl(tab.url);
  if (support.level === 'never' || support.level === 'not_a_page' || !pageUrl) return { ok: false, message: support.message };
  const conn = await connection();
  if (conn.state === 'app_not_running') return { ok: false, message: 'The jobleft app is not running on this computer. Start it, then try again. Nothing on the page changed.' };
  if (conn.state === 'unpaired') return { ok: false, message: 'This browser is not paired with the jobleft app. Pair it first. Nothing on the page changed.' };
  if (conn.state === 'refused') return { ok: false, message: conn.message };

  const fillId = crypto.randomUUID();
  let frames: number[];
  try {
    frames = await inject(tabId, true);
  } catch {
    return { ok: false, message: 'jobleft cannot read this page. Click the jobleft button on the page again, then press Fill.' };
  }
  if (!frames.includes(0)) frames.unshift(0);
  await panel(tabId, emptyReport(fillId, support, 'reading'));

  const results = await Promise.all(frames.map(async (fid) => ({ fid, r: await toFrame<CollectResult>(tabId, fid, { type: 'collect', fillId }) })));
  const got = results.filter((x): x is { fid: number; r: CollectResult } => !!x.r);
  const top = got.find((x) => x.fid === 0)?.r ?? null;
  if (!support.ats) {
    const ats = got.map((x) => x.r.ats).find((a) => !!a) ?? null;
    if (ats) support = supportFor(ats, 'page');
  }
  const best = [...got].sort((a, b) => b.r.score - a.r.score)[0] ?? null;
  const notices: string[] = [];
  const anyCaptcha = got.some((x) => x.r.captcha === 'visible') ? 'visible' : got.some((x) => x.r.captcha === 'invisible') ? 'invisible' : null;
  if (anyCaptcha === 'visible') notices.push('This page has a human check (CAPTCHA). jobleft does not touch it. Complete it yourself before you submit.');
  if (anyCaptcha === 'invisible') notices.push('This page may show a human check (CAPTCHA) when you submit. jobleft never touches it.');
  const blocked = [...new Set(got.flatMap((x) => x.r.blockedFrames))];

  const fail = async (message: string): Promise<{ ok: boolean; message: string }> => {
    const rep = emptyReport(fillId, support, 'error', message);
    rep.notices = notices;
    rep.otherForms = top?.otherForms ?? [];
    rep.hiddenIgnored = top?.hiddenIgnored ?? 0;
    await panel(tabId, rep);
    return { ok: false, message };
  };

  if (got.some((x) => x.r.account) && (!best || best.r.score === 0 || best.r.account)) {
    return fail('This step asks you to sign in or create an account. jobleft never fills passwords or makes accounts, and it filled nothing here. Do this step yourself, then press Fill again on the application form.');
  }
  if (!best || best.r.score <= 0 || best.r.fields.length === 0) {
    if (blocked.length) return fail(`The application form is inside a frame from another site, which jobleft cannot reach from here. Open the form on its own page, then press Fill there: ${blocked[0]}`);
    if (got.some((x) => x.r.ambiguous)) return fail('This page has more than one form, and jobleft could not tell which one is the application. Click inside the application form, then press Fill again.');
    return fail('jobleft did not find a job application form on this page. It filled nothing.');
  }
  if (blocked.length) notices.push(`Part of this page is a frame from another site that jobleft cannot reach. If the application is in it, open it on its own page: ${blocked[0]}`);

  const info = await pageInfo(pageUrl);
  const job = info && info.jobId ? { title: info.title, company: info.company, appliedAt: info.applied?.at ?? null } : null;
  const chosenResume = resumeId ?? info?.suggestedResumeId ?? null;
  const req: FillRequest = {
    requestId: crypto.randomUUID(), pageUrl, ats: support.ats ?? 'other', step: best.r.step, fields: best.r.fields.slice(0, 500), resumeId: chosenResume,
  };
  await panel(tabId, { ...emptyReport(fillId, support, 'asking'), job });
  let resp: FillResponse;
  try {
    resp = await call<FillResponse>('/api/v1/extension/fill', 'POST', req, FillResponseSchema, 30000);
  } catch (e) {
    return fail(`${e instanceof Error ? e.message : 'The jobleft app did not answer.'} Nothing on the page changed.`);
  }
  // Only the fields jobleft asked about; never a field the app made up.
  const asked = new Set(req.fields.map((f) => f.fieldId));
  resp = { ...resp, fills: resp.fills.filter((f) => asked.has(f.fieldId)), files: resp.files.filter((f) => asked.has(f.fieldId)), drafts: resp.drafts.filter((d) => asked.has(d.fieldId)) };
  for (const w of resp.warnings) notices.push(w);

  const input: ApplyInput = {
    fillId, response: resp, support, job, notices, otherForms: best.r.otherForms, hiddenIgnored: best.r.hiddenIgnored,
    resumeName: resp.files[0]?.fileName ?? null,
  };
  await setTab(tabId, {
    fillId, requestId: req.requestId, formFrame: best.fid, pageUrl, ats: req.ats, jobId: resp.jobId, fields: req.fields,
    resumeId: resp.files[0]?.resumeId ?? chosenResume, filledIds: resp.fills.map((f) => f.fieldId),
  });
  void toFrame(tabId, best.fid, { type: 'apply', input });
  return { ok: true, message: 'Filling. Check the report on the page.' };
}

async function makeDrafts(tabId: number, fieldIds: string[], maxCostMicros: number): Promise<void> {
  const t = await getTab(tabId);
  if (!t) return;
  const fields = t.fields.filter((f) => fieldIds.includes(f.fieldId)).slice(0, 20);
  if (fields.length === 0) return;
  try {
    const r = await call<{ drafts: Array<{ fieldId: string; text: string; provider: string }>; costMicros: number; balanceMicros: number | null; skipped: Array<{ fieldId: string; message: string }> }>(
      '/api/v1/extension/drafts', 'POST', { requestId: t.requestId, pageUrl: t.pageUrl, jobId: t.jobId, fields, maxCostMicros }, DraftResponseSchema, 120000,
    );
    const cost = r.costMicros > 0 ? `These drafts cost ${formatDollars(r.costMicros)} from your balance.${r.balanceMicros !== null ? ` Balance now: ${formatDollars(r.balanceMicros)}.` : ''}` : null;
    await toFrame(tabId, t.formFrame, { type: 'drafts', drafts: r.drafts.filter((d) => fieldIds.includes(d.fieldId)), skipped: r.skipped, costNote: cost });
  } catch (e) {
    await toFrame(tabId, t.formFrame, { type: 'drafts', drafts: [], skipped: fieldIds.map((id) => ({ fieldId: id, message: e instanceof Error ? e.message : 'No draft was made.' })), costNote: null });
  }
}

async function markApplied(tabId: number): Promise<void> {
  const t = await getTab(tabId);
  const tab = await chrome.tabs.get(tabId);
  const pageUrl = t?.pageUrl ?? httpUrl(tab.url);
  if (!pageUrl) return;
  try {
    const r = await call<{ trackerEntry: { appliedAt: string | null } | null }>('/api/v1/extension/review', 'POST', {
      requestId: t?.requestId ?? crypto.randomUUID(), pageUrl, jobId: t?.jobId ?? null, ats: t?.ats ?? 'other', filledFieldIds: t?.filledIds ?? [],
      editedFieldIds: [], submittedByUser: true, savedAnswers: [], at: new Date().toISOString(), resumeId: t?.resumeId ?? null,
    }, ReviewResponseSchema, 10000);
    const at = r.trackerEntry?.appliedAt ?? new Date().toISOString();
    await toFrame(tabId, 0, { type: 'panel:message', kind: 'applied', text: `Saved: your jobleft tracker shows this job as applied on ${at.slice(0, 10)}.`, appliedAt: at });
  } catch (e) {
    const why = e instanceof Error ? e.message : 'The app did not answer.';
    await toFrame(tabId, 0, { type: 'panel:message', kind: 'error', text: `Not saved. ${why} Your tracker did not change. Press the button again when the app is running.` });
  }
}

// ------------------------------------------------------------------ messages

chrome.runtime.onMessage.addListener((msg: ToWorker, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;
  const fromPopup = !sender.tab && typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
  const tabId = sender.tab?.id;
  const run = async (): Promise<unknown> => {
    if (msg.type.startsWith('popup:')) {
      if (!fromPopup) return null;
      switch (msg.type) {
        case 'popup:state': return popupState(msg.tabId);
        case 'popup:pair': return pair(msg.code);
        case 'popup:unpair': await unpair(); return { ok: true };
        case 'popup:fill': return startFill(msg.tabId, msg.resumeId);
      }
      return null;
    }
    if (tabId === undefined) return null;
    const t = await getTab(tabId);
    switch (msg.type) {
      case 'panel:report': await panel(tabId, msg.report); return { ok: true };
      case 'panel:fillAgain': {
        const r = await startFill(tabId, t?.resumeId ?? null);
        if (!r.ok) await toFrame(tabId, 0, { type: 'panel:message', kind: 'error', text: r.message });
        return r;
      }
      case 'panel:undo': if (t) await toFrame(tabId, t.formFrame, { type: 'undo' }); return { ok: true };
      case 'panel:stop': if (t) await toFrame(tabId, t.formFrame, { type: 'stop' }); return { ok: true };
      case 'panel:makeDrafts': await makeDrafts(tabId, msg.fieldIds, msg.maxCostMicros); return { ok: true };
      case 'panel:insertDraft': if (t) await toFrame(tabId, t.formFrame, { type: 'insertDraft', fieldId: msg.fieldId, text: msg.text }); return { ok: true };
      case 'panel:discardDraft': if (t) await toFrame(tabId, t.formFrame, { type: 'discardDraft', fieldId: msg.fieldId }); return { ok: true };
      case 'panel:locate': if (t) await toFrame(tabId, t.formFrame, { type: 'locate', fieldId: msg.fieldId }); return { ok: true };
      case 'panel:markApplied': await markApplied(tabId); return { ok: true };
      case 'panel:close': {
        if (t && t.formFrame !== 0) await toFrame(tabId, t.formFrame, { type: 'close' });
        await toFrame(tabId, 0, { type: 'close' });
        return { ok: true };
      }
    }
    return null;
  };
  run().then(reply, (e: unknown) => reply({ ok: false, message: e instanceof Error ? e.message : String(e) }));
  return true;
});
