import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeedFormatError } from '../src/errors.ts';
import { child, childText, children, decodeXmlEntities, parseXml, text } from '../src/xml.ts';

test('parses elements, attributes, CDATA and entities (one layer only)', () => {
  const root = parseXml(`﻿<?xml version="1.0"?>
<!-- a comment -->
<rss version="2.0" xmlns:tt="x"><channel>
  <title>R&amp;amp;D &#8211; Z&#252;rich</title>
  <item a='1' b="two &amp; three"><description><![CDATA[<p>Kept &amp; raw</p>]]></description><tt:city>Göteborg</tt:city><empty/></item>
</channel></rss>`);
  assert.equal(root.name, 'rss');
  const ch = child(root, 'channel');
  assert.equal(childText(ch, 'title'), 'R&amp;D – Zürich');
  const item = children(ch, 'item')[0];
  assert.deepEqual(item.attrs, { a: '1', b: 'two & three' });
  assert.equal(childText(item, 'description'), '<p>Kept &amp; raw</p>');
  assert.equal(childText(item, 'tt:city'), 'Göteborg');
  assert.equal(text(child(item, 'empty')), '');
  assert.equal(childText(item, 'missing'), '');
});

test('unknown named entities stay as written; bad numeric references become U+FFFD', () => {
  assert.equal(decodeXmlEntities('a&nbsp;b &#0; &#x110000; &lt;'), 'a&nbsp;b � � <');
});

test('refuses what is not a whole XML document, with a plain reason', () => {
  const cases: Array<[string, RegExp]> = [
    ['', /empty body/],
    ['   \n ', /empty body/],
    ['<!DOCTYPE html><html><body>Not found</body></html>', /HTML page/],
    ['<html><head><title>x</title></head></html>', /HTML page/],
    ['{"offers": []}', /not XML/],
    ['<workzag-jobs><position><id>1</id>', /cut off/],
    ['<workzag-jobs><position><id>1</id></position', /cut off/],
    ['<a><b></a></b>', /closes <a> while <b> is open/],
    ['<a></a><b></b>', /more than one root/],
    ['<a></a> trailing text', /outside the XML root/],
    ['<a><![CDATA[never ends', /cut off/],
    ['<a x=1></a>', /not quoted/],
    ['<a>< 5</a>', /does not start a tag/],
  ];
  for (const [input, re] of cases) {
    assert.throws(() => parseXml(input, 'http://x/feed'), (e: unknown) => e instanceof FeedFormatError && re.test(e.message), input);
  }
});

test('a DOCTYPE is skipped and its custom entities are never expanded', () => {
  const root = parseXml('<!DOCTYPE r [<!ENTITY boom "BOOM">]><r>&boom;</r>');
  assert.equal(text(root), '&boom;');
});

test('reads a 5 MB feed in well under a second', () => {
  const item = '<position><id>1</id><name>Engineer &amp; more</name><jobDescriptions><jobDescription><name>x</name><value><![CDATA[<p>' + 'x'.repeat(900) + '</p>]]></value></jobDescription></jobDescriptions></position>';
  const big = '<workzag-jobs>' + item.repeat(5000) + '</workzag-jobs>';
  const t0 = performance.now();
  const root = parseXml(big);
  const ms = performance.now() - t0;
  assert.equal(children(root, 'position').length, 5000);
  assert.ok(ms < 1000, `took ${ms} ms`);
});
