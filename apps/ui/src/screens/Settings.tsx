// Settings: where AI answers come from (publik, a model on this computer, a custom address, your own key), the
// publik balance in dollars, alerts, job sources and the refresh report, data and backup, the browser extension,
// and what leaves this Mac. Nothing here spends money or sends anything without a button that says so.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Checkbox, Descriptions, Input, Menu, Popconfirm, Radio, Select, Space, Switch, Table, Tag } from 'antd';
import { Tooltip } from '../components/Tip.tsx';
import { CloudOutlined, DesktopOutlined, KeyOutlined, LinkOutlined, ReloadOutlined, DownloadOutlined, UploadOutlined, DeleteOutlined, ApiOutlined, WalletOutlined, BellOutlined, DatabaseOutlined, AppstoreOutlined, InfoCircleOutlined } from '@ant-design/icons';
import {
  formatDollars, type AiSettings, type AppSettings, type BoardEntry, type BoardResolveResponse, type CrawlBoardReport, type CrawlRunSummary, type DatasetInfo,
  type FitIndexStatus, type Health, type LocalServerKind, type OwnKeyVendor, type PairingCode, type PairingInfo, type ProviderCheck, type SavedFilter, type SourceInfo, type StorageInfo,
} from '@jobleft/contracts';
import { call, download, openExternal, type UiError } from '../app/api.ts';
import { invalidate, setCached, useApi } from '../app/data.ts';
import { ui } from '../app/layers.ts';
import { navigate } from '../app/router.ts';
import { useAiSettings, useCrawl, usePublik } from '../app/session.ts';
import { LogoMark, Wordmark } from '../components/Art.tsx';
import { ErrorState, InlineError, Loading } from '../components/States.tsx';
import { ago, dateText, hostOf, plural } from '../lib/format.ts';

const TABS = [
  { key: 'ai', label: 'AI provider', icon: <ApiOutlined /> },
  { key: 'balance', label: 'Balance', icon: <WalletOutlined /> },
  { key: 'alerts', label: 'Alerts', icon: <BellOutlined /> },
  { key: 'sources', label: 'Job sources', icon: <AppstoreOutlined /> },
  { key: 'data', label: 'Data and backup', icon: <DatabaseOutlined /> },
  { key: 'extension', label: 'Browser extension', icon: <LinkOutlined /> },
  { key: 'about', label: 'About and privacy', icon: <InfoCircleOutlined /> },
];

function Panel({ title, children, desc }: { title: string; children: ReactNode; desc?: ReactNode }) {
  return (
    <section className="jl-card-box" style={{ display: 'flex', flexDirection: 'column', gap: 12 }} aria-label={title}>
      <h2 className="jl-section-title" style={{ margin: 0, fontSize: 18 }}>{title}</h2>
      {desc && <p className="jl-muted" style={{ margin: 0 }}>{desc}</p>}
      {children}
    </section>
  );
}

// ------------------------------------------------------------------ AI provider

const LOCAL_KINDS: Array<{ value: LocalServerKind; label: string; url: string }> = [
  { value: 'ollama', label: 'Ollama', url: 'http://127.0.0.1:11434/v1' },
  { value: 'lmstudio', label: 'LM Studio', url: 'http://127.0.0.1:1234/v1' },
  { value: 'llamacpp', label: 'llama.cpp server', url: 'http://127.0.0.1:8080/v1' },
  { value: 'mlx', label: 'MLX server', url: 'http://127.0.0.1:8080/v1' },
  { value: 'openai_compatible', label: 'Other OpenAI-compatible server', url: 'http://127.0.0.1:8000/v1' },
];
const VENDORS: Array<{ value: OwnKeyVendor; label: string }> = [
  { value: 'openai', label: 'OpenAI' }, { value: 'anthropic', label: 'Anthropic' }, { value: 'openrouter', label: 'OpenRouter' }, { value: 'google', label: 'Google' },
];

function AiTab() {
  const ai = useAiSettings();
  const [kind, setKind] = useState<AiSettings['provider']>(null);
  const [localKind, setLocalKind] = useState<LocalServerKind>('ollama');
  const [vendor, setVendor] = useState<OwnKeyVendor>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
  const [check, setCheck] = useState<ProviderCheck | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<UiError | null>(null);
  const s = ai.data;
  useEffect(() => {
    if (!s) return;
    setKind(s.provider ?? 'publik');
    if (s.localKind) setLocalKind(s.localKind);
    if (s.vendor) setVendor(s.vendor);
    setBaseUrl(s.baseUrl ?? (s.provider === 'local' ? LOCAL_KINDS.find((k) => k.value === (s.localKind ?? 'ollama'))!.url : ''));
    setModel(s.model ?? '');
  }, [s?.updatedAt, s?.provider]);
  if (ai.error && !s) return <ErrorState error={ai.error} onRetry={() => { void ai.reload(); }} />;
  if (!s) return <Loading label="Loading AI settings" />;
  const save = async () => {
    setBusy('save'); setErr(null); setCheck(null);
    try {
      const body = { provider: kind!, ...(kind === 'local' ? { localKind, baseUrl } : {}), ...(kind === 'custom' ? { baseUrl } : {}), ...(kind === 'own_key' ? { vendor } : {}), ...(model.trim() ? { model: model.trim() } : {}) };
      if ((kind === 'local' || kind === 'custom') && !/^https?:\/\//.test(baseUrl)) throw { code: 'bad_request', status: null, message: 'Type the full address, starting with http:// or https://.', link: null } satisfies UiError;
      const r = await call('putAiSettings', { body });
      setCached('ai:settings', () => r.settings);
      setCheck(r.check);
      invalidate('ai:');
    } catch (e) { setErr(e as UiError); } finally { setBusy(null); }
  };
  const test = async () => {
    setBusy('test'); setErr(null);
    try { setCheck(await call('checkAi')); } catch (e) { setErr(e as UiError); } finally { setBusy(null); }
  };
  const saveKey = async () => {
    setBusy('key'); setErr(null);
    try { const r = await call('setAiKey', { body: { key } }); setCached('ai:settings', () => r); setKey(''); ui.message?.success(`Key saved. It ends in ${r.keyHint ?? '…'}.`); } catch (e) { setErr(e as UiError); } finally { setBusy(null); }
  };
  const forgetKey = async () => {
    try { const r = await call('deleteAiKey'); setCached('ai:settings', () => r); ui.message?.success('Key forgotten.'); } catch (e) { setErr(e as UiError); }
  };
  const setMetered = async (on: boolean) => {
    if (!s.provider) return;
    try { const r = await call('putAiSettings', { body: { provider: s.provider, meteredFetchEnabled: on } }); setCached('ai:settings', () => r.settings); ui.message?.success(on ? 'Paid lookups are on.' : 'Paid lookups are off.'); } catch (e) { ui.message?.error((e as UiError).message); }
  };
  const changed = kind !== s.provider || (kind === 'local' && (localKind !== s.localKind || baseUrl !== (s.baseUrl ?? ''))) || (kind === 'custom' && baseUrl !== (s.baseUrl ?? '')) || (kind === 'own_key' && vendor !== s.vendor) || model !== (s.model ?? '');
  const card = (v: NonNullable<AiSettings['provider']>, icon: ReactNode, title: string, text: string) => (
    <label className={`jl-choice${kind === v ? ' on' : ''}`} style={{ alignItems: 'flex-start', padding: 14 }}>
      <Radio checked={kind === v} onChange={() => { setKind(v); setCheck(null); if (v === 'local' && !baseUrl) setBaseUrl(LOCAL_KINDS.find((k) => k.value === localKind)!.url); }} aria-label={title} />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}><strong>{icon} {title}</strong><span className="jl-small">{text}</span></span>
    </label>
  );
  const p = s.meteredFetch.pricesPer1000Micros;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Panel title="Where AI answers come from" desc="AI helps with chat, tailoring, cover letters, messages and interview practice. Pick one. jobleft uses only the one you pick; it never switches to another on its own.">
        <div className="jl-choice-grid">
          {card('publik', <CloudOutlined />, 'publik API', 'Pay per use from a dollar balance. Starts with a small free amount.')}
          {card('local', <DesktopOutlined />, 'A model on this computer', 'Ollama, LM Studio, llama.cpp, MLX or similar. Nothing leaves this Mac. Free.')}
          {card('custom', <LinkOutlined />, 'A custom address', 'Any OpenAI-compatible server you run or trust.')}
          {card('own_key', <KeyOutlined />, 'Your own key', 'Your account with an AI vendor. The vendor bills you.')}
        </div>
        {kind === 'local' && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <label className="jl-row">Server <Select style={{ width: 280 }} value={localKind} options={LOCAL_KINDS.map((k) => ({ value: k.value, label: k.label }))} onChange={(v) => { setLocalKind(v); setBaseUrl(LOCAL_KINDS.find((k) => k.value === v)!.url); }} /></label>
            <label className="jl-row">Address <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} style={{ maxWidth: 420 }} aria-label="Server address" /></label>
          </Space>
        )}
        {kind === 'custom' && <label className="jl-row">Address <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://your-server.example/v1" style={{ maxWidth: 480 }} aria-label="Server address" /></label>}
        {kind === 'own_key' && <label className="jl-row">Vendor <Select style={{ width: 220 }} value={vendor} options={VENDORS} onChange={setVendor} /></label>}
        {kind !== 'publik' && (
          <label className="jl-row">Model <Select showSearch allowClear style={{ width: 280 }} value={model || undefined} onChange={(v) => setModel(v ?? '')} placeholder="The server's default"
            options={(check?.models ?? []).map((m) => ({ value: m, label: m }))} onSearch={(v) => { if (v) setModel(v); }} notFoundContent="Save and test to list the server's models" aria-label="Model" /></label>
        )}
        {kind === 'publik' && <label className="jl-row">Speed and quality <Select style={{ width: 220 }} value={model || 'publik-balanced'} onChange={setModel} options={[{ value: 'publik-fast', label: 'Fast' }, { value: 'publik-balanced', label: 'Balanced' }, { value: 'publik-smart', label: 'Smartest' }]} aria-label="publik tier" /></label>}
        <Space wrap>
          <Button type="primary" shape="round" loading={busy === 'save'} disabled={!kind || !changed} onClick={() => { void save(); }}>Save and test</Button>
          <Button shape="round" loading={busy === 'test'} disabled={!s.provider || changed} onClick={() => { void test(); }}>Test again</Button>
          {kind === 'publik' && <Button shape="round" onClick={() => navigate('settings/balance')}>Balance and connection</Button>}
        </Space>
        <InlineError error={err} />
        {check && (check.ok ? <Alert type="success" showIcon message={check.message} description={check.models.length ? `Models: ${check.models.slice(0, 8).join(', ')}` : undefined} />
          : <Alert type="error" showIcon message={check.message} action={(check as ProviderCheck & { link?: { label: string; url: string } }).link ? <Button size="small" onClick={() => openExternal((check as ProviderCheck & { link: { url: string } }).link.url)}>{(check as ProviderCheck & { link: { label: string } }).link.label}</Button> : undefined} />)}
      </Panel>
      {(s.provider === 'custom' || s.provider === 'own_key' || s.provider === 'local') && (
        <Panel title="Key" desc="Kept in the macOS Keychain, never in a file. Only its last 4 characters are ever shown. It goes only to the address above.">
          {s.keySet ? (
            <Space><Tag icon={<KeyOutlined />}>Key saved, ending in {s.keyHint}</Tag><Popconfirm title="Forget this key?" onConfirm={() => { void forgetKey(); }}><Button shape="round">Forget key</Button></Popconfirm></Space>
          ) : (
            <Space.Compact style={{ maxWidth: 480 }}>
              <Input.Password value={key} onChange={(e) => setKey(e.target.value)} placeholder={s.provider === 'local' ? 'Optional for most local servers' : 'Paste your key'} aria-label="API key" autoComplete="off" />
              <Button type="primary" disabled={!key.trim()} loading={busy === 'key'} onClick={() => { void saveKey(); }}>Save key</Button>
            </Space.Compact>
          )}
        </Panel>
      )}
      <Panel title="Paid web lookups" desc={<>Off unless you turn it on. When on, jobleft may pay per request, from your publik balance or your own key, to read pages a plain fetch cannot, or to look up company facts. Prices per 1,000 requests: web search {formatDollars(p.search)}, page {formatDollars(p.page)}, page that needs JavaScript {formatDollars(p.jsPage)}. jobleft always tries a free plain fetch first.</>}>
        <label className="jl-row"><Switch aria-label="Paid web lookups" checked={s.meteredFetch.enabled} disabled={!s.provider} onChange={(v) => { void setMetered(v); }} /> {s.meteredFetch.enabled ? 'On' : 'Off'}{!s.provider && <span className="jl-muted"> (choose a provider first)</span>}</label>
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------------ balance

const DISCLOSURE = [
  'jobleft can send its AI requests to the publik API: each request is priced per use and paid in dollars from your publik balance, which starts with a small free amount.',
  "Your prompts go through publik's servers to the AI model's provider, publik does not train on them, and you can change to a local model or your own key at any time.",
];
const JUSTIFICATION = "The AI model behind publik charges per use; publik charges a fixed, published price per tier, a little above what the model costs publik, which keeps publik running and pays the app's developer. Nothing is charged behind your back, and every call is listed on your publik dashboard.";

function BalanceTab() {
  const ai = useAiSettings();
  const pub = usePublik(true);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<UiError | null>(null);
  const notProvider = !!ai.data && ai.data.provider !== 'publik';
  const connect = async () => {
    setBusy('connect'); setErr(null);
    try {
      const c = await call('connectPublik', { body: { disclosureAccepted: true, disclosureVersion: 1 } });
      setCached('ai:publik', () => c);
      if (notProvider) { const r = await call('putAiSettings', { body: { provider: 'publik' } }); setCached('ai:settings', () => r.settings); }
      invalidate('ai:');
      ui.message?.success(notProvider ? 'Connected. AI answers now come from publik.' : 'Connected to publik.');
    } catch (e) { setErr(e as UiError); } finally { setBusy(null); }
  };
  const refresh = async () => {
    setBusy('refresh'); setErr(null);
    try { const c = await call('refreshPublik'); setCached('ai:publik', () => c); } catch (e) { setErr(e as UiError); } finally { setBusy(null); }
  };
  const disconnect = async () => {
    try { const c = await call('disconnectPublik'); setCached('ai:publik', () => c); invalidate('ai:'); ui.message?.success('Disconnected. Nothing can spend your balance from this Mac now.'); } catch (e) { setErr(e as UiError); }
  };
  const usePublikNow = async () => {
    try { const r = await call('putAiSettings', { body: { provider: 'publik' } }); setCached('ai:settings', () => r.settings); invalidate('ai:'); } catch (e) { setErr(e as UiError); }
  };
  const c = pub.data;
  const w = c?.wallet;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {ai.data && ai.data.provider !== 'publik' && (
        <Alert type="info" showIcon message="publik is not your AI provider now, so nothing charges your balance." action={<Button size="small" onClick={() => { void usePublikNow(); }}>Use publik</Button>} />
      )}
      {pub.error && !c && <ErrorState error={pub.error} onRetry={() => { void pub.reload(); }} title="The balance could not load" />}
      {!c && !pub.error && <Loading label="Reading your balance" />}
      {c && c.state !== 'connected' && (
        <Panel title="Connect to publik">
          {DISCLOSURE.map((d) => <p key={d} style={{ margin: 0 }}>{d}</p>)}
          <Checkbox checked={agree} onChange={(e) => setAgree(e.target.checked)}>I have read this</Checkbox>
          <Button type="primary" shape="round" style={{ alignSelf: 'flex-start' }} disabled={!agree} loading={busy === 'connect'} onClick={() => { void connect(); }}>{notProvider ? 'Connect and use publik for AI' : 'Connect to publik'}</Button>
          <p className="jl-small jl-muted" style={{ margin: 0 }}>No key is typed. jobleft keeps the connection key in the macOS Keychain.</p>
        </Panel>
      )}
      {c && c.state === 'connected' && w && (
        <Panel title="publik balance">
          <div className="jl-row" style={{ alignItems: 'baseline', gap: 12 }}>
            <span className="jl-display" style={{ fontSize: 40 }} aria-label={`Balance: ${formatDollars(w.balanceMicros)}`}>Balance: {formatDollars(w.balanceMicros)}</span>
          </div>
          <Descriptions size="small" column={1} items={[
            ...(w.starterRemainingMicros !== null ? [{ key: 's', label: 'Free starter amount left', children: formatDollars(w.starterRemainingMicros) }] : []),
            { key: 'u', label: 'Used this week', children: formatDollars(w.week.usedMicros) },
            ...(w.week.budgetMicros !== null ? [{ key: 'b', label: 'Weekly budget', children: formatDollars(w.week.budgetMicros) }] : []),
            { key: 't', label: 'Last read', children: ago(w.updatedAt) },
          ]} />
          <p style={{ margin: 0 }}>{JUSTIFICATION}</p>
          <Space wrap>
            <Button type="primary" shape="round" icon={<LinkOutlined />} onClick={() => openExternal(w.topUpUrl)}>{w.claimState === 'anonymous' ? 'Link this computer & pick a plan' : 'Add a plan or pack'}</Button>
            <Button shape="round" icon={<ReloadOutlined />} loading={busy === 'refresh'} onClick={() => { void refresh(); }}>Read the balance again</Button>
            <Popconfirm title="Disconnect from publik?" description="The key is deleted from this Mac. Nothing can spend the balance from here until you connect again." onConfirm={() => { void disconnect(); }} okText="Disconnect">
              <Button shape="round">Disconnect</Button>
            </Popconfirm>
          </Space>
          <p className="jl-small jl-muted" style={{ margin: 0 }}>The button opens publik in your browser. jobleft never takes payment details.</p>
        </Panel>
      )}
      <InlineError error={err} />
    </div>
  );
}

// ------------------------------------------------------------------ alerts

function AlertsTab() {
  const settings = useApi<AppSettings>('settings', () => call('getSettings'));
  const filters = useApi<SavedFilter[]>('filters', () => call('listFilters'));
  const put = async (s: AppSettings) => {
    try { const r = await call('putSettings', { body: s }); setCached('settings', () => r); ui.message?.success('Saved.'); } catch (e) { ui.message?.error((e as UiError).message); }
  };
  if (settings.error && !settings.data) return <ErrorState error={settings.error} onRetry={() => { void settings.reload(); }} />;
  if (!settings.data) return <Loading label="Loading" />;
  const s = settings.data;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Panel title="Notifications" desc="jobleft shows these as macOS notifications and in Notifications. They are made on this Mac; nothing is emailed.">
        <label className="jl-row"><Switch aria-label="Tracker reminders and follow-ups" checked={s.notifications.reminders} onChange={(v) => { void put({ ...s, notifications: { ...s.notifications, reminders: v } }); }} /> Tracker reminders and follow-ups</label>
        <label className="jl-row"><Switch aria-label="New jobs after a refresh, and saved-filter alerts" checked={s.notifications.alerts} onChange={(v) => { void put({ ...s, notifications: { ...s.notifications, alerts: v } }); }} /> New jobs after a refresh, and saved-filter alerts</label>
      </Panel>
      <Panel title="Saved-filter alerts">
        {filters.data && !filters.data.length && <p className="jl-muted">No saved filters yet. Save one from the Jobs screen.</p>}
        {filters.data?.map((f) => (
          <label key={f.id} className="jl-row"><Switch aria-label={`Alerts for ${f.name}`} checked={f.alert.enabled} onChange={async (v) => {
            try { await call('updateFilter', { params: { filterId: f.id }, body: { name: f.name, filter: f.filter, sort: f.sort, alert: v } }); invalidate('filters'); } catch (e) { ui.message?.error((e as UiError).message); }
          }} /> {f.name}</label>
        ))}
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------------ sources

function SourcesTab() {
  const settings = useApi<AppSettings>('settings', () => call('getSettings'));
  const report = useApi<{ run: CrawlRunSummary | null; boards: CrawlBoardReport[] }>('dashboard:report', () => call('crawlReport'));
  const sources = useApi<SourceInfo[]>('sources', () => call('listSources'));
  const [q, setQ] = useState('');
  const [view, setView] = useState<'all' | 'followed' | 'user' | 'hidden' | 'disabled' | 'failing'>('all');
  const boards = useApi<{ items: BoardEntry[]; total: number; nextCursor: string | null }>(`boards:${view}:${q}`, () => call('listBoards', { query: { view, limit: '100', ...(q ? { q } : {}) } }));
  const { progress } = useCrawl();
  const [link, setLink] = useState('');
  const [resolved, setResolved] = useState<BoardResolveResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [keyFor, setKeyFor] = useState<Record<string, string>>({});
  const s = settings.data;
  const put = async (n: AppSettings) => { try { const r = await call('putSettings', { body: n }); setCached('settings', () => r); ui.message?.success('Saved.'); } catch (e) { ui.message?.error((e as UiError).message); } };
  const run = async () => { try { const r = await call('crawlRun', { body: {} }); ui.message?.info(r.message); invalidate('crawl'); } catch (e) { ui.message?.error((e as UiError).message); } };
  const upd = async (b: BoardEntry, body: { followed?: boolean; hidden?: boolean; disabled?: boolean }) => { try { await call('updateBoard', { params: { boardId: b.id }, body }); invalidate('boards'); } catch (e) { ui.message?.error((e as UiError).message); } };
  const resolve = async () => { setBusy('resolve'); setResolved(null); try { setResolved(await call('resolveBoard', { body: { url: link.trim() } })); } catch (e) { ui.message?.error((e as UiError).message); } finally { setBusy(null); } };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Panel title="Refresh" desc="jobleft reads the public job boards you follow, one request a second per site, and never LinkedIn, Indeed or Glassdoor.">
        <div className="jl-row jl-wrap">
          <Button type="primary" shape="round" icon={<ReloadOutlined />} disabled={progress?.running} onClick={() => { void run(); }}>{progress?.running ? `Refreshing: ${progress.boardsDone} of ${progress.boardsTotal}` : 'Refresh now'}</Button>
          {report.data?.run && <span className="jl-muted">Last refresh {ago(report.data.run.finishedAt)}: {plural(report.data.run.ok, 'board')} read, {report.data.run.failed} failed, {plural(report.data.run.inserted, 'new job')}, {plural(report.data.run.closed, 'closed posting')}.</span>}
        </div>
        {s && (
          <div className="jl-row jl-wrap" style={{ gap: 20 }}>
            <label className="jl-row">Refresh every <Select style={{ width: 130 }} value={s.crawl.intervalHours} onChange={(v) => { void put({ ...s, crawl: { ...s.crawl, intervalHours: v } }); }} options={[1, 3, 6, 12, 24, 48].map((h) => ({ value: h, label: `${h} ${h === 1 ? 'hour' : 'hours'}` }))} /></label>
            <label className="jl-row"><Switch aria-label="Catch up when jobleft opens" checked={s.crawl.catchUpOnLaunch} onChange={(v) => { void put({ ...s, crawl: { ...s.crawl, catchUpOnLaunch: v } }); }} /> Catch up when jobleft opens</label>
            <label className="jl-row"><Switch aria-label="Keep refreshing from the menu bar when the window is closed" checked={s.crawl.runInTray} onChange={(v) => { void put({ ...s, crawl: { ...s.crawl, runInTray: v } }); }} /> Keep refreshing from the menu bar when the window is closed</label>
          </div>
        )}
      </Panel>
      <Panel title="Last refresh, board by board">
        {report.error && <InlineError error={report.error} onRetry={() => { void report.reload(); }} />}
        <Table size="small" rowKey="boardId" dataSource={report.data?.boards ?? []} pagination={{ pageSize: 10, hideOnSinglePage: true }} locale={{ emptyText: 'No refresh has run yet.' }}
          columns={[
            { title: 'Board', dataIndex: 'boardId' },
            { title: 'Result', key: 'r', render: (_, b) => b.status === 'ok' ? <Tag color="green">Read</Tag> : <Tooltip title={b.reason}><Tag color="orange">{b.status === 'failed' ? 'Could not read' : b.status}</Tag></Tooltip> },
            { title: 'Listed', dataIndex: 'listed' }, { title: 'New', dataIndex: 'inserted' }, { title: 'Closed', dataIndex: 'closed' },
            { title: 'Notes', key: 'n', render: (_, b) => b.closeHeld ?? b.reason ?? (b.unreadable ? `${b.unreadable} postings could not be read` : '') },
          ]} />
      </Panel>
      <Panel title="Boards you follow">
        <div className="jl-row jl-wrap">
          <Input.Search allowClear placeholder="Search companies" onSearch={setQ} style={{ maxWidth: 280 }} aria-label="Search boards" />
          <Select value={view} onChange={setView} style={{ width: 170 }} aria-label="Which boards" options={[{ value: 'all', label: 'All boards' }, { value: 'followed', label: 'Followed' }, { value: 'user', label: 'Added by you' }, { value: 'failing', label: 'Not answering' }, { value: 'hidden', label: 'Hidden' }, { value: 'disabled', label: 'Turned off' }]} />
          <span className="jl-muted">{boards.data ? plural(boards.data.total, 'board') : ''}</span>
          <Button size="small" icon={<DownloadOutlined />} onClick={() => { void download('exportBoards').catch((e) => ui.message?.error((e as UiError).message)); }}>Export the list</Button>
        </div>
        <Table size="small" rowKey="id" dataSource={boards.data?.items ?? []} loading={boards.loading && !boards.data} pagination={{ pageSize: 15, hideOnSinglePage: true }}
          columns={[
            { title: 'Company', dataIndex: 'company' },
            { title: 'Board', key: 'b', render: (_, b) => `${b.ats} · ${b.board}` },
            { title: 'Status', key: 's', render: (_, b) => b.state === 'live' ? <Tag color="green">Answering</Tag> : b.state === 'failing' ? <Tooltip title={b.lastError}><Tag color="orange">Not answering</Tag></Tooltip> : <Tag>{b.state === 'not_checked' ? 'Not read yet' : b.state}</Tag> },
            { title: 'Open jobs', key: 'o', render: (_, b) => b.openJobs ?? '' },
            { title: 'Follow', key: 'f', render: (_, b) => <Switch size="small" checked={b.followed && !b.disabled && !b.hidden} aria-label={`Follow ${b.company}`} onChange={(v) => { void upd(b, v ? { followed: true, disabled: false, hidden: false } : { disabled: true }); }} /> },
          ]} />
        <div className="jl-row jl-wrap">
          <Input value={link} onChange={(e) => setLink(e.target.value)} placeholder="Paste a careers page or job link to find its board" style={{ maxWidth: 480 }} aria-label="Careers page link" onPressEnter={() => { void resolve(); }} />
          <Button shape="round" loading={busy === 'resolve'} disabled={!link.trim()} onClick={() => { void resolve(); }}>Find the board</Button>
        </div>
        {resolved && (resolved.candidates.length ? resolved.candidates.map((c) => (
          <div key={c.boardId} className="jl-row"><span className="jl-grow">{c.company} ({c.ats}{c.openJobs !== null ? `, ${plural(c.openJobs, 'open job')}` : ''})</span>
            {c.alreadyAdded ? <Tag>Already followed</Tag> : <Button size="small" type="primary" shape="round" onClick={async () => { try { await call('addBoard', { body: { ats: c.ats, board: c.board, ...(c.region ? { region: c.region } : {}) } }); invalidate('boards'); setResolved(null); setLink(''); ui.message?.success(`Following ${c.company}.`); } catch (e) { ui.message?.error((e as UiError).message); } }}>Follow {c.company}</Button>}
          </div>
        )) : <Alert type="info" showIcon message={resolved.message} />)}
      </Panel>
      <Panel title="Other job sources" desc="Each source says whether jobleft reads it, and why not when it does not.">
        {sources.error && <InlineError error={sources.error} onRetry={() => { void sources.reload(); }} />}
        {sources.data?.map((x) => (
          <div key={x.id} className="jl-row jl-wrap" style={{ borderTop: '1px solid var(--jl-line)', paddingTop: 10, alignItems: 'flex-start' }}>
            <div className="jl-grow" style={{ minWidth: 260 }}>
              <strong>{x.name}</strong> {x.crawled ? <Tag color="green">Read by jobleft</Tag> : <Tag>Not read</Tag>}
              {x.reason && <p className="jl-small" style={{ margin: '2px 0' }}>{x.reason}</p>}
              <span className="jl-small jl-muted">{x.limits ? `${x.limits}. ` : ''}Checked {dateText(`${x.checkedOn}T12:00:00Z`)}.{x.status.openJobs !== null ? ` ${plural(x.status.openJobs, 'open job')}.` : ''}{x.status.state === 'needs_key' ? ' Needs a key.' : ''}</span>
            </div>
            {(x.crawled || x.kind === 'search_partner') && <Switch checked={x.enabled} aria-label={`Use ${x.name}`} onChange={async (v) => { try { await call('updateSource', { params: { sourceId: x.id }, body: { enabled: v } }); invalidate('sources'); } catch (e) { ui.message?.error((e as UiError).message); } }} />}
            {x.needsKey && (x.keySet
              ? <Space><Tag icon={<KeyOutlined />}>Key saved</Tag><Button size="small" onClick={async () => { try { await call('deleteSourceKey', { params: { sourceId: x.id } }); invalidate('sources'); } catch (e) { ui.message?.error((e as UiError).message); } }}>Forget key</Button></Space>
              : <Space.Compact><Input.Password size="small" placeholder="Key" value={keyFor[x.id] ?? ''} onChange={(e) => setKeyFor({ ...keyFor, [x.id]: e.target.value })} aria-label={`Key for ${x.name}`} autoComplete="off" /><Button size="small" disabled={!keyFor[x.id]} onClick={async () => { try { await call('setSourceKey', { params: { sourceId: x.id }, body: { key: keyFor[x.id]! } }); setKeyFor({ ...keyFor, [x.id]: '' }); invalidate('sources'); } catch (e) { ui.message?.error((e as UiError).message); } }}>Save</Button></Space.Compact>)}
          </div>
        ))}
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------------ data

function DataTab() {
  const storage = useApi<StorageInfo>('dashboard:storage', () => call('storage'));
  const datasets = useApi<DatasetInfo[]>('datasets', () => call('listDatasets'));
  const fit = useApi<FitIndexStatus>('fitindex', () => call('fitIndexStatus'));
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<UiError | null>(null);
  const restoreInput = useRef<HTMLInputElement | null>(null);
  const dl = async (name: 'backup' | 'exportAll' | 'exportJobs') => {
    setBusy(name); setErr(null);
    try { const f = await download(name); ui.message?.success(`Saved ${f} to your Downloads.`); } catch (e) { setErr(e as UiError); } finally { setBusy(null); }
  };
  const restore = async (f: File) => {
    const ok = await ui.modal?.confirm({ title: 'Restore this backup?', content: 'Your current data is replaced by the data in the backup. A damaged or foreign file is refused and nothing changes.', okText: 'Restore', okButtonProps: { shape: 'round' }, cancelButtonProps: { shape: 'round' } });
    if (!ok) return;
    setBusy('restore'); setErr(null);
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const r = await call('restore', { body: bytes, contentType: 'application/zip', fileName: f.name });
      invalidate('');
      ui.message?.success(`Restored ${Object.keys(r.restored).length} kinds of records.`);
    } catch (e) { setErr(e as UiError); } finally { setBusy(null); if (restoreInput.current) restoreInput.current.value = ''; }
  };
  const del = async () => {
    setBusy('delete'); setErr(null);
    try { await call('deleteAllData', { body: { confirm: 'delete everything' } }); invalidate(''); setConfirmText(''); ui.message?.success('Your personal data was deleted.'); navigate('onboarding', { force: true }); } catch (e) { setErr(e as UiError); } finally { setBusy(null); }
  };
  const updateData = async () => {
    setBusy('datasets'); setErr(null);
    try { const r = await call('updateDatasets'); setCached('datasets', () => r); ui.message?.success('Checked for newer data.'); } catch (e) { setErr(e as UiError); } finally { setBusy(null); }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <InlineError error={err} />
      <Panel title="Where your data lives" desc="Everything is on this Mac, in one folder. Keys are in the macOS Keychain, not in the folder.">
        {storage.data ? (
          <Descriptions size="small" column={1} items={[
            { key: 'd', label: 'Data folder', children: <code style={{ overflowWrap: 'anywhere' }}>{storage.data.dataDir}</code> },
            { key: 's', label: 'Size', children: `${(storage.data.dbBytes / 1_048_576).toFixed(1)} MB` },
            { key: 'j', label: 'Jobs stored', children: `${storage.data.jobs.toLocaleString('en-US')} (${storage.data.openJobs.toLocaleString('en-US')} open)` },
            ...(fit.data ? [{ key: 'f', label: 'Fit index', children: `${fit.data.state === 'ready' ? 'Ready' : fit.data.state}${fit.data.model ? ` (${fit.data.model})` : ''}, ${fit.data.indexed.toLocaleString('en-US')} jobs indexed${fit.data.waiting ? `, ${fit.data.waiting} waiting` : ''}` }] : []),
          ]} />
        ) : storage.error ? <InlineError error={storage.error} onRetry={() => { void storage.reload(); }} /> : <Loading inline label="Reading" />}
      </Panel>
      <Panel title="Backup and export">
        <Space wrap>
          <Button shape="round" icon={<DownloadOutlined />} loading={busy === 'backup'} onClick={() => { void dl('backup'); }}>Download a backup</Button>
          <input ref={restoreInput} type="file" accept=".zip,application/zip" style={{ display: 'none' }} aria-label="Backup file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void restore(f); }} />
          <Button shape="round" icon={<UploadOutlined />} loading={busy === 'restore'} onClick={() => restoreInput.current?.click()}>Restore a backup</Button>
          <Button shape="round" icon={<DownloadOutlined />} loading={busy === 'exportAll'} onClick={() => { void dl('exportAll'); }}>Export all my data (readable files)</Button>
          <Button shape="round" icon={<DownloadOutlined />} loading={busy === 'exportJobs'} onClick={() => { void dl('exportJobs'); }}>Export saved jobs</Button>
        </Space>
        <p className="jl-small jl-muted" style={{ margin: 0 }}>Backups and exports never include keys or tokens.</p>
      </Panel>
      <Panel title="Shipped data" desc="Data that comes with jobleft. It is used on this Mac; lookups never leave it.">
        <Table size="small" rowKey="id" dataSource={datasets.data ?? []} pagination={false}
          columns={[
            { title: 'Data', dataIndex: 'name' }, { title: 'Version', dataIndex: 'version' },
            { title: 'Data through', key: 't', render: (_, d) => d.dataThrough ?? '' }, { title: 'Licence', dataIndex: 'licence' },
            { title: 'Attribution', key: 'a', render: (_, d) => d.attribution ?? '' },
          ]} />
        <Button shape="round" icon={<ReloadOutlined />} loading={busy === 'datasets'} style={{ alignSelf: 'flex-start' }} onClick={() => { void updateData(); }}>Check for newer data</Button>
      </Panel>
      <Panel title="Delete everything" desc="Deletes your profile, resumes, tracker, notes, saved filters, conversations, connections and settings from this Mac. Crawled jobs stay. This cannot be undone.">
        <label>Type <strong>delete everything</strong> to confirm<Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} style={{ maxWidth: 300, display: 'block', marginTop: 4 }} aria-label="Type delete everything to confirm" /></label>
        <Button danger shape="round" icon={<DeleteOutlined />} disabled={confirmText !== 'delete everything'} loading={busy === 'delete'} style={{ alignSelf: 'flex-start' }} onClick={() => { void del(); }}>Delete my data</Button>
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------------ extension

function ExtensionTab() {
  const pairings = useApi<PairingInfo[]>('pairings', () => call('listPairings'));
  const [code, setCode] = useState<PairingCode | null>(null);
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!code) return;
    const t = setInterval(() => { const s = Math.max(0, Math.round((Date.parse(code.expiresAt) - Date.now()) / 1000)); setLeft(s); if (!s) setCode(null); }, 1000);
    return () => clearInterval(t);
  }, [code]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Panel title="Pair the browser extension" desc="The jobleft extension fills application forms from your profile in your own browser. It fills; you review; you submit. It never submits for you.">
        {code ? (
          <div className="jl-row" style={{ gap: 16 }}>
            <span className="jl-display" style={{ fontSize: 40, letterSpacing: '0.2em' }} aria-label={`Pairing code ${code.code.split('').join(' ')}`}>{code.code}</span>
            <span className="jl-muted">Type this code in the extension. It works for {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} more.</span>
          </div>
        ) : (
          <Button type="primary" shape="round" style={{ alignSelf: 'flex-start' }} onClick={async () => { try { setCode(await call('pairingCode')); } catch (e) { ui.message?.error((e as UiError).message); } }}>Show a pairing code</Button>
        )}
        <p className="jl-small jl-muted" style={{ margin: 0 }}>The extension never gets your connections, AI keys or backups.</p>
      </Panel>
      <Panel title="Paired extensions">
        {pairings.error && <InlineError error={pairings.error} onRetry={() => { void pairings.reload(); }} />}
        {pairings.data && !pairings.data.length && <p className="jl-muted">None.</p>}
        {pairings.data?.map((p) => {
          const x = p as PairingInfo & { extensionId: string; browser?: string; pairedAt?: string };
          return (
            <div key={x.extensionId} className="jl-row">
              <span className="jl-grow">{x.browser ?? 'Browser'} · paired {dateText(x.pairedAt)}</span>
              <Popconfirm title="Unpair this extension? It stops working at once." onConfirm={async () => { try { await call('deletePairing', { params: { extensionId: x.extensionId } }); invalidate('pairings'); } catch (e) { ui.message?.error((e as UiError).message); } }}><Button size="small" shape="round">Unpair</Button></Popconfirm>
            </div>
          );
        })}
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------------ about

function AboutTab() {
  const health = useApi<Health>('health', () => call('health'));
  const ai = useAiSettings();
  const s = ai.data;
  const aiWhere = !s?.provider ? 'nowhere yet: no AI provider is chosen' : s.provider === 'publik' ? 'publik, for the AI steps you start' : s.provider === 'local' ? `the model on this computer (${s.baseUrl ? hostOf(s.baseUrl) : 'local'}), so it stays on this Mac` : s.provider === 'custom' ? `the server at ${s.baseUrl ? hostOf(s.baseUrl) : 'your address'}, for the AI steps you start` : 'your AI vendor, with your key, for the AI steps you start';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Panel title="About">
        <div className="jl-row" style={{ gap: 12 }}><LogoMark size={48} /><div><Wordmark size={26} /><div className="jl-muted">Version {health.data?.version ?? '…'} · local API v{health.data?.apiVersion ?? '…'}</div></div></div>
        <p style={{ margin: 0 }}>jobleft is a job-search app that keeps your data on this Mac.</p>
        <Button type="link" style={{ padding: 0, alignSelf: 'flex-start' }} onClick={() => navigate('onboarding')}>Show the setup steps again</Button>
      </Panel>
      <Panel title="What leaves this Mac">
        <Table size="small" pagination={false} rowKey="what" dataSource={[
          { what: 'Your profile, resumes, tracker, notes, connections, searches', where: 'Nothing leaves this Mac.' },
          { what: 'Requests to employers\' public job boards', where: 'Sent to those boards, one a second per site, with no personal data.' },
          { what: 'AI steps (chat, tailoring, letters, messages, practice)', where: `Sent to ${aiWhere}.` },
          { what: 'Paid web lookups', where: s?.meteredFetch.enabled ? 'On: sent to publik or your key\'s service, priced per request.' : 'Off.' },
          { what: 'Usage data, analytics, crash reports', where: 'None. jobleft has no tracking.' },
          { what: 'Fonts, icons, company logos', where: 'None fetched: they are bundled, and company tiles use initials.' },
        ]} columns={[{ title: 'What', dataIndex: 'what' }, { title: 'Where it goes', dataIndex: 'where' }]} />
      </Panel>
    </div>
  );
}

export function SettingsScreen({ tab }: { tab: string | null }) {
  const active = TABS.some((t) => t.key === tab) ? tab! : 'ai';
  const body: Record<string, ReactNode> = { ai: <AiTab />, balance: <BalanceTab />, alerts: <AlertsTab />, sources: <SourcesTab />, data: <DataTab />, extension: <ExtensionTab />, about: <AboutTab /> };
  return (
    <div className="jl-2col">
      <nav style={{ width: 220, flex: '0 0 220px', background: '#fff', borderRight: '1px solid var(--jl-line)', padding: 8, overflowY: 'auto' }} aria-label="Settings sections">
        <Menu mode="inline" selectedKeys={[active]} style={{ border: 0 }} items={TABS.map((t) => ({ key: t.key, icon: t.icon, label: t.label }))} onClick={({ key }) => navigate(`settings/${key}`)} />
      </nav>
      <div className="jl-colmain">
        <div style={{ maxWidth: 900 }}>{body[active]}</div>
      </div>
    </div>
  );
}

export { Radio };
