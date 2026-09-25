// Writes the lane's fixtures: made-up employers, titles, text and links in the exact structure of each source's
// real answer. With --captures <dir> it also records each real answer's structural signature (paths and types only,
// no data) in fixtures/<source>/shape.json. The real captures stay outside the repository (they hold real employers,
// HN user names and the requester's IP address in Remote OK descriptions).
//
//   node scripts/make-fixtures.ts [--captures /private/tmp/jl-so]
//
// Captures used on 2026-09-25 (one polite request each, User-Agent "jobleft-build/0.1 (research build; no personal
// data)"): remoteok-api.json, muse-remote-page0.json, hn-search.json, hn-item.json, simplify-listings.json,
// vansh-listings.json, vansh-ng-listings.json, speedy-swe-readme.md, speedy-swe-ngusa.md.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markdownHeaders, shapeOf } from '../src/shape.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'fixtures');
const args = process.argv.slice(2);
const captures = args.includes('--captures') ? args[args.indexOf('--captures') + 1] : null;

function write(rel: string, data: unknown): void {
  const p = join(OUT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n');
}

// The anti-spam line Remote OK appends to every description embeds the requester's IP in base64. Fixtures use the
// documentation address 192.0.2.1 ("MTkyLjAuMi4x").
const RO_TAG = 'Please mention the word **FIXTURE** and tag RMTkyLjAuMi4x when applying to show you read the job post completely (#RMTkyLjAuMi4x). This is a beta feature to avoid spam applicants.';

function ro(id: number, company: string, position: string, location: string, smin: number, smax: number, desc: string, date: string, extra: Record<string, unknown> = {}) {
  const slug = `remote-${position.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${company.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${id}`;
  const url = `https://remoteOK.com/remote-jobs/${slug}`;
  return {
    slug, id: String(id), epoch: Math.floor(Date.parse(date) / 1000), date: date.replace('Z', '+00:00'), company, company_logo: '',
    position, tags: ['fixture'], description: `${desc}<br/><br/>${RO_TAG}`, location, apply_url: url, salary_min: smin,
    salary_max: smax, logo: '', url, ...extra,
  };
}

const remoteok = [
  {
    last_updated: 1790265606,
    legal: "API Terms of Service: Please link back (with follow, and without nofollow!) to the URL on Remote OK and mention Remote OK as a source, so we get traffic back from your site. If you do not we'll have to suspend API access.\n\nPlease don't use the Remote OK logo without written permission as it's a registered trademark, please DO use our name Remote OK though.",
  },
  ro(900001, 'Birchwood Health', 'Registered Nurse Telehealth', 'Remote - US', 0, 0, '<p>Birchwood Health is a made-up clinic for tests.</p><p>You will run video visits.</p><ul><li>Active RN licence</li><li>2 years in primary care</li></ul>', '2026-09-24T00:00:07Z'),
  ro(900002, 'Cobalt Ledger', 'Senior Backend Engineer', 'Worldwide', 120000, 150000, '<p>Build the ledger service in Go.</p>', '2026-09-23T21:40:19Z', { original: true }),
  ro(900003, 'Dunmore Analytics', 'Customer Support Specialist', 'Europe only', 0, 0, '<p>Answer customer questions in English and German.</p>', '2026-09-23T14:00:02Z'),
  ro(900004, 'Evergreen Logistics', 'Data Annotator', '', 30000, 40000, '<p>Label shipping photos. No experience needed.</p>', '2026-09-22T09:00:01Z', { original: true }),
  ro(900005, 'Foxglove Talleres', 'MecÃ¡nico Automotriz DiagnÃ³stico', 'MÃ©xico', 0, 0, '<p>Buscamos un/a MecÃ¡nico/a Automotriz con experiencia en diagnÃ³stico.</p>', '2026-09-22T00:00:13Z'),
  ro(900006, 'Granite Payments ', 'Frontend Engineer', 'Germany', 0, 0, '<p>React and TypeScript.</p>', '2026-09-21T16:00:11Z'),
  ro(900007, 'Halcyon Maps', 'Security Test Posting', 'USA', 0, 0, '<p>Normal text before.</p><script>alert("fixture script ran")</script><img src="x" onerror="alert(1)"><iframe src="http://127.0.0.1:9/frame-probe"></iframe><img src="http://pixel.tracker.example/p.gif?job=900007" width="1" height="1"><p>Normal text after.</p>', '2026-09-20T00:00:31Z'),
  ro(900008, 'Ironbark Energy', 'Junior Copywriter', 'Canada', 50000, 60000, '<p>Write product pages.</p>', '2026-09-19T20:00:01Z', { verified: true }),
  ro(900009, 'Juniper Nursing Group', 'Operations Lead', 'Americas', 0, 0, '<p>Run scheduling across clinics.</p>', '2026-09-19T08:00:34Z'),
  ro(900010, 'Kestrel Aerospace', 'Bookkeeper Part Time', 'Remote - US', 0, 0, '<p>Part-time bookkeeping, 20 hours a week.</p>', '2026-09-19T00:00:16Z'),
];

function muse(id: number, name: string, company: string, short: string, locs: string[], levels: Array<[string, string]>, date: string, contents: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return {
    contents, name, type: 'external', publication_date: date, short_name: slug, model_type: 'jobs', id,
    locations: locs.map((n) => ({ name: n })), categories: [{ name: 'Software Engineering' }],
    levels: levels.map(([n, s]) => ({ name: n, short_name: s })), tags: [],
    refs: { landing_page: `https://www.themuse.com/jobs/${short}/${slug}` }, company: { id: 15000000 + id % 1000, short_name: short, name: company },
  };
}

const themuse = {
  results: [
    muse(22000001, 'Senior Product Manager', 'Lumen Tutoring', 'lumentutoring', ['Flexible / Remote', 'New York, NY'], [['Senior Level', 'senior']], '2026-09-20T19:45:52Z', '<p>Own the tutoring app roadmap.</p>'),
    muse(22000002, 'Account Executive', 'Marlow Retail', 'marlowretail', ['Flexible / Remote'], [['Mid Level', 'mid']], '2026-09-19T23:43:09Z', '<p>Sell to regional stores.</p>'),
    muse(22000003, 'Software Engineering Intern', 'Nimbus Data', 'nimbusdata', ['Flexible / Remote', 'Austin, TX'], [['Internship', 'internship']], '2026-09-18T18:44:45Z', '<p>A summer internship on the data platform.</p>'),
    muse(22000004, 'Director of Nursing Operations', 'Orchard Care', 'orchardcare', ['Flexible / Remote'], [['management', 'management']], '2026-09-17T18:53:19Z', '<p>Lead nursing operations for 12 sites.</p>'),
    muse(22000005, 'Support Engineer', 'Pinecrest Software', 'pinecrestsoftware', ['Flexible / Remote', 'London, United Kingdom'], [['Entry Level', 'entry'], ['Mid Level', 'mid']], '2026-09-16T20:03:43Z', '<p>Help customers in the UK and Europe.</p>'),
  ],
};

const HN_STORY = 99000001;
const hnSearch = {
  exhaustive: { nbHits: true, typo: true }, exhaustiveNbHits: true, exhaustiveTypo: true,
  hits: [
    { _highlightResult: { author: { matchLevel: 'none', matchedWords: [], value: 'whoishiring' }, story_text: { matchLevel: 'none', matchedWords: [], value: '' }, title: { matchLevel: 'none', matchedWords: [], value: 'Ask HN: Who is hiring? (September 2026)' } }, _tags: ['story', 'author_whoishiring', `story_${HN_STORY}`, 'ask_hn'], author: 'whoishiring', children: [], created_at: '2026-09-01T15:01:17Z', created_at_i: 1788274877, num_comments: 8, objectID: String(HN_STORY), points: 254, story_id: HN_STORY, story_text: 'Please state the location and include REMOTE for remote work.', title: 'Ask HN: Who is hiring? (September 2026)', updated_at: '2026-09-25T06:00:00Z' },
    { _highlightResult: { author: { matchLevel: 'none', matchedWords: [], value: 'whoishiring' }, story_text: { matchLevel: 'none', matchedWords: [], value: '' }, title: { matchLevel: 'none', matchedWords: [], value: 'Ask HN: Who wants to be hired? (September 2026)' } }, _tags: ['story', 'author_whoishiring', 'story_99000002', 'ask_hn'], author: 'whoishiring', children: [], created_at: '2026-09-01T15:01:17Z', created_at_i: 1788274877, num_comments: 5, objectID: '99000002', points: 100, story_id: 99000002, story_text: 'Share your location and skills.', title: 'Ask HN: Who wants to be hired? (September 2026)', updated_at: '2026-09-25T06:00:00Z' },
    { _highlightResult: { author: { matchLevel: 'none', matchedWords: [], value: 'whoishiring' }, story_text: { matchLevel: 'none', matchedWords: [], value: '' }, title: { matchLevel: 'none', matchedWords: [], value: 'Ask HN: Who is hiring? (August 2026)' } }, _tags: ['story', 'author_whoishiring', 'story_99000000', 'ask_hn'], author: 'whoishiring', children: [], created_at: '2026-08-03T15:00:54Z', created_at_i: 1785769254, num_comments: 3, objectID: '99000000', points: 200, story_id: 99000000, story_text: 'Please state the location.', title: 'Ask HN: Who is hiring? (August 2026)', updated_at: '2026-09-25T06:00:00Z' },
  ],
  hitsPerPage: 10, nbHits: 3, nbPages: 1, page: 0, params: 'tags=story%2Cauthor_whoishiring&hitsPerPage=10', processingTimeMS: 1,
  processingTimingsMS: { _request: { roundTrip: 1 } }, query: '', serverTimeMS: 1,
};

function hnComment(id: number, text: string, at: string, n: number, replies: unknown[] = []) {
  return { author: `fixture_user${n}`, children: replies, created_at: at.replace('Z', '.000Z'), created_at_i: Math.floor(Date.parse(at) / 1000), id, options: [], parent_id: HN_STORY, points: null, story_id: HN_STORY, text, title: null, type: 'comment', url: null };
}
const enc = (u: string) => u.replace(/\//g, '&#x2F;');
const a = (u: string) => `<a href="${enc(u)}" rel="nofollow">${enc(u)}</a>`;
const hnItem = {
  author: 'whoishiring',
  children: [
    hnComment(99000101, `Quartzline | Senior Platform Engineer | REMOTE (US) | Full-time | $150k - $190k USD | ${a('https://quartzline.example/careers')}<p>We make scheduling software for clinics.<p>Apply: ${a('https://jobs.lever.co/quartzline-example/7f1c2d3e-0000-4000-8000-000000000101')}`, '2026-09-01T15:02:11Z', 1, [
      { author: 'fixture_user9', children: [], created_at: '2026-09-02T10:00:00.000Z', created_at_i: 1788343200, id: 99000901, options: [], parent_id: 99000101, points: null, story_id: HN_STORY, text: 'Is this open to new grads?', title: null, type: 'comment', url: null },
    ]),
    hnComment(99000102, `Rivermark Bio | Lab Automation Engineer | Boston, MA | ONSITE | Full-time<p>Robots that pipette. Email jobs@rivermark.example.`, '2026-09-01T15:03:02Z', 2),
    hnComment(99000103, `Saltmarsh Games | Multiple Roles | Remote (Europe) | €60k–€85k<p>Small studio, big worlds. ${a('https://apply.workable.com/saltmarsh-example/j/ABC123DEF4/')}`, '2026-09-01T15:03:07Z', 3),
    hnComment(99000104, `Tidewater Robotics (YC W25) | Firmware Engineer | San Francisco, CA | HYBRID | Full Time | Visa sponsorship<p>We build warehouse robots.`, '2026-09-01T15:04:01Z', 4),
    hnComment(99000105, `Umbra Security | ${a('https://umbra.example')} | Security Engineer | ONSITE NYC or REMOTE (US/Can) | $170-240K + equity<p>Detection engineering.`, '2026-09-01T15:06:48Z', 5),
    hnComment(99000106, `We&#x27;re building a new kind of bakery and need a baker who loves mornings. No pipes in this post.`, '2026-09-01T15:07:00Z', 6),
    hnComment(99000107, `Vellum Health | Nurse Practitioner (part-time) | Remote, Worldwide | Part-time | $90-110/hour USD<p>Asynchronous care.`, '2026-09-01T15:08:00Z', 7),
    hnComment(99000108, `Willowbrook | Data Analyst | Chicago, IL<p>Just a data analyst role.<p>${a('https://job-boards.greenhouse.io/willowbrook-example/jobs/4400000108')}`, '2026-09-01T15:09:00Z', 8),
  ],
  created_at: '2026-09-01T15:01:17.000Z', created_at_i: 1788274877, id: HN_STORY, options: [], parent_id: null, points: 254,
  story_id: HN_STORY, text: 'Please state the location and include REMOTE for remote work, REMOTE (US) or similar if the country is restricted, and ONSITE when remote work is <i>not</i> an option.', title: 'Ask HN: Who is hiring? (September 2026)', type: 'story', url: null,
};

function simplify(id: string, company: string, title: string, url: string, locations: string[], opts: { active?: boolean; visible?: boolean; sponsorship?: string; category?: string; terms?: string[]; degrees?: string[]; posted?: number } = {}) {
  const posted = opts.posted ?? 1790100000;
  return {
    source: 'Simplify', category: opts.category ?? 'Software', company_name: company, id, title, active: opts.active ?? true,
    terms: opts.terms ?? ['Summer 2027'], date_updated: posted, date_posted: posted, url, locations,
    company_url: `https://simplify.jobs/c/${company.replace(/\s+/g, '-')}`, is_visible: opts.visible ?? true,
    sponsorship: opts.sponsorship ?? 'Other', degrees: opts.degrees ?? ["Bachelor's"],
  };
}
const SHARED_GH = 'https://job-boards.greenhouse.io/acmerobotics-example/jobs/7700000001';
const simplifyRows = [
  simplify('00000000-0000-4000-8000-000000000001', 'Acme Robotics', 'Software Engineering Intern', `${SHARED_GH}?utm_source=Simplify&ref=Simplify`, ['Pittsburgh, PA']),
  simplify('00000000-0000-4000-8000-000000000002', 'Birchwood Health', 'Nursing Intern', 'https://jobs.lever.co/birchwood-example/2b2b2b2b-0000-4000-8000-000000000002', ['Denver, CO', 'Remote in USA'], { sponsorship: 'Does Not Offer Sponsorship', category: 'Healthcare' }),
  simplify('00000000-0000-4000-8000-000000000003', 'Cobalt Ledger', 'Quant Research Intern', 'https://jobs.ashbyhq.com/cobalt-ledger-example/3c3c3c3c-0000-4000-8000-000000000003', ['Remote in USA'], { sponsorship: 'Offers Sponsorship', category: 'Quant' }),
  simplify('00000000-0000-4000-8000-000000000004', 'Dunmore Analytics', 'Data Science Co-op', 'https://dunmore.wd1.myworkdayjobs.com/External/job/Austin-TX/Data-Science-Co-op_R0001', ['Austin, TX'], { sponsorship: 'U.S. Citizenship is Required', terms: ['Fall 2026', 'Spring 2027'] }),
  simplify('00000000-0000-4000-8000-000000000005', 'Evergreen Logistics', 'Operations Intern', 'https://careers.evergreen-logistics.example/jobs/5555', ['Toronto, ON, Canada'], { category: 'Other' }),
  simplify('00000000-0000-4000-8000-000000000006', 'Foxglove Studio', 'Design Intern', 'https://apply.workable.com/foxglove-example/j/FOX0000006/', ['London, UK'], { active: false }),
  simplify('00000000-0000-4000-8000-000000000007', 'Granite Payments', 'Security Intern', 'https://jobs.lever.co/granite-example/7g7g7g7g-0000-4000-8000-000000000007', ['New York, NY'], { visible: false }),
  simplify('00000000-0000-4000-8000-000000000008', 'Halcyon Maps', 'GIS Intern', 'javascript:alert(1)', ['Seattle, WA']),
];

function vansh(id: string, company: string, title: string, url: string, locations: string[], season = 'Summer', sponsorship = 'Other', active = true) {
  return { date_updated: 1790000000, url, locations, sponsorship, active, company_name: company, title, season, source: 'vanshb03', id, date_posted: 1790000000, company_url: '', is_visible: true };
}
const vanshIntern = [
  vansh('10000000-0000-4000-8000-000000000001', 'Acme Robotics', 'software engineering intern', SHARED_GH, ['Pittsburgh, PA']),
  vansh('10000000-0000-4000-8000-000000000002', 'Ironbark Energy', 'Grid Software Intern', 'https://jobs.ashbyhq.com/ironbark-example/9i9i9i9i-0000-4000-8000-000000000002', ['Houston, TX']),
  vansh('10000000-0000-4000-8000-000000000003', 'Juniper Nursing Group', 'Clinical Data Intern', 'https://juniper-example.recruitee.com/o/clinical-data-intern', ['Remote'], 'Fall'),
  vansh('10000000-0000-4000-8000-000000000004', 'Kestrel Aerospace', 'Avionics Intern', 'https://kestrel-example.jobs.personio.de/job/1000004', ['Munich, Germany'], 'Summer', 'Other', false),
];
const vanshNg = [
  { ...vansh('20000000-0000-4000-8000-000000000001', 'Lumen Tutoring', 'New Grad: Software Engineer', 'https://job-boards.greenhouse.io/lumen-example/jobs/8800000001', ['Remote']), season: undefined },
  { ...vansh('20000000-0000-4000-8000-000000000002', 'Marlow Retail', 'Associate Product Manager', 'https://jobs.lever.co/marlow-example/2m2m2m2m-0000-4000-8000-000000000002', ['Chicago, IL', 'New York, NY']), season: undefined },
  { ...vansh('20000000-0000-4000-8000-000000000003', 'Nimbus Data', 'Data Engineer I', 'https://careers.nimbusdata.example/jobs/3', ['Bengaluru, India']), season: undefined },
].map((r) => { const { season: _s, ...rest } = r; return rest; });

function mdRow(company: string, site: string, position: string, location: string, salary: string | null, posting: string, age: string): string {
  const c = `<a href="${site}"><strong>${company}</strong></a>`;
  const p = `<a href="${posting}"><img src="https://i.imgur.com/JpkfjIq.png" alt="Apply" width="70"/></a>`;
  return salary === null ? `| ${c} | ${position} | ${location} | ${p} | ${age} |` : `| ${c} | ${position} | ${location} | ${salary} | ${p} | ${age} |`;
}
function mdFile(title: string, faang: string[], other: string[]): string {
  return [
    `# ${title}`, '', 'Made-up rows for tests, in the layout of the real list.', '',
    '### FAANG+', '', '<!-- TABLE_FAANG_START -->', '| Company | Position | Location | Salary | Posting | Age |', '|---|---|---|---|---|---|', ...faang, '<!-- TABLE_FAANG_END -->', '',
    '### Other', '', '<!-- TABLE_START -->', '| Company | Position | Location | Posting | Age |', '|---|---|---|---|---|', ...other, '<!-- TABLE_END -->', '',
  ].join('\n');
}
const swe = {
  'README.md': mdFile('2027 Software Engineering Internship & New Grad Positions', [
    mdRow('Orchard Bank', 'https://orchard.example', 'Software Engineer Intern - Payments', 'New York City, NY', '$60/hr', 'https://jobs.ashbyhq.com/orchard-example/a1a1a1a1-0000-4000-8000-000000000001', '0d'),
    mdRow('Pinecrest Software', 'https://pinecrest.example', 'Software Engineering Intern', 'San Francisco, CA +4', '$55/hr', 'https://boards.greenhouse.io/pinecrest-example/jobs/6100000002?gh_jid=6100000002', '9d'),
  ], [
    mdRow('Quartzline', 'https://quartzline.example', 'Backend Intern', 'Austin, TX', null, 'https://jobs.lever.co/quartzline-example/b2b2b2b2-0000-4000-8000-000000000003', '12d'),
    mdRow('Rivermark Bio', 'https://rivermark.example', 'Automation Intern', 'Boston, MA', null, 'https://rivermark.wd5.myworkdayjobs.com/en-US/campus/job/Boston/Automation-Intern_R0004', '30d'),
  ]),
  'NEW_GRAD_USA.md': mdFile('2027 Software Engineering New Grad Positions (USA)', [
    mdRow('Saltmarsh Games', 'https://saltmarsh.example', 'Software Engineer I', 'Seattle, WA', '$130k/yr', 'https://apply.workable.com/saltmarsh-example/j/NG0000005/', '3d'),
  ], [
    mdRow('Tidewater Robotics', 'https://tidewater.example', 'Robotics Software Engineer', 'Pittsburgh, PA', null, 'https://jobs.ashbyhq.com/tidewater-example/c3c3c3c3-0000-4000-8000-000000000006', '5d'),
  ]),
  'INTERN_INTL.md': mdFile('2027 Software Engineering Internships (International)', [
    mdRow('Umbra Security', 'https://umbra.example', 'Security Engineering Intern', 'London, UK', '£3,000/mo', 'https://jobs.ashbyhq.com/umbra-example/d4d4d4d4-0000-4000-8000-000000000007', '2d'),
  ], [
    mdRow('Vellum Health', 'https://vellum.example', 'Platform Intern', 'Toronto, ON, Canada', null, 'https://jobs.lever.co/vellum-example/e5e5e5e5-0000-4000-8000-000000000008', '8d'),
  ]),
  'NEW_GRAD_INTL.md': mdFile('2027 Software Engineering New Grad Positions (International)', [], [
    mdRow('Willowbrook', 'https://willowbrook.example', 'Graduate Software Engineer', 'Dublin, Ireland', null, 'https://willowbrook-example.jobs.personio.de/job/2000009', '1d'),
  ]),
};
const ai = {
  'README.md': mdFile('2027 AI/ML Internship & New Grad Positions', [
    mdRow('Nimbus Data', 'https://nimbusdata.example', 'Machine Learning Intern', 'Austin, TX', '$58/hr', 'https://jobs.ashbyhq.com/nimbus-example/f6f6f6f6-0000-4000-8000-000000000010', '4d'),
  ], [
    mdRow('Orchard Care', 'https://orchardcare.example', 'Applied AI Intern', 'Remote', null, 'https://job-boards.greenhouse.io/orchardcare-example/jobs/9900000011', '6d'),
  ]),
  'NEW_GRAD_USA.md': mdFile('2027 AI/ML New Grad Positions (USA)', [], [
    mdRow('Lumen Tutoring', 'https://lumen.example', 'ML Engineer I', 'New York, NY', null, 'https://jobs.lever.co/lumen-example/0a0a0a0a-0000-4000-8000-000000000012', '7d'),
  ]),
  'INTERN_INTL.md': mdFile('2027 AI/ML Internships (International)', [], [
    mdRow('Marlow Retail', 'https://marlow.example', 'Data Science Intern', 'Berlin, Germany', null, 'https://apply.workable.com/marlow-example/j/AI0000013/', '2d'),
  ]),
  'NEW_GRAD_INTL.md': mdFile('2027 AI/ML New Grad Positions (International)', [], [
    mdRow('Kestrel Aerospace', 'https://kestrel.example', 'Graduate ML Engineer', 'Munich, Germany', null, 'https://kestrel-example.jobs.personio.de/job/2000014', '9d'),
  ]),
};

// Remotive (not crawled; hand-made from the documented field list).
const remotive = {
  '00-warning': 'Remotive API: jobs are delayed by 24 hours. Please link back to the job URL on Remotive and mention Remotive as the source.',
  'job-count': 5,
  'total-job-count': 5,
  jobs: [
    { id: 3000001, url: 'https://remotive.com/remote-jobs/software-dev/backend-engineer-3000001', title: 'Backend Engineer', company_name: 'Acme Robotics', company_logo: '', category: 'Software Development', tags: [], job_type: 'full_time', publication_date: '2026-09-23T10:00:00', candidate_required_location: 'USA Only', salary: '$120,000 - $140,000', description: '<p>Build APIs.</p>' },
    { id: 3000002, url: 'https://remotive.com/remote-jobs/customer-support/support-agent-3000002', title: 'Support Agent', company_name: 'Birchwood Health', company_logo: '', category: 'Customer Service', tags: [], job_type: 'part_time', publication_date: '2026-09-23T09:00:00', candidate_required_location: 'Europe Only', salary: '€50k - €60k', description: '<p>Help patients.</p>' },
    { id: 3000003, url: 'https://remotive.com/remote-jobs/writing/editor-3000003', title: 'Editor', company_name: 'Cobalt Ledger', company_logo: '', category: 'Writing', tags: [], job_type: 'contract', publication_date: '2026-09-22T08:00:00', candidate_required_location: 'Worldwide', salary: '$30/hour', description: '<p>Edit docs.</p>' },
    { id: 3000004, url: 'https://remotive.com/remote-jobs/data/analyst-3000004', title: 'Data Analyst', company_name: 'Dunmore Analytics', company_logo: '', category: 'Data', tags: [], job_type: 'full_time', publication_date: '2026-09-22T07:00:00', candidate_required_location: '', salary: '', description: '<p>SQL all day.</p>' },
    { id: 3000005, url: 'https://remotive.com/remote-jobs/design/designer-3000005', title: 'Product Designer', company_name: 'Evergreen Logistics', company_logo: '', category: 'Design', tags: [], job_type: 'freelance', publication_date: '2026-09-21T07:00:00', candidate_required_location: 'USA, Canada', salary: 'competitive', description: '<p>Design screens.</p>' },
  ],
};

// USAJOBS (not crawled; hand-made from the documented example answer).
function usa(id: string, title: string, org: string, dept: string, locs: Array<{ name: string; city: string; state: string; lat: number; lon: number }>, display: string, rem: { min: string; max: string; code: string; desc: string }, grade: [string, string, string] | null, schedule: string, offering: string, open: string, close: string, details: Record<string, unknown> = {}) {
  return {
    MatchedObjectId: id,
    MatchedObjectDescriptor: {
      PositionID: `FIX-${id}`, PositionTitle: title, PositionURI: `https://www.usajobs.gov/job/${id}`,
      ApplyURI: [`https://www.usajobs.gov:443/job/${id}/apply`],
      PositionLocationDisplay: display,
      PositionLocation: locs.map((l) => ({ LocationName: l.name, CountryCode: 'United States', CountrySubDivisionCode: l.state, CityName: l.city, Longitude: l.lon, Latitude: l.lat })),
      OrganizationName: org, DepartmentName: dept,
      JobCategory: [{ Name: 'Miscellaneous Administration And Program', Code: '0301' }],
      JobGrade: grade ? [{ Code: grade[0] }] : [],
      PositionSchedule: [{ Name: schedule, Code: '1' }],
      PositionOfferingType: [{ Name: offering, Code: '15317' }],
      QualificationSummary: 'Made-up qualification summary for tests.',
      PositionRemuneration: [{ MinimumRange: rem.min, MaximumRange: rem.max, RateIntervalCode: rem.code, Description: rem.desc }],
      PositionStartDate: open, PositionEndDate: close, PublicationStartDate: open, ApplicationCloseDate: close,
      UserArea: { Details: { JobSummary: 'A made-up federal job for tests.', WhoMayApply: { Name: 'United States Citizens', Code: '' }, LowGrade: grade?.[1] ?? '', HighGrade: grade?.[2] ?? '', MajorDuties: ['Duty one.', 'Duty two.'], ...details }, IsRadialSearch: false },
    },
    RelevanceRank: 0,
  };
}
const usajobs = {
  LanguageCode: 'EN',
  SearchParameters: {},
  SearchResult: {
    SearchResultCount: 4,
    SearchResultCountAll: 4,
    SearchResultItems: [
      usa('800001', 'Program Analyst', 'Fixture Agency for Parks', 'Department of Fixtures', [{ name: 'Denver, Colorado', city: 'Denver, Colorado', state: 'Colorado', lat: 39.74, lon: -104.99 }], 'Denver, Colorado', { min: '61111', max: '79431', code: 'PA', desc: 'Per Year' }, ['GS', '09', '11'], 'Full-time', 'Permanent', '2026-09-20T00:00:00.0000Z', '2026-12-31T23:59:59.9970Z'),
      usa('800002', 'Park Guide (Seasonal)', 'Fixture Agency for Parks', 'Department of Fixtures', [{ name: 'Moab, Utah', city: 'Moab, Utah', state: 'Utah', lat: 38.57, lon: -109.55 }], 'Moab, Utah', { min: '18.50', max: '22.10', code: 'PH', desc: 'Per Hour' }, ['GS', '05', '05'], 'Part-time', 'Temporary', '2026-09-19T00:00:00.0000Z', '2026-11-30T23:59:59.9970Z'),
      usa('800003', 'IT Specialist (Remote)', 'Fixture Office of Systems', 'Department of Fixtures', [{ name: 'Anywhere in the U.S. (remote job)', city: 'Anywhere in the U.S. (remote job)', state: '', lat: 0, lon: 0 }], 'Anywhere in the U.S. (remote job)', { min: '4200', max: '5100', code: 'BW', desc: 'Bi-weekly' }, ['GS', '12', '13'], 'Full-time', 'Permanent', '2026-09-18T00:00:00.0000Z', '2026-12-15T23:59:59.9970Z', { RemoteIndicator: true, TeleworkEligible: false }),
      usa('800004', 'Records Clerk (Closed)', 'Fixture Records Center', 'Department of Fixtures', [{ name: 'Kansas City, Missouri', city: 'Kansas City, Missouri', state: 'Missouri', lat: 39.1, lon: -94.58 }], 'Kansas City, Missouri', { min: '40000', max: '52000', code: 'PA', desc: 'Per Year' }, ['GS', '04', '05'], 'Full-time', 'Permanent', '2026-01-02T00:00:00.0000Z', '2026-01-15T23:59:59.9970Z'),
    ],
    UserArea: { NumberOfPages: '1', IsRadialSearch: false },
  },
};

write('remoteok/api.json', remoteok);
write('themuse/jobs.json', themuse);
write('hn/search.json', hnSearch);
write('hn/item.json', hnItem);
write('github/simplify-listings.json', simplifyRows);
write('github/vanshb03-internships.json', vanshIntern);
write('github/vanshb03-newgrad.json', vanshNg);
for (const [f, t] of Object.entries(swe)) write(`github/speedyapply-swe/${f}`, t);
for (const [f, t] of Object.entries(ai)) write(`github/speedyapply-ai/${f}`, t);
write('remotive/remote-jobs.json', remotive);
write('usajobs/search.json', usajobs);

if (captures) {
  const J = (f: string) => JSON.parse(readFileSync(join(captures, f), 'utf8'));
  const sig = (v: unknown) => [...shapeOf(v)].sort();
  const note = 'Structural signature of the real answer read on 2026-09-25 (paths and types only, no data).';
  write('remoteok/shape.json', { note, paths: sig(J('remoteok-api.json')) });
  write('themuse/shape.json', { note, paths: sig(J('muse-remote-page0.json')) });
  write('hn/shape.json', { note, search: sig(J('hn-search.json')), item: sig(J('hn-item.json')) });
  const lists = [...shapeOf(J('simplify-listings.json')), ...shapeOf(J('vansh-listings.json')), ...shapeOf(J('vansh-ng-listings.json'))];
  const md = [...markdownHeaders(readFileSync(join(captures, 'speedy-swe-readme.md'), 'utf8')), ...(existsSync(join(captures, 'speedy-swe-ngusa.md')) ? markdownHeaders(readFileSync(join(captures, 'speedy-swe-ngusa.md'), 'utf8')) : [])];
  write('github/shape.json', { note, listings: [...new Set(lists)].sort(), markdownHeaders: [...new Set(md)].sort() });
}
console.log(`fixtures written to ${OUT}${captures ? ' (with shape signatures)' : ''}`);
