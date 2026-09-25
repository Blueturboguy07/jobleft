// Fit order with the real model (bge-small-en-v1.5): 30 hand-written profiles, each with a target job that shares
// few words with it, hidden among synthetic jobs. Runs only when JOBLEFT_TEST_MODEL_DIR points at a verified model
// folder (for example after `jobleft-store model download`): it needs the model and about a minute of CPU.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createBgeEmbedder, FitIndex, SynthGenerator } from '../src/index.ts';
import { CTX, NOW, freshStore } from './helpers.ts';

const MODEL = process.env.JOBLEFT_TEST_MODEL_DIR ?? '';
const SIZE = Number(process.env.JOBLEFT_TEST_FIT_SIZE ?? 3000);

const PAIRS: Array<[string, string, string]> = [
  ['Invoices, vendor payments and month-end close; reconciling ledgers.', 'AP Specialist', 'Process supplier bills, run three-way match against purchase orders, and help the controller close the books each period.'],
  ['I keep Kubernetes clusters healthy, write CI/CD pipelines and carry the pager.', 'Site Reliability Engineer', 'Own uptime of our container platform, automate deploys, respond to incidents and write postmortems.'],
  ['Bedside care in intensive care units, ventilator patients, charting in Epic.', 'Critical Care RN', 'Care for critically ill adults on mechanical support; document assessments in the electronic health record.'],
  ['Cold outreach, booking demos and qualifying leads for a software company.', 'SDR', 'Prospect new accounts by phone and email and set first meetings for the account executives.'],
  ['Wireframes, prototypes and usability sessions for mobile apps.', 'Product Designer', 'Shape flows from sketch to high fidelity in Figma and test them with real users.'],
  ['Hiring engineers: sourcing on LinkedIn, phone screens, closing offers.', 'Technical Recruiter', 'Find and attract software talent, run the interview loop and negotiate offers.'],
  ['Dashboards in Tableau, SQL queries, weekly business reviews.', 'BI Analyst', 'Turn data warehouse tables into reports and insight for leadership.'],
  ['Training neural networks, PyTorch, deploying models to production.', 'ML Engineer', 'Build and ship deep learning systems; own training pipelines and model serving.'],
  ['Forklift certified, loading trucks, cycle counts in a distribution center.', 'Material Handler', 'Move pallets with powered equipment, stage outbound freight and keep stock records accurate.'],
  ['Wiring homes, reading blueprints, troubleshooting circuits.', 'Journeyman Electrician', 'Install and repair electrical systems in residential projects per code.'],
  ['Payroll processing for 500 employees, tax filings, ADP.', 'Payroll Administrator', 'Run semi-monthly pay, handle withholdings and quarterly filings.'],
  ['Teaching algebra to ninth graders, lesson plans, grading.', 'Math Teacher', 'Deliver high school mathematics instruction and assess student progress.'],
  ['Drafting NDAs and MSAs, redlining vendor contracts.', 'Commercial Counsel', 'Negotiate customer and supplier agreements and advise the business on risk.'],
  ['Answering customer tickets in Zendesk, refunds, chat support.', 'Customer Care Associate', 'Help shoppers by email and live chat, resolve order issues and process returns.'],
  ['Writing blog posts, SEO keywords, editorial calendar.', 'Content Strategist', 'Plan and produce articles that grow organic traffic.'],
  ['iOS apps in Swift, SwiftUI screens, App Store releases.', 'Mobile Developer', 'Build native iPhone features and ship regular updates.'],
  ['HVAC repair, refrigerant handling, service calls.', 'Field Technician', 'Maintain heating and cooling equipment at client sites.'],
  ['Sprint planning, backlog grooming, standups for dev teams.', 'Scrum Master', 'Coach agile teams and run ceremonies to keep delivery on track.'],
  ['Tax returns for small businesses, CPA, IRS correspondence.', 'Tax Associate', 'Prepare corporate and partnership filings and research tax questions.'],
  ['Managing a restaurant kitchen, menu costing, food safety.', 'Kitchen Manager', 'Lead line cooks, control food cost and keep the kitchen inspection ready.'],
  ['Clinical trials coordination, patient enrollment, IRB submissions.', 'Clinical Research Coordinator', 'Run study visits, consent participants and keep regulatory binders current.'],
  ['Network routers and switches, Cisco, VPN setup.', 'Network Administrator', 'Maintain the corporate LAN and WAN and secure remote access.'],
  ['Pentesting web apps, OWASP, writing vulnerability reports.', 'Security Engineer', 'Find and fix application security weaknesses before attackers do.'],
  ['Onboarding new hires, benefits enrollment, HR policies.', 'People Operations Specialist', 'Run the employee lifecycle from first day paperwork to benefits questions.'],
  ['Growing revenue from existing SaaS customers, renewals, upsells.', 'Account Manager', 'Own a book of accounts, drive expansion and keep customers renewing.'],
  ['Physical therapy for sports injuries, rehab plans.', 'Physical Therapist', 'Evaluate patients and deliver treatment to restore movement after injury.'],
  ['Budgets, forecasts and variance analysis for the CFO.', 'FP&A Analyst', 'Build the annual operating plan and monthly outlooks for finance leadership.'],
  ['Supply chain planning, purchase orders, supplier negotiations.', 'Procurement Specialist', 'Source materials, place orders and manage vendor performance.'],
  ['React front ends, TypeScript, component libraries.', 'UI Engineer', 'Build the web client and its design system in modern JavaScript.'],
  ['Social media posts, Instagram and TikTok campaigns, community.', 'Social Media Manager', 'Run our brand channels and grow an engaged audience.'],
];

test('fit order finds the target job for most hand-written profiles (real model)', { skip: !MODEL || !existsSync(MODEL) ? 'set JOBLEFT_TEST_MODEL_DIR to a model folder' : false, timeout: 900_000 }, async () => {
  const s = freshStore();
  const g = new SynthGenerator({ seed: 77, now: NOW });
  s.upsertJobs(Array.from({ length: SIZE }, (_, i) => g.job(i)), { now: NOW });
  s.upsertJobs(PAIRS.map(([, title, description], i) => ({ id: `target:${i}`, title, company: `Target Company ${i}`, url: `https://jobs.example.com/target/${i}`, description })), { now: NOW });
  const e = await createBgeEmbedder({ modelDir: MODEL });
  const fit = new FitIndex(s.db, e);
  await fit.runAll();
  let hits = 0;
  const misses: string[] = [];
  for (const [i, [profile]] of PAIRS.entries()) {
    const pv = await fit.profileVector(profile);
    const r = s.search({ sort: 'top_matched', limit: 10 }, { ...CTX, profileVector: pv, fit });
    if (r.items.some((it) => it.job.id === `target:${i}`)) hits++; else misses.push(PAIRS[i]![1]);
  }
  // Negative control: profile i with target i+7 must NOT land in the first 10 (the ranking is about duties, not style).
  let wrong = 0;
  for (const [i, [profile]] of PAIRS.entries()) {
    const j = (i + 7) % PAIRS.length;
    const pv = await fit.profileVector(profile);
    const r = s.search({ sort: 'top_matched', limit: 10 }, { ...CTX, profileVector: pv, fit });
    if (r.items.some((it) => it.job.id === `target:${j}`)) wrong++;
  }
  await e.close();
  process.stderr.write(`fit quality: ${hits} of ${PAIRS.length} targets in the first 10 among ${SIZE + PAIRS.length} jobs; missed: ${misses.join(', ')}; wrong target in the first 10: ${wrong}\n`);
  assert.ok(hits >= 25, `only ${hits} of 30`);
  assert.ok(wrong <= 5, `wrong target in the first 10 for ${wrong} of 30`);
});
