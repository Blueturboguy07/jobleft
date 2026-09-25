// Worker thread entry for resume import (see import/index.ts). Reads the bytes it is given and posts the result.
import { parentPort, workerData } from 'node:worker_threads';
import { emptyProfileInput, importInProcess } from './index.ts';

const { bytes, fileName, mimeType } = workerData as { bytes: Uint8Array; fileName: string; mimeType: string };
try {
  const r = await importInProcess(bytes, fileName, mimeType);
  parentPort!.postMessage(r);
} catch {
  // A plain failure; the error text (which could quote the file) is not passed on.
  parentPort!.postMessage({
    document: { header: { name: '', email: null, phone: null, city: null, links: [] }, sections: [] },
    report: { counts: { jobs: 0, bullets: 0, skills: 0, education: 0 }, unreadSections: [], warnings: ['The file could not be read. Export it again and upload the new file.'], outcome: 'failed', failure: 'corrupt' },
    proposedProfile: emptyProfileInput(), message: 'The file could not be read. Export it again and upload the new file.', kind: null,
  });
}
