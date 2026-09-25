import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileText } from '../src/dev/fixture.ts';
import { fileService, memoryService, NOW, tempHome } from './helpers.ts';

const base = [
  'Avery,Quill,https://www.linkedin.com/in/aq,avery.quill@example.com,"Stripe, Inc.",Technical Recruiter,16 Aug 2026',
  'Blake,Ormond,https://www.linkedin.com/in/bo,,"Stripe, Inc.",Engineering Manager,17 Jul 2024',
  'Casey,Brandt,https://www.linkedin.com/in/cb,,Initrode,Software Engineer,14 Mar 2015',
  'Val,Stone,https://www.linkedin.com/in/val-1,,Globex,Recruiter,08 Aug 2022',
  'Val,Stone,https://www.linkedin.com/in/val-2,,Initrode,Nurse,09 Aug 2022',
];

test('O9: stages, notes and dates survive a restart and a re-import; a new person is To contact; a gone person is kept and reported', () => {
  const h = tempHome();
  try {
    let { service, db } = fileService(h.dir);
    service.import(fileText(base));
    const [avery, blake, casey] = ['Avery', 'Blake', 'Casey'].map((n) => service.list({ q: n })[0]!);
    service.update(avery!.id, { stage: 'messaged', note: 'Asked about the payments team.', followUpOn: '2026-10-01' });
    service.update(blake!.id, { stage: 'replied', note: 'Coffee next week', inPlan: true });
    service.update(casey!.id, { stage: 'met', note: 'Met at a meetup', followUpOn: '2026-09-30' });
    db.close();
    ({ service, db } = fileService(h.dir));
    const again = service.get(avery!.id)!;
    assert.equal(again.stage, 'messaged');
    assert.equal(again.note, 'Asked about the payments team.');
    assert.equal(again.followUpOn, '2026-10-01');
    // Newer file: Blake has a new position, Dana is new, Casey is gone.
    const newer = [base[0]!, base[1]!.replace('Engineering Manager', 'Director of Engineering'), base[3]!, base[4]!,
      'Dana,Lee,https://www.linkedin.com/in/dl,,Stripe,Designer,01 Sep 2026'];
    const s = service.import(fileText(newer));
    assert.equal(s.imported, 1);
    assert.equal(s.updated, 1);
    assert.equal(s.unchanged, 3);
    assert.equal(s.missingFromFile, 1);
    assert.ok(s.warnings.some((w) => /not in this file/.test(w)));
    const b = service.get(blake!.id)!;
    assert.equal(b.position, 'Director of Engineering');
    assert.equal(b.stage, 'replied');
    assert.equal(b.note, 'Coffee next week');
    assert.equal(b.inPlan, true);
    const c = service.get(casey!.id)!;
    assert.equal(c.note, 'Met at a meetup', 'a person gone from the file keeps the notes');
    assert.equal(c.inLatestFile, false);
    const dana = service.list({ q: 'Dana' })[0]!;
    assert.equal(dana.stage, 'to_contact');
    assert.equal(service.total(), 6, 'no one was duplicated');
    // Two people with the same name stay two people with their own notes.
    const vals = service.list({ q: 'Val Stone' });
    assert.equal(vals.length, 2);
    service.update(vals[0]!.id, { note: 'Globex one' });
    assert.equal(service.get(vals[1]!.id)!.note, null);
    // Coming back in a later file clears the flag.
    service.import(fileText([...newer, base[2]!]));
    assert.equal(service.get(casey!.id)!.inLatestFile, true);
    assert.equal(service.get(casey!.id)!.note, 'Met at a meetup');
    db.close();
  } finally { h.done(); }
});

test('rows without a profile link keep their tracking when an email is added', () => {
  const s = memoryService();
  s.import(fileText(['Al,Bo,,,Acme,Engineer,01 Jan 2020']));
  const id = s.list()[0]!.id;
  s.update(id, { note: 'keep me', stage: 'messaged' });
  const r = s.import(fileText(['Al,Bo,,al.bo@example.com,Acme,Engineer,01 Jan 2020']));
  assert.equal(r.updated, 1);
  assert.equal(r.imported, 0);
  assert.equal(s.get(id)!.note, 'keep me');
  assert.equal(s.get(id)!.email, 'al.bo@example.com');
});

test('a failed import (not a connections file) changes nothing', () => {
  const s = memoryService();
  s.import(fileText(base));
  const before = s.total();
  const r = s.import('CONVERSATION ID,FROM,TO\n1,a,b\n');
  assert.equal(r.notAConnectionsFile, true);
  assert.equal(s.total(), before);
  assert.equal(s.list().filter((c) => !c.inLatestFile).length, 0);
});

test('update validates input and refuses unknown contacts', () => {
  const s = memoryService();
  s.import(fileText(base));
  const id = s.list()[0]!.id;
  assert.throws(() => s.update(id, { followUpOn: '2026-02-30' }), /real date/);
  assert.throws(() => s.update(id, { stage: 'hired' as never }), /Unknown stage/);
  assert.throws(() => s.update('c_nope', { stage: 'met' }), /No such contact/);
  assert.equal(s.update(id, { note: '   ' }).note, null);
});

test('O9: a follow-up due today in the person\'s time zone is due and reminds once, also after a restart', () => {
  const h = tempHome();
  try {
    // 2026-09-26T02:00Z is still 25 Sep in Chicago (UTC-5), and already 26 Sep in UTC.
    const t = Date.parse('2026-09-26T02:00:00Z');
    let { service, db } = fileService(h.dir, () => t, 'America/Chicago');
    service.import(fileText(base));
    const [a, b] = service.list();
    assert.equal(service.today(), '2026-09-25');
    service.update(a!.id, { followUpOn: '2026-09-25' });
    service.update(b!.id, { followUpOn: '2026-09-26' });
    assert.deepEqual(service.due().map((c) => c.id), [a!.id]);
    assert.equal(service.list({ due: true }).length, 1);
    assert.equal(service.get(a!.id)!.followUpDue, true);
    assert.equal(service.get(b!.id)!.followUpDue, false);
    db.close();
    // A restart before the reminder was shown: it still shows, once.
    ({ service, db } = fileService(h.dir, () => t, 'America/Chicago'));
    const r1 = service.takeReminders();
    assert.equal(r1.count, 1);
    assert.doesNotMatch(r1.text!.body, /Avery|Blake|Quill|Ormond/, 'no names in a notification');
    assert.equal(service.takeReminders().count, 0);
    db.close();
    ({ service, db } = fileService(h.dir, () => t + 86_400_000, 'America/Chicago'));
    assert.equal(service.takeReminders().count, 1, 'the next day, the second follow-up reminds');
    // Changing the date re-arms the reminder.
    service.update(a!.id, { followUpOn: '2026-09-26' });
    assert.equal(service.takeReminders().count, 1);
    db.close();
  } finally { h.done(); }
});

function grepDir(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else {
        const buf = readFileSync(p);
        if (buf.includes(Buffer.from(needle, 'utf8'))) hits.push(p);
      }
    }
  };
  walk(dir);
  return hits;
}

test('O10: delete all leaves no name, email or note in any file of the data folder; the source file is untouched', () => {
  const h = tempHome();
  try {
    const src = join(h.dir, 'Connections.csv');
    const text = fileText([...base, 'Zyxwq,Uniquename,https://www.linkedin.com/in/zu,zyxwq.uniquename@example.com,Qqqcorp,Recruiter,01 Jan 2025']);
    writeFileSync(src, text);
    const home = join(h.dir, 'home');
    const { service, db } = fileService(home);
    service.import(readFileSync(src, 'utf8'));
    const z = service.list({ q: 'Uniquename' })[0]!;
    service.update(z.id, { note: 'Secretnoteword first version', stage: 'messaged', followUpOn: '2026-10-01', inPlan: true });
    service.update(z.id, { note: 'Secretnoteword second version' });
    service.import(readFileSync(src, 'utf8'));
    assert.ok(grepDir(home, 'Uniquename').length > 0, 'the data is on disk before the delete');
    const n = service.deleteAll();
    assert.equal(n, 6);
    assert.deepEqual(service.list({ q: 'Uniquename' }), []);
    assert.equal(service.countFor('stripe'), null);
    for (const needle of ['Uniquename', 'zyxwq.uniquename@example.com', 'Secretnoteword', 'Qqqcorp', 'Quill']) {
      assert.deepEqual(grepDir(home, needle), [], `"${needle}" is gone from every file`);
    }
    assert.equal(readFileSync(src, 'utf8'), text, 'the person\'s own file is unchanged');
    db.close();
    assert.deepEqual(grepDir(home, 'Uniquename'), []);
  } finally { h.done(); }
});

test('O10: deleting one contact removes only that person, on disk too', () => {
  const h = tempHome();
  try {
    const { service, db } = fileService(h.dir);
    service.import(fileText(base));
    const casey = service.list({ q: 'Casey' })[0]!;
    service.update(casey.id, { note: 'Onlycaseynote' });
    assert.equal(service.delete(casey.id), true);
    assert.equal(service.delete(casey.id), false);
    assert.equal(service.total(), 4);
    assert.ok(service.list({ q: 'Avery' }).length === 1);
    assert.deepEqual(grepDir(h.dir, 'Onlycaseynote'), []);
    assert.deepEqual(grepDir(h.dir, 'Brandt'), []);
    assert.ok(grepDir(h.dir, 'Ormond').length > 0, 'the others stay');
    db.close();
    assert.ok(existsSync(join(h.dir, 'data', 'jobleft.db')));
  } finally { h.done(); }
});

test('coverage: known targets first, "no one yet" kept, and one action adds the top people to the plan', () => {
  const s = memoryService();
  s.import(fileText(base));
  const cov = s.coverage([
    { companyKey: 'stripe', companyName: 'Stripe' }, { companyKey: 'figma', companyName: 'Figma' },
    { companyKey: 'initrode', companyName: 'Initrode' }, { companyKey: 'stripe', companyName: 'Stripe, Inc.' },
  ]);
  assert.deepEqual(cov.map((c) => [c.companyName, c.count]), [['Initrode', 2], ['Stripe', 2], ['Figma', 0]]);
  const added = s.addTopToPlan('stripe', 2, null);
  assert.equal(added.length, 2);
  assert.ok(added.every((c) => c.inPlan && c.stage === 'to_contact'));
  const plan = s.plan();
  assert.equal(plan.length, 1);
  assert.equal(plan[0]!.contacts.length, 2);
  assert.match(plan[0]!.contacts[0]!.nextStep, /Draft a short note/);
  // A later import that adds someone at Figma moves Figma to the known group.
  s.import(fileText([...base, 'Fi,Gma,https://www.linkedin.com/in/fg,,Figma,Designer,01 Jan 2026']));
  assert.equal(s.coverage([{ companyKey: 'figma', companyName: 'Figma' }])[0]!.count, 1);
});

test('O14: 30,000 rows import well under 30 seconds', async () => {
  const { syntheticFixture } = await import('../src/dev/fixture.ts');
  const s = memoryService();
  const text = syntheticFixture(30000, 3, NOW);
  const t0 = performance.now();
  const r = s.import(text);
  const ms = performance.now() - t0;
  assert.equal(r.imported, 30000);
  assert.ok(ms < 30000, `took ${ms} ms`);
  const t1 = performance.now();
  for (let i = 0; i < 1000; i++) s.countFor('stripe');
  assert.ok(performance.now() - t1 < 200, 'counts come from the cached map');
});

test('counts follow changes made by another process (another connection to the same file)', () => {
  const h = tempHome();
  try {
    const a = fileService(h.dir);
    const b = fileService(h.dir);
    assert.equal(a.service.countFor('stripe'), null);
    b.service.import(fileText(base));
    assert.equal(a.service.countFor('stripe'), 2, 'the other connection sees the import');
    b.service.deleteAll();
    assert.equal(a.service.countFor('stripe'), null, 'and the delete');
    assert.deepEqual(grepDir(h.dir, 'Quill'), [], 'a delete while another process has the file open still leaves nothing');
    a.db.close(); b.db.close();
  } finally { h.done(); }
});
