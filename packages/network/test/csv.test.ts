import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConnectionsCsv } from '../src/csv.ts';
import { decodeCsvBytes, looksGarbled, parseConnectedOn } from '../src/text.ts';
import { demoFixture, fileText, HEADER, NOTE_LINES } from '../src/dev/fixture.ts';

const NOW = Date.parse('2026-09-25T12:00:00Z');

test('demo fixture: 31 people, the duplicate and the broken row skipped with their lines', () => {
  const f = demoFixture(NOW);
  const r = parseConnectionsCsv(f.text);
  assert.equal(r.notAConnectionsFile, false);
  assert.equal(r.rows.length, 31);
  assert.deepEqual(r.skipped.map((s) => s.line), [36, 37]);
  assert.match(r.skipped[0]!.reason, /Duplicate.*line 11/);
  assert.match(r.skipped[1]!.reason, /Broken row: it has 3 fields/);
  assert.equal(r.headerLine, 4);
  // No note line became a person.
  assert.ok(!r.rows.some((x) => /Notes|exporting/.test(x.firstName)));
});

test('quoted commas and accents stay in their own columns, exactly as written', () => {
  const r = parseConnectionsCsv(demoFixture(NOW).text);
  const olivia = r.rows.find((x) => x.lastName === 'Núñez')!;
  assert.equal(olivia.company, 'Acme Robotics, LLC');
  assert.equal(olivia.position, 'Directora de Ingeniería, Pagos');
  assert.equal(olivia.connectedOn, '2021-06-03');
  const blake = r.rows.find((x) => x.firstName === 'Blake')!;
  assert.equal(blake.position, 'Engineering Manager, Payments');
  assert.equal(blake.email, null);
  const sam = r.rows.find((x) => x.lastName === 'Rivera')!;
  assert.equal(sam.firstName, 'Sam 🚀');
  const zhang = r.rows.find((x) => x.firstName === '张')!;
  assert.equal(zhang.maybeGarbled, false);
  const hebrew = r.rows.find((x) => x.firstName === 'דוד')!;
  assert.equal(hebrew.lastName, 'כהן');
  assert.equal(hebrew.maybeGarbled, false);
  const garbled = r.rows.find((x) => x.firstName === 'JosÃ©')!;
  assert.equal(garbled.maybeGarbled, true);
  assert.equal(garbled.lastName, 'GarcÃ­a', 'never "fixed"');
});

test('BOM and Windows line endings: the header is still found', () => {
  const rows = ['Ana,Diaz,https://www.linkedin.com/in/ana-fx,,"Stripe, Inc.",Recruiter,01 Jan 2024'];
  const text = '﻿' + fileText(rows, '\r\n');
  const r = parseConnectionsCsv(text);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0]!.company, 'Stripe, Inc.');
  assert.equal(r.rows[0]!.position, 'Recruiter');
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(fileText(rows, '\r\n'))]);
  const d = decodeCsvBytes(bytes);
  assert.equal(parseConnectionsCsv(d.text).rows.length, 1);
});

test('a header with no note lines, and a file with only the header', () => {
  assert.equal(parseConnectionsCsv(`${HEADER}\nA,B,,,C,D,01 Jan 2020\n`).rows.length, 1);
  const r = parseConnectionsCsv(`${NOTE_LINES.join('\n')}\n${HEADER}\n`);
  assert.equal(r.rows.length, 0);
  assert.equal(r.notAConnectionsFile, false);
  assert.ok(r.warnings.some((w) => /no people/.test(w)));
});

test('other CSV files are refused with a plain message and no rows', () => {
  const messages = 'CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,DATE,SUBJECT,CONTENT\n1,,A,,B,2024-01-01,,hi\n';
  const m = parseConnectionsCsv(messages);
  assert.equal(m.notAConnectionsFile, true);
  assert.equal(m.rows.length, 0);
  assert.match(m.warnings[0]!, /messages\.csv/);
  const sheet = 'Name,Email,Phone\nJordan Testwell,jordan.testwell@example.com,555\n';
  const s = parseConnectionsCsv(sheet);
  assert.equal(s.notAConnectionsFile, true);
  // A contacts export with first and last name but no Company/Position/Connected On is refused too.
  assert.equal(parseConnectionsCsv('First Name,Last Name,Email\nA,B,c@example.com\n').notAConnectionsFile, true);
  assert.equal(parseConnectionsCsv('').notAConnectionsFile, true);
});

test('an unclosed quote breaks only its own line; the rows after it are kept', () => {
  const rows = [
    'Ana,Diaz,https://www.linkedin.com/in/a-fx,,Stripe,Recruiter,01 Jan 2024',
    'Bob,Broken,https://www.linkedin.com/in/b-fx,,"Stripe, Inc,Engineer,02 Jan 2024',
    'Cy,Ok,https://www.linkedin.com/in/c-fx,,"Acme, Co",Engineer,03 Jan 2024',
    'Di,Ok,https://www.linkedin.com/in/d-fx,,Acme,Designer,04 Jan 2024',
  ];
  const r = parseConnectionsCsv(fileText(rows));
  assert.deepEqual(r.rows.map((x) => x.firstName), ['Ana', 'Cy', 'Di']);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0]!.line, 6);
  assert.match(r.skipped[0]!.reason, /quote/);
});

test('an unclosed quote on the last row is skipped with a reason, not a crash', () => {
  const r = parseConnectionsCsv(fileText(['Ana,Diaz,,,Stripe,Recruiter,01 Jan 2024', 'Bob,"Broken,,,,,']));
  assert.equal(r.rows.length, 1);
  assert.equal(r.skipped.length, 1);
});

test('a row with too many fields is skipped (a comma outside quotes), never shifted', () => {
  const r = parseConnectionsCsv(fileText(['Ana,Diaz,https://x.example/in/a,,Stripe, Inc.,Recruiter,01 Jan 2024']));
  assert.equal(r.rows.length, 0);
  assert.match(r.skipped[0]!.reason, /8 fields/);
});

test('trailing empty fields from a spreadsheet are ignored', () => {
  const r = parseConnectionsCsv(fileText(['Ana,Diaz,,,Stripe,Recruiter,01 Jan 2024,,,']));
  assert.equal(r.rows.length, 1);
});

test('duplicates: same link = one person; same name with different links = two people', () => {
  const rows = [
    'Val,Stone,https://www.linkedin.com/in/val-1,,Globex,Recruiter,08 Aug 2022',
    'Val,Stone,https://www.linkedin.com/in/val-2,,Initrode,Nurse,09 Aug 2022',
    'Val,Stone,https://www.linkedin.com/in/val-1/,,Globex,Recruiter,08 Aug 2022',
  ];
  const r = parseConnectionsCsv(fileText(rows));
  assert.equal(r.rows.length, 2);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0]!.reason, /same profile link as line 5/);
});

test('rows without a link are duplicates only when every field is the same', () => {
  const rows = ['Al,Bo,,,Acme,Engineer,01 Jan 2020', 'Al,Bo,,,Acme,Engineer,01 Jan 2020', 'Al,Bo,,,Acme,Designer,01 Jan 2020'];
  const r = parseConnectionsCsv(fileText(rows));
  assert.equal(r.rows.length, 2);
  assert.equal(r.skipped.length, 1);
});

test('a row with no name and no link is skipped; a blank company stays blank', () => {
  const r = parseConnectionsCsv(fileText([',,,,Acme,Engineer,01 Jan 2020', 'Al,Bo,,,,,']));
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0]!.company, null);
  assert.equal(r.rows[0]!.position, null);
  assert.equal(r.rows[0]!.connectedOn, null);
  assert.match(r.skipped[0]!.reason, /No name/);
});

test('columns are read by name, and semicolon files work', () => {
  const text = 'First Name;Last Name;Company;Position;Connected On;URL;Email Address\nAl;Bo;"Acme; Inc";Engineer;01 Jan 2020;;\n';
  const r = parseConnectionsCsv(text);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0]!.company, 'Acme; Inc');
  assert.equal(r.rows[0]!.email, null);
});

test('UTF-16 and Windows-1252 files are read, with a note', () => {
  const text = fileText(['Zoë,Ångström,,,Acme,Ingénieur,01 Jan 2020']);
  const le = new Uint8Array(2 + text.length * 2);
  le[0] = 0xff; le[1] = 0xfe;
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); le[2 + i * 2] = c & 0xff; le[3 + i * 2] = c >> 8; }
  const d = decodeCsvBytes(le);
  assert.equal(d.encoding, 'utf-16le');
  assert.equal(parseConnectionsCsv(d.text).rows[0]!.position, 'Ingénieur');
  const latin = Uint8Array.from([...text].map((ch) => ch.charCodeAt(0)));
  const d2 = decodeCsvBytes(latin);
  assert.equal(d2.encoding, 'windows-1252');
  assert.equal(parseConnectionsCsv(d2.text).rows[0]!.firstName, 'Zoë');
});

test('Connected On: the export format and others; ambiguous slash dates stay unknown unless the file proves the order', () => {
  assert.equal(parseConnectedOn('24 Sep 2026'), '2026-09-24');
  assert.equal(parseConnectedOn('4 Sept 2026'), '2026-09-04');
  assert.equal(parseConnectedOn('Sep 24, 2026'), '2026-09-24');
  assert.equal(parseConnectedOn('2026-09-24'), '2026-09-24');
  assert.equal(parseConnectedOn('24-Sep-26'), '2026-09-24');
  assert.equal(parseConnectedOn('30 Feb 2024'), null);
  assert.equal(parseConnectedOn('13/02/2024'), '2024-02-13');
  assert.equal(parseConnectedOn('03/04/2024'), null);
  assert.equal(parseConnectedOn('03/04/2024', 'mdy'), '2024-03-04');
  assert.equal(parseConnectedOn('yesterday'), null);
  const r = parseConnectionsCsv(fileText(['A,B,,,C,D,03/04/2024', 'E,F,,,C,D,03/25/2024']));
  assert.equal(r.rows[0]!.connectedOn, '2024-03-04');
});

test('garbled-name detection flags damage only', () => {
  for (const ok of ['José', 'Émile', 'Åsa', 'Ørsted', '张伟', '山田', 'דוד', 'Nguyễn', "O'Brien", 'Sam 🚀']) assert.equal(looksGarbled(ok), false, ok);
  for (const bad of ['JosÃ©', 'å¼ ', 'ä¼Ÿ', '???', 'Jo�e', 'Ã—Â']) assert.equal(looksGarbled(bad), true, bad);
});
