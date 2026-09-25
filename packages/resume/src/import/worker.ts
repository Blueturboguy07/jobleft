// Worker thread entry for reading untrusted files (import/index.ts): resume import and the readability check.
// It reads the bytes it is given and posts the result; it writes nothing and prints nothing.
import { parentPort, workerData } from 'node:worker_threads';
import { atsCheckPdf } from '../ats.ts';
import { emptyProfileInput, importInProcess } from './index.ts';

const { op, bytes, fileName, mimeType } = workerData as { op?: 'import' | 'ats'; bytes: Uint8Array; fileName: string; mimeType: string };
try {
  if (op === 'ats') parentPort!.postMessage({ ok: true, report: await atsCheckPdf(bytes) });
  else parentPort!.postMessage(await importInProcess(bytes, fileName, mimeType));
} catch {
  // A plain failure; the error text (which could quote the file) is not passed on.
  if (op === 'ats') parentPort!.postMessage({ ok: false });
  else parentPort!.postMessage({
    document: { header: { name: '', email: null, phone: null, city: null, links: [] }, sections: [] },
    report: { counts: { jobs: 0, bullets: 0, skills: 0, education: 0 }, unreadSections: [], warnings: ['The file could not be read. Export it again and upload the new file.'], outcome: 'failed', failure: 'corrupt' },
    proposedProfile: emptyProfileInput(), message: 'The file could not be read. Export it again and upload the new file.', kind: null,
  });
}
