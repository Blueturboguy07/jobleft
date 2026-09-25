import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Job, NetworkContact } from '@jobleft/contracts';
import { interimCompanyKey } from '../src/company.ts';
import { openNetworkDatabase } from '../src/db.ts';
import { NetworkService } from '../src/service.ts';

export const NOW = Date.parse('2026-09-25T15:00:00Z');

export function tempHome(): { dir: string; done: () => void } {
  const dir = mkdtempSync('/private/tmp/jobleft-network-test-');
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

export function memoryService(now = NOW, tz = 'America/Chicago'): NetworkService {
  const db = new DatabaseSync(':memory:');
  return new NetworkService({ db, companyKey: interimCompanyKey, now: () => now, timeZone: tz });
}

export function fileService(dir: string, now: () => number = () => NOW, tz = 'America/Chicago'): { service: NetworkService; db: DatabaseSync; path: string } {
  const path = join(dir, 'data', 'jobleft.db');
  const db = openNetworkDatabase(path);
  return { service: new NetworkService({ db, companyKey: interimCompanyKey, now, timeZone: tz }), db, path };
}

export function job(title: string, company: string, department: string | null = null): Job {
  const t = '2026-09-01T00:00:00.000Z';
  const url = 'https://jobs.example.com/1';
  return {
    id: `test:jobs:${interimCompanyKey(company)}-${title.length}`, status: 'open', closedAt: null, closedReason: null, title, company,
    companyKey: interimCompanyKey(company), ats: null, board: null, externalId: null, url, applyUrl: null, canonicalUrl: url, places: [],
    isUs: null, workModel: null, remoteScope: null, employmentType: null, level: null, levels: [], yearsRequired: null, pay: null,
    postedAt: null, firstSeenAt: t, lastSeenAt: t, updatedAt: t, department, statements: { sponsorship: null, clearanceRequired: null, usCitizenOnly: null },
    skills: [], evidence: {}, sources: [{ sourceId: 'external:text', name: 'test', url, credit: null, firstSeenAt: t, lastSeenAt: t }],
    duplicateOf: null, contentHash: 'x'.repeat(64), description: '',
  };
}

export function contact(p: Partial<NetworkContact> & { id: string; firstName: string; lastName: string }): NetworkContact {
  return {
    profileUrl: null, email: null, company: 'Stripe', companyKey: 'stripe', position: null, connectedOn: null, maybeGarbled: false,
    stage: 'to_contact', note: null, followUpOn: null, inPlan: false, importedAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z', ...p,
  };
}
