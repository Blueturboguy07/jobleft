// The official US Department of Labor LCA disclosure files the shipped sponsor table is built from.
// Listing page: https://www.dol.gov/agencies/eta/foreign-labor/performance (checked 2026-09-25: FY2025 is published as
// four quarterly files; FY2026 so far as one file for Q1 to Q3, decisions from 2025-10-01 to 2026-06-30).
// Sizes were checked with HEAD requests on 2026-09-25; the sha256 values are of the files as downloaded 2026-09-24.

export interface LcaFileSpec {
  /** The official file name. */
  name: string;
  url: string;
  fiscalYear: number;
  /** The fiscal quarters the file covers (FY2026 Q3 holds Q1 to Q3). */
  quarters: number[];
  bytes: number;
  sha256: string;
  lastModified: string;
}

export const DOL_PERFORMANCE_PAGE = 'https://www.dol.gov/agencies/eta/foreign-labor/performance';
export const DOL_RECORD_LAYOUT = 'https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/FY26Q3/LCA_Record_Layout_FY2026_Q3.pdf';

export const OFFICIAL_LCA_FILES: readonly LcaFileSpec[] = [
  {
    name: 'LCA_Disclosure_Data_FY2025_Q1.xlsx',
    url: 'https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/LCA_Disclosure_Data_FY2025_Q1.xlsx',
    fiscalYear: 2025, quarters: [1], bytes: 87_690_398,
    sha256: '17c08eccf8b2d543f502553f502b8165d85e3e93d86de6f7dbaed3e87c86911d', lastModified: '2025-02-11',
  },
  {
    name: 'LCA_Disclosure_Data_FY2025_Q2.xlsx',
    url: 'https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/LCA_Disclosure_Data_FY2025_Q2.xlsx',
    fiscalYear: 2025, quarters: [2], bytes: 106_951_050,
    sha256: 'bc5aaf90fa89ee2666757fe8b065ae95a8b40dde785df04adba226b4fb388d30', lastModified: '2025-12-15',
  },
  {
    name: 'LCA_Disclosure_Data_FY2025_Q3.xlsx',
    url: 'https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/LCA_Disclosure_Data_FY2025_Q3.xlsx',
    fiscalYear: 2025, quarters: [3], bytes: 143_867_250,
    sha256: 'fcabedf38c8cc3036334b7d38981878d29afb3d8ad7455ec12f127ed091a0d5e', lastModified: '2025-12-15',
  },
  {
    name: 'LCA_Disclosure_Data_FY2025_Q4.xlsx',
    url: 'https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/LCA_Disclosure_Data_FY2025_Q4.xlsx',
    fiscalYear: 2025, quarters: [4], bytes: 79_134_156,
    sha256: '81ebf97d471014b91ae685cb7eb505369d7c80af2de67944ddd7531814976370', lastModified: '2025-12-18',
  },
  {
    name: 'LCA_Disclosure_Data_FY2026_Q3.xlsx',
    url: 'https://www.dol.gov/media/LCA_Disclosure_Data_FY2026_Q3.xlsx',
    fiscalYear: 2026, quarters: [1, 2, 3], bytes: 251_850_891,
    sha256: 'f8ca8448a528671f784d3692923775a13741c99caec2816b2fe30c8885bd28b3', lastModified: '2026-08-07',
  },
];

/** "LCA_Disclosure_Data_FY2025_Q1.xlsx" or "LCA_FY2025_Q1.xlsx" -> { fiscalYear: 2025, quarter: 1 }. */
export function fiscalQuarterFromName(name: string): { fiscalYear: number; quarter: number } | null {
  const m = /FY_?(\d{4})_Q([1-4])/i.exec(name);
  return m ? { fiscalYear: Number(m[1]), quarter: Number(m[2]) } : null;
}

/** The US federal fiscal year of a date: FY2026 runs from 2025-10-01 to 2026-09-30. */
export function fiscalYearOf(isoDate: string): number {
  const y = Number(isoDate.slice(0, 4));
  const m = Number(isoDate.slice(5, 7));
  return m >= 10 ? y + 1 : y;
}

/** Fiscal quarter (1 to 4) of a date: Q1 = Oct to Dec. */
export function fiscalQuarterOf(isoDate: string): number {
  const m = Number(isoDate.slice(5, 7));
  return m >= 10 ? 1 : Math.floor((m - 1) / 3) + 2;
}

/** First and last day of a fiscal quarter. */
export function fiscalQuarterRange(fiscalYear: number, quarter: number): { from: string; to: string } {
  const startMonth = [10, 1, 4, 7][quarter - 1]!;
  const startYear = quarter === 1 ? fiscalYear - 1 : fiscalYear;
  const endMonth = startMonth + 2;
  const lastDay = new Date(Date.UTC(startYear, endMonth, 0)).getUTCDate();
  const mm = (n: number) => String(n).padStart(2, '0');
  return { from: `${startYear}-${mm(startMonth)}-01`, to: `${startYear}-${mm(endMonth)}-${mm(lastDay)}` };
}
