// Three more layouts of the persona's resume, to test the importer on formats it was not written for:
//   variant-caps-numeric-dates.pdf  capital headings, company line then title line, 06/2023 dates, grouped skills,
//                                   a certification and a volunteer section
//   variant-pipes-right-sidebar.pdf "Title | Company | Dates" lines, a title with no role word, the sidebar on the right
//   variant-flush-right.pdf         places and dates set flush right beside each entry (not a second column)
// Run: node test/fixtures/src/variants.ts   (headless Chrome with a throwaway profile, as make-fixtures.ts)
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const out = join(dirname(fileURLToPath(import.meta.url)), '..');
async function pdf(html: string, out: string) {
  const tmp = mkdtempSync('/private/tmp/jl-resume-chrome-');
  writeFileSync(join(tmp, 'p.html'), html);
  await new Promise<void>((resolve) => {
    const c = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${join(tmp, 'prof')}`, '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-pdf-header-footer', `--print-to-pdf=${out}`, `file://${join(tmp, 'p.html')}`], { stdio: ['ignore', 'ignore', 'pipe'] });
    let e = ''; const t = setTimeout(() => { c.kill('SIGKILL'); }, 60000);
    c.stderr.on('data', (d: Buffer) => { e += d; if (/bytes written/.test(e)) { clearTimeout(t); c.kill('SIGKILL'); } });
    c.on('exit', () => { clearTimeout(t); resolve(); });
  });
  rmSync(tmp, { recursive: true, force: true });
}
const css = `body{font-family:Georgia,serif;font-size:11pt;margin:0} @page{size:letter;margin:0.7in} h2{font-size:12pt;letter-spacing:1px;margin:10pt 0 2pt} p{margin:0 0 2pt} ul{margin:0 0 4pt 18pt;padding:0}`;
// (a)+(c)+(d)+(e): company first, caps headings, numeric dates, grouped skills, school first.
const a = `<html><head><meta charset="utf-8"><style>${css}</style></head><body>
<p style="font-size:18pt"><b>JORDAN TESTWELL</b></p><p>Austin, TX • 555-0100 • jordan.testwell@example.com • linkedin.com/in/jordan-testwell-example</p>
<h2>PROFESSIONAL SUMMARY</h2><p>Backend engineer focused on APIs and data pipelines.</p>
<h2>WORK EXPERIENCE</h2>
<p><b>Northwind Sample Labs</b>, Austin, TX</p><p><i>Software Engineer</i> &nbsp;&nbsp; 06/2023 - Present</p>
<p>• Cut batch-job time by 40% by rewriting the scheduler in TypeScript.</p><p>• Led a migration of 12 services to PostgreSQL with zero downtime.</p>
<p><b>Contoso Example Corp</b>, Dallas, TX</p><p><i>Junior Developer</i> &nbsp;&nbsp; 01/2021 - 05/2023</p>
<p>• Maintained React dashboards used by 12 engineers across 3 teams.</p>
<h2>EDUCATION</h2><p><b>Sample State University</b> — B.S., Computer Science, May 2020</p>
<h2>SKILLS</h2><p><b>Languages:</b> TypeScript, Python, SQL</p><p><b>Tools:</b> Docker, Git, AWS (EC2, S3)</p>
<h2>CERTIFICATIONS</h2><p>AWS Certified Cloud Practitioner — Amazon Web Services, 2022</p>
<h2>VOLUNTEER</h2><p>Code mentor, Sample City Library, 2019 – 2021</p>
</body></html>`;
// (b)+(f): pipes on one line, title without a role noun; sidebar on the right.
const b = `<html><head><meta charset="utf-8"><style>${css} .g{display:grid;grid-template-columns:1fr 2in;gap:0.3in}</style></head><body>
<h1 style="font-size:20pt;margin:0">Jordan Testwell</h1>
<div class="g"><div>
<h2>Experience</h2>
<p><b>Member of Technical Staff | Northwind Sample Labs | Jan 2021 – Present</b></p>
<ul><li>Cut batch-job time by 40% by rewriting the scheduler in TypeScript, which let the nightly jobs finish before the morning reports were due.</li><li>Led a migration of 12 services to PostgreSQL with zero downtime.</li></ul>
<p><b>Software Engineering Intern | Contoso Example Corp | Summer 2020</b></p>
<ul><li>Built an internal search page in React.</li></ul>
<h2>Education</h2><p>Bachelor of Science in Computer Science</p><p>Sample State University, 2016 – 2020</p>
</div><div>
<h2>Contact</h2><p>jordan.testwell@example.com</p><p>+1 (555) 010-0100</p><p>Austin, Texas</p>
<h2>Skills</h2><p>TypeScript</p><p>React</p><p>Node.js</p><p>PostgreSQL</p><p>Docker</p><p>Kubernetes</p>
<h2>Languages</h2><p>English</p><p>Spanish</p>
</div></div></body></html>`;
const css2 = `body{font-family:Arial;font-size:10.5pt;margin:0} @page{size:letter;margin:0.6in} h2{font-size:12pt;border-bottom:1px solid;margin:8pt 0 2pt} .r{display:flex;justify-content:space-between} ul{margin:0 0 3pt 16pt;padding:0}`;
const row2 = (l: string, r: string) => `<div class="r"><span>${l}</span><span>${r}</span></div>`;
const jobs2 = [
  ['Northwind Sample Labs', 'Austin, TX', 'Software Engineer', 'June 2023 – Present', ['Cut batch-job time by 40%.', 'Moved 12 services to PostgreSQL.', 'Built a billing API.']],
  ['Contoso Example Corp', 'Dallas, TX', 'Junior Developer', 'January 2021 – May 2023', ['Kept React dashboards running.', 'Wrote Python scripts.']],
  ['Fabrikam Sample Inc', 'Houston, TX', 'Data Analyst', 'June 2019 – December 2020', ['Made weekly reports.', 'Cleaned sales data.']],
] as const;
const c = `<html><head><meta charset="utf-8"><style>${css2}</style></head><body><h1 style="font-size:18pt;margin:0">Jordan Testwell</h1><p>jordan.testwell@example.com · 555-0100</p>
<h2>Experience</h2>${jobs2.map(([c, l, t, d, b]) => `${row2(`<b>${c}</b>`, l)}${row2(`<i>${t}</i>`, d)}<ul>${b.map((x) => `<li>${x}</li>`).join('')}</ul>`).join('')}
<h2>Education</h2>${row2('<b>Sample State University</b>', 'Austin, TX')}${row2('<i>B.S. in Computer Science</i>', 'May 2020')}
<h2>Skills</h2><p>TypeScript, Python, SQL</p></body></html>`;
await pdf(a, join(out, 'variant-caps-numeric-dates.pdf'));
await pdf(b, join(out, 'variant-pipes-right-sidebar.pdf'));
await pdf(c, join(out, 'variant-flush-right.pdf'));
console.log('variants written to', out);
