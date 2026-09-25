// Role families for "share of filings in roles like this job" (static-data O7).
// A role family is a 2018 Standard Occupational Classification (SOC) major group, the first two digits of the
// SOC_CODE on every LCA filing. A job title maps to a family in two steps:
//   1. the title table built from the LCA filings themselves (job title -> the SOC major group most filings with
//      that title use, kept only when at least 60% of at least 5 filings agree);
//   2. a short list of plain keyword rules, used only when the table has no answer.
// When neither step is sure, the family is unknown and no share is shown.

/** 2018 SOC major groups (US Bureau of Labor Statistics, public domain). */
export const SOC_MAJOR_GROUPS: Readonly<Record<string, string>> = {
  '11': 'Management',
  '13': 'Business and Financial Operations',
  '15': 'Computer and Mathematical',
  '17': 'Architecture and Engineering',
  '19': 'Life, Physical, and Social Science',
  '21': 'Community and Social Service',
  '23': 'Legal',
  '25': 'Educational Instruction and Library',
  '27': 'Arts, Design, Entertainment, Sports, and Media',
  '29': 'Healthcare Practitioners and Technical',
  '31': 'Healthcare Support',
  '33': 'Protective Service',
  '35': 'Food Preparation and Serving Related',
  '37': 'Building and Grounds Cleaning and Maintenance',
  '39': 'Personal Care and Service',
  '41': 'Sales and Related',
  '43': 'Office and Administrative Support',
  '45': 'Farming, Fishing, and Forestry',
  '47': 'Construction and Extraction',
  '49': 'Installation, Maintenance, and Repair',
  '51': 'Production',
  '53': 'Transportation and Material Moving',
  '55': 'Military Specific',
};

export function socMajorOf(socCode: string | undefined | null): string | null {
  const m = /^\s*(\d\d)-\d/.exec(socCode ?? '');
  return m && SOC_MAJOR_GROUPS[m[1]!] ? m[1]! : null;
}

export function roleFamilyLabel(major: string): string {
  return `${SOC_MAJOR_GROUPS[major] ?? 'Unknown'} occupations (SOC ${major})`;
}

const LEVEL_WORDS = new Set([
  'senior', 'sr', 'junior', 'jr', 'lead', 'staff', 'principal', 'associate', 'entry', 'level', 'mid', 'intern',
  'internship', 'new', 'grad', 'graduate', 'trainee', 'apprentice', 'distinguished', 'i', 'ii', 'iii', 'iv', 'v',
  'vi', '1', '2', '3', '4', '5', '6', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'remote', 'hybrid', 'onsite', 'contract',
  'temporary', 'temp', 'fulltime', 'parttime', 'full', 'part', 'time', 'experienced',
]);

/** "Senior Software Engineer II, Payments (Remote)" -> "software engineer". */
export function normalizeTitle(title: string): string {
  let s = String(title ?? '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
  s = s.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  s = s.split(/\s[-–—|:]\s|,|;|\s\/\s/)[0] ?? '';
  s = s.replace(/&/g, ' and ').replace(/\bsr\./g, 'sr').replace(/\bjr\./g, 'jr');
  const words = s.split(/[^\p{L}\p{N}+#.]+/u).map((w) => w.replace(/\.+$/g, '')).filter((w) => w && !LEVEL_WORDS.has(w));
  return words.join(' ').trim();
}

/** One row of the title table: normalized title, SOC major group, share of filings in that group, filings. */
export type TitleRow = [title: string, major: string, share: number, filings: number];

export const TITLE_MIN_FILINGS = 5;
export const TITLE_MIN_SHARE = 0.6;

const KEYWORD_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(software|developer|programmer|devops|site reliability|sre|full ?stack|front ?end|back ?end|web|mobile|ios|android|data engineer|machine learning|ml engineer|ai engineer|data scientist|data science|database|cloud|cyber ?security|security engineer|network engineer|systems? administrator|sysadmin|qa|quality assurance|test engineer|sdet|computer|information technology|it support|analytics engineer|statistician|actuar\w*|mathematician|(software|solutions?|cloud|data|enterprise|security|systems) architect)\b/, '15'],
  [/\b(mechanical|electrical|civil|chemical|hardware|industrial|aerospace|biomedical|manufacturing|process|structural|materials|mechatronics|robotics|electronics|rf|asic|fpga|firmware|embedded|validation|reliability|design|test|mining|petroleum|nuclear|environmental|packaging) engineer\b|\barchitect\b/, '17'],
  [/\b(nurse|rn|physician|pharmacist|therapist|dentist|surgeon|radiologist|hospitalist|psychiatrist|physician assistant|nurse practitioner|sonographer|medical technologist)\b/, '29'],
  [/\b(professor|lecturer|teacher|instructor|faculty|librarian)\b/, '25'],
  [/\b(attorney|lawyer|counsel|paralegal)\b/, '23'],
  [/\b(scientist|chemist|biologist|physicist|economist|epidemiologist|postdoctoral|postdoc|research fellow)\b/, '19'],
  [/\b(sales|account executive|account manager|business development)\b/, '41'],
  [/\b(designer|writer|editor|artist|animator|photographer|producer)\b/, '27'],
  [/\b(accountant|accounting|auditor|tax|financial analyst|business analyst|management analyst|consultant|market research|compliance|underwriter|buyer|purchasing|recruiter|project manager|program manager|analyst)\b/, '13'],
  [/\b(manager|director|head|vice president|vp|chief|president|ceo|cto|cfo|coo)\b/, '11'],
];

export interface RoleFamily { major: string; label: string; method: 'title_table' | 'keywords'; matched: string }

/** A title table as loaded (normalized title -> row). */
export type TitleTable = ReadonlyMap<string, TitleRow>;

export function roleFamilyOf(jobTitle: string, table: TitleTable): RoleFamily | null {
  const norm = normalizeTitle(jobTitle);
  if (!norm) return null;
  const words = norm.split(' ');
  for (let i = 0; i < words.length; i++) {
    const cand = words.slice(i).join(' ');
    const row = table.get(cand);
    if (row && row[2] >= TITLE_MIN_SHARE && row[3] >= TITLE_MIN_FILINGS) {
      return { major: row[1], label: roleFamilyLabel(row[1]), method: 'title_table', matched: cand };
    }
  }
  for (const [re, major] of KEYWORD_RULES) {
    const m = re.exec(norm);
    if (m) return { major, label: roleFamilyLabel(major), method: 'keywords', matched: m[0] };
  }
  return null;
}
