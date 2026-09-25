// Made-up connections files for tests and demos. Every person is invented; emails use example.com; profile links
// are plain text in a file (the app never requests them). The layout copies the real export: three note lines,
// the header, then one row per connection, every field quoted when it holds a comma or a quote.

import { csvField } from '../csv.ts';

export const NOTE_LINES = [
  'Notes:',
  '"When exporting your connection data, you may notice that some of the email addresses are missing. You will only see email addresses for connections who have allowed their connections to see or download their email address using this setting https://www.linkedin.com/psettings/privacy/email. You can learn more here https://www.linkedin.com/help/linkedin/answer/261"',
  '',
];
export const HEADER = 'First Name,Last Name,URL,Email Address,Company,Position,Connected On';

export interface FixtureRow {
  first: string; last: string; url: string; email: string; company: string; position: string; connectedOn: string;
}

function dateText(d: Date): string {
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return `${String(d.getUTCDate()).padStart(2, '0')} ${m} ${d.getUTCFullYear()}`;
}

export function rowLine(r: FixtureRow): string {
  return [r.first, r.last, r.url, r.email, r.company, r.position, r.connectedOn].map(csvField).join(',');
}

export function fileText(rows: string[], eol = '\n'): string {
  return [...NOTE_LINES, HEADER, ...rows].join(eol) + eol;
}

/**
 * The demo fixture (network outcomes O1, O4, O5, O12). `now` sets which connections are "recent".
 * Expected: 31 people imported, 2 rows skipped (line 30: duplicate of line 7; line 31: broken row).
 */
export function demoFixture(now: number): { text: string; expect: { people: number; skipped: Array<{ line: number; why: string }> } } {
  const day = 86_400_000;
  const recent = dateText(new Date(now - 40 * day));
  const twoYears = dateText(new Date(now - 800 * day));
  const u = (slug: string) => `https://www.linkedin.com/in/${slug}`;
  const rows: FixtureRow[] = [
    // Stripe, Inc. (3 people), stripe (1 person): one company, 4 people.
    { first: 'Avery', last: 'Quill', url: u('avery-quill-fx1'), email: 'avery.quill@example.com', company: 'Stripe, Inc.', position: 'Technical Recruiter', connectedOn: recent },
    { first: 'Blake', last: 'Ormond', url: u('blake-ormond-fx2'), email: '', company: 'Stripe, Inc.', position: 'Engineering Manager, Payments', connectedOn: twoYears },
    { first: 'Casey', last: 'Brandt', url: u('casey-brandt-fx3'), email: '', company: 'Stripe, Inc.', position: 'Software Engineer II', connectedOn: '14 Mar 2015' },
    { first: 'Devon', last: 'Marsh', url: u('devon-marsh-fx4'), email: 'devon.marsh@example.com', company: 'stripe', position: 'Senior Recruiting Coordinator', connectedOn: twoYears },
    // A different firm with a similar name.
    { first: 'Emery', last: 'Solt', url: u('emery-solt-fx5'), email: '', company: 'Stripe Partners Ltd', position: 'Partner', connectedOn: '02 Feb 2020' },
    // Apple (2 people) and Apple Leisure Group (1 person, a different firm).
    { first: 'Finley', last: 'Hart', url: u('finley-hart-fx6'), email: '', company: 'Apple', position: 'iOS Engineer', connectedOn: '11 Nov 2019' },
    { first: 'Gray', last: 'Ives', url: u('gray-ives-fx7'), email: 'gray.ives@example.com', company: 'Apple', position: 'Executive Assistant to the CEO', connectedOn: recent },
    { first: 'Harper', last: 'Lund', url: u('harper-lund-fx8'), email: '', company: 'Apple Leisure Group', position: 'Travel Sales Manager', connectedOn: '05 May 2018' },
    // Blank companies (2 people): an "unknown company" group that matches no job.
    { first: 'Indigo', last: 'Park', url: u('indigo-park-fx9'), email: '', company: '', position: 'Student', connectedOn: '20 Aug 2021' },
    { first: 'Jules', last: 'Varga', url: u('jules-varga-fx10'), email: '', company: '', position: '', connectedOn: '' },
    // Look-alike names that must not merge.
    { first: 'Kai', last: 'Moreau', url: u('kai-moreau-fx11'), email: '', company: 'Meta', position: 'Product Designer', connectedOn: '09 Sep 2022' },
    { first: 'Lane', last: 'Okafor', url: u('lane-okafor-fx12'), email: '', company: 'Metaview', position: 'Account Executive', connectedOn: '09 Sep 2022' },
    { first: 'Morgan', last: 'Tate', url: u('morgan-tate-fx13'), email: '', company: 'Block', position: 'Data Scientist', connectedOn: '17 Jan 2023' },
    { first: 'Noor', last: 'Haddad', url: u('noor-haddad-fx14'), email: '', company: 'Blockchain Labs', position: 'Founder & CEO', connectedOn: '17 Jan 2023' },
    // Quoted commas and accents inside fields.
    { first: 'Olivia', last: 'Núñez', url: u('olivia-nunez-fx15'), email: '', company: 'Acme Robotics, LLC', position: 'Directora de Ingeniería, Pagos', connectedOn: '03 Jun 2021' },
    { first: 'Pat', last: 'O\'Neil', url: u('pat-oneil-fx16'), email: '', company: 'The Home Depot', position: 'Store Manager', connectedOn: '28 Dec 2016' },
    // Emoji and non-Latin names, kept as written.
    { first: 'Sam 🚀', last: 'Rivera', url: u('sam-rivera-fx17'), email: '', company: 'Initrode', position: 'Growth Marketer', connectedOn: '30 Apr 2024' },
    { first: '张', last: '伟', url: u('zhang-wei-fx18'), email: '', company: 'Initrode', position: 'Machine Learning Engineer', connectedOn: '30 Apr 2024' },
    { first: '山田', last: '太郎', url: u('yamada-taro-fx19'), email: '', company: 'Globex Japan', position: 'シニアエンジニア', connectedOn: '12 Jul 2023' },
    { first: 'דוד', last: 'כהן', url: u('david-cohen-fx20'), email: '', company: 'Globex Israel', position: 'Head of Engineering', connectedOn: '12 Jul 2023' },
    // Names the export garbled (kept exactly, flagged "may be garbled").
    { first: 'JosÃ©', last: 'GarcÃ­a', url: u('jose-garcia-fx21'), email: '', company: 'Initrode', position: 'Talent Acquisition Partner', connectedOn: '01 Oct 2020' },
    { first: 'å¼ ', last: 'ä¼Ÿ', url: u('garbled-fx22'), email: '', company: 'Globex', position: 'Engineer', connectedOn: '01 Oct 2020' },
    // Placeholders, never a company.
    { first: 'Quinn', last: 'Abara', url: u('quinn-abara-fx23'), email: '', company: 'Self-employed', position: 'Consultant', connectedOn: '15 Feb 2019' },
    { first: 'Remy', last: 'Castel', url: u('remy-castel-fx24'), email: '', company: 'Stealth Startup', position: 'Co-Founder', connectedOn: '15 Feb 2019' },
    // Seniority traps.
    { first: 'Sloane', last: 'Pike', url: u('sloane-pike-fx25'), email: 'sloane.pike@example.com', company: 'Umbrella Health', position: 'Chief of Staff to the CEO', connectedOn: recent },
    { first: 'Tamsin', last: 'Wolfe', url: u('tamsin-wolfe-fx26'), email: '', company: 'Umbrella Health', position: 'VP of Engineering', connectedOn: '22 Mar 2014' },
    { first: 'Uma', last: 'Reyes', url: u('uma-reyes-fx27'), email: 'uma.reyes@example.com', company: 'Umbrella Health', position: 'Account Executive', connectedOn: twoYears },
    // Two different people with the same name (different links).
    { first: 'Val', last: 'Stone', url: u('val-stone-fx28'), email: '', company: 'Globex', position: 'Recruiter', connectedOn: '08 Aug 2022' },
    { first: 'Val', last: 'Stone', url: u('val-stone-fx29'), email: '', company: 'Initrode', position: 'Nurse', connectedOn: '09 Aug 2022' },
    // AWS style short form.
    { first: 'Wren', last: 'Adler', url: u('wren-adler-fx30'), email: '', company: 'Amazon Web Services (AWS)', position: 'Solutions Architect', connectedOn: '10 Oct 2021' },
    { first: 'Xan', last: 'Birch', url: u('xan-birch-fx31'), email: '', company: 'Amazon Web Services', position: 'Software Development Engineer', connectedOn: '10 Oct 2021' },
  ];
  const lines = rows.map(rowLine);
  // Line numbers: 3 note lines + header = line 4; rows start at line 5. Row 3 (Gray Ives) is on line 11 (index 6 -> line 11).
  lines.push(rowLine(rows[6]!)); // a duplicate of Gray Ives (line 11)
  lines.push('Broken,Row,https://www.linkedin.com/in/broken-fx99'); // a broken row: 3 fields
  const text = fileText(lines);
  return {
    text,
    expect: {
      people: rows.length,
      skipped: [{ line: 5 + rows.length, why: 'duplicate of line 11' }, { line: 6 + rows.length, why: 'broken row' }],
    },
  };
}

/** A deterministic pseudo-random generator (mulberry32), so the same seed gives the same file. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Ari', 'Bea', 'Cato', 'Dara', 'Eli', 'Fen', 'Gia', 'Hal', 'Ivo', 'Jem', 'Kit', 'Lio', 'Mae', 'Nell', 'Oren', 'Pia', 'Rafe', 'Sia', 'Teo', 'Una', 'Vic', 'Wes', 'Yara', 'Zed', 'José', 'Zoë', 'Łukasz', 'Søren', 'Chloé', 'Iñaki'];
const LAST = ['Abbott', 'Birk', 'Cole', 'Dunn', 'Eads', 'Frey', 'Gale', 'Hume', 'Ince', 'Jory', 'Kemp', 'Lyle', 'Mott', 'Nash', 'Orr', 'Pratt', 'Rook', 'Sage', 'Toll', 'Upton', 'Vane', 'Webb', 'Yule', 'Zorn', 'Müller', 'Ødegaard', 'Å', 'Ng'];
const COMPANIES = ['Stripe, Inc.', 'Apple', 'Initrode', 'Globex', 'Umbrella Health', 'Acme Robotics, LLC', 'Northwind Traders', 'Contoso Ltd', 'Fabrikam', 'Tailspin Toys', 'Wide World Importers', 'Blue Yonder Airlines', 'Litware, Inc.', 'Proseware', 'Adventure Works', 'Coho Winery', 'Lucerne Publishing', 'Margie\'s Travel', 'Trey Research', 'Woodgrove Bank', '', 'Self-employed'];
const TITLES = ['Software Engineer', 'Senior Software Engineer', 'Technical Recruiter', 'Engineering Manager', 'Product Manager', 'Data Scientist', 'Designer', 'Account Executive', 'Director of Sales', 'VP of Marketing', 'Nurse', 'Financial Analyst', 'Recruiting Coordinator', 'Intern', 'Staff Engineer', 'Head of People', 'Operations Manager, EMEA', 'Customer Success Manager', ''];

/** A large made-up file (network O14): `rows` people, ~25% with emails, the same output for the same seed. */
export function syntheticFixture(rows: number, seed = 42, now = Date.now()): string {
  const r = prng(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const lines: string[] = [];
  for (let i = 0; i < rows; i++) {
    const first = pick(FIRST);
    const last = pick(LAST);
    const slug = `synthetic-${seed}-${i}`;
    const days = Math.floor(r() * 365 * 12);
    lines.push(rowLine({
      first, last, url: `https://www.linkedin.com/in/${slug}`,
      email: r() < 0.25 ? `${slug}@example.com` : '',
      company: pick(COMPANIES), position: pick(TITLES), connectedOn: dateText(new Date(now - days * 86_400_000)),
    }));
  }
  return fileText(lines);
}
