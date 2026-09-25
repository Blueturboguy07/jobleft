// An independent counter for checking the sponsor numbers against a public DOL file. It shares no matching code with
// the index: it reads the .xlsx rows and counts, per exact EMPLOYER_NAME and FEIN, the rows with CASE_STATUS
// "Certified" and VISA_CLASS "H-1B" whose EMPLOYER_NAME contains the given text (case-insensitive). The person
// then adds up the rows of the filer entities the lookup names.

import { basename } from 'node:path';
import { readSheetRows } from './xlsx.ts';

export interface CountRow { employerName: string; fein: string; certifiedH1b: number; otherRows: number }

export async function countLcaRows(file: string, contains: string): Promise<{ file: string; rows: CountRow[]; scanned: number }> {
  const needle = contains.toLowerCase();
  const out = new Map<string, CountRow>();
  let col: Record<string, number> | null = null;
  let scanned = 0;
  for await (const r of readSheetRows(file)) {
    if (!col) {
      col = {};
      r.cells.forEach((h, i) => { if (h) col![h.trim().toUpperCase()] = i; });
      continue;
    }
    const name = (r.cells[col.EMPLOYER_NAME!] ?? '').trim();
    if (!r.cells[col.CASE_NUMBER!]) continue;
    scanned += 1;
    if (!name.toLowerCase().includes(needle)) continue;
    const fein = (r.cells[col.EMPLOYER_FEIN!] ?? '').trim();
    const k = `${name}\u0000${fein}`;
    let row = out.get(k);
    if (!row) { row = { employerName: name, fein, certifiedH1b: 0, otherRows: 0 }; out.set(k, row); }
    const certified = (r.cells[col.CASE_STATUS!] ?? '').trim() === 'Certified' && (r.cells[col.VISA_CLASS!] ?? '').trim() === 'H-1B';
    if (certified) row.certifiedH1b += 1; else row.otherRows += 1;
  }
  return { file: basename(file), rows: [...out.values()].sort((a, b) => b.certifiedH1b - a.certifiedH1b), scanned };
}
