// Import: how to get the connections file from LinkedIn, the file picker, the honest report, and the one action that
// deletes everything the Network tool holds. The file is read by jobleft on this computer; nothing is uploaded.

import { useRef, useState } from 'react';
import { Alert, Button, Popconfirm } from 'antd';
import { DeleteOutlined, UploadOutlined } from '@ant-design/icons';
import type { NetworkImportSummary } from '@jobleft/contracts';
import { call, type UiError } from '../../app/api.ts';
import { invalidate } from '../../app/data.ts';
import { ui } from '../../app/layers.ts';
import { InlineError } from '../../components/States.tsx';
import { plural } from '../../lib/format.ts';

export function ExportSteps() {
  return (
    <ol className="jl-net-steps" style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <li>On LinkedIn, open <strong>Me</strong>, then <strong>Settings &amp; Privacy</strong>.</li>
      <li>Choose <strong>Data privacy</strong>, then <strong>Get a copy of your data</strong>.</li>
      <li>Choose the <strong>larger data archive</strong> (not "Want something in particular?"), then press <strong>Request archive</strong>.</li>
      <li>LinkedIn emails you a link. Click the <strong>emailed link</strong> and download the archive.</li>
      <li><strong>Unzip</strong> the archive.</li>
      <li>Import the file named <code>Connections.csv</code> here.</li>
    </ol>
  );
}

export function Importer({ onDone, first }: { onDone: (s: NetworkImportSummary) => void; first?: boolean }) {
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<UiError | null>(null);
  const run = async (f: File) => {
    setBusy(f.name); setErr(null);
    try {
      if (f.size > 40 * 1024 * 1024) throw { code: 'payload_too_large', status: null, message: 'That file is larger than 40 MB. A connections file is much smaller. Nothing was imported.', link: null } satisfies UiError;
      const bytes = new Uint8Array(await f.arrayBuffer());
      const s = await call('importNetwork', { body: bytes, contentType: 'text/csv', fileName: f.name });
      invalidate('network', 'jobs:', 'job:', 'match:');
      onDone(s);
    } catch (e) { setErr(e as UiError); } finally { setBusy(null); if (input.current) input.current.value = ''; }
  };
  return (
    <section className="jl-card-box" aria-labelledby="imp-h" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h2 id="imp-h" className="jl-section-title">{first ? 'Import your connections to see who you know' : 'Import your connections'}</h2>
      <p style={{ margin: 0 }}>jobleft reads the connections file that LinkedIn lets you download. The file is read on this computer. jobleft never contacts LinkedIn, and it never shows anyone who is not in your file.</p>
      <h3 style={{ margin: 0, fontSize: 15 }}>How to get the file from LinkedIn</h3>
      <ExportSteps />
      <p className="jl-small jl-muted" style={{ margin: 0 }}>The file lists only your first-degree connections. Many emails are blank. Some names in Chinese, Japanese or Hebrew come out garbled in the export; jobleft shows them as they are in the file.</p>
      <input ref={input} type="file" accept=".csv,text/csv,text/plain" style={{ display: 'none' }} aria-label="Connections file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void run(f); }} />
      <Button type="primary" shape="round" size="large" icon={<UploadOutlined />} loading={!!busy} style={{ alignSelf: 'flex-start' }} onClick={() => input.current?.click()}>Choose Connections.csv</Button>
      {busy && <p role="status" className="jl-muted" style={{ margin: 0 }}>Reading {busy}. A large file can take up to a minute. You can keep this window open.</p>}
      <InlineError error={err} />
    </section>
  );
}

/** What the import did, in numbers and in words: read, skipped (each row with its reason), new, updated, kept. */
export function ImportReport({ s }: { s: NetworkImportSummary }) {
  if (s.notAConnectionsFile) {
    return <Alert type="error" showIcon message="Not imported: this is not a connections file" description={<>{s.warnings.map((w) => <p key={w} style={{ margin: '0 0 4px' }}>{w}</p>)}</>} />;
  }
  const read = s.inFile ?? s.imported + s.updated + s.unchanged;
  return (
    <Alert type={s.skipped.length ? 'warning' : 'success'} showIcon role="status"
      message={<span>Read {plural(read, 'person', 'people')}. Skipped {plural(s.skipped.length, 'row')}.</span>}
      description={
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span>{s.imported} new · {s.updated} updated · {s.unchanged} unchanged{s.missingFromFile ? ` · ${s.missingFromFile} no longer in your file` : ''}.</span>
          {s.missingFromFile > 0 && <span>{plural(s.missingFromFile, 'person', 'people')} from an earlier import {s.missingFromFile === 1 ? 'is' : 'are'} not in this file. Nothing was deleted: they stay with their stages and notes, marked "no longer in your file". You can delete them one by one.</span>}
          {s.skipped.length > 0 && (
            <div>
              <strong>Skipped rows</strong>
              <ul style={{ margin: '2px 0 0', paddingLeft: 18, maxHeight: 180, overflow: 'auto' }}>
                {s.skipped.slice(0, 200).map((r) => <li key={r.line}>Line {r.line}: {r.reason}</li>)}
                {s.skipped.length > 200 && <li>and {s.skipped.length - 200} more</li>}
              </ul>
            </div>
          )}
          {s.warnings.map((w) => <span key={w}>{w}</span>)}
          {s.total !== undefined && <span>You now have {plural(s.total, 'person', 'people')} in your network.</span>}
        </div>
      } />
  );
}

export function DeletePanel({ total }: { total: number | null }) {
  return (
    <section className="jl-card-box" aria-labelledby="del-h">
      <h2 id="del-h" className="jl-section-title" style={{ fontSize: 17 }}>Delete all network data</h2>
      <p>One action removes every imported person, stage, note, follow-up date, plan entry and reminder from jobleft. Your jobs, tracker, resumes and profile are not touched. Your own Connections.csv file is not touched either.</p>
      <Popconfirm title={total === null ? 'Delete all network data?' : `Delete all ${plural(total, 'person', 'people')} and their notes from jobleft?`} description="This cannot be undone." okText="Delete all network data" okButtonProps={{ danger: true }} onConfirm={async () => {
        try {
          const r = await call('deleteNetwork');
          invalidate('network', 'jobs:', 'job:', 'match:', 'notifications');
          ui.message?.success(`Deleted ${plural(r.deleted, 'person', 'people')} and everything about them.`);
        } catch (e) { ui.message?.error((e as UiError).message); }
      }}>
        <Button danger shape="round" icon={<DeleteOutlined />}>Delete all network data</Button>
      </Popconfirm>
    </section>
  );
}
