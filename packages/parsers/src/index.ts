// @jobleft/parsers: pure parsers for the facts of a job posting.
// Ported from the S1 spike (spikes/s1-ingest/crawler/src): level, location, pay and HTML to text.
// Every function is pure (no network, no clock, no file access), so it is safe in any process.
// Interface: docs/INTERFACES.md, section "@jobleft/parsers".

export const PACKAGE_NAME = '@jobleft/parsers';

export type { Level, PayPeriod } from './types.ts';
export { decodeEntities, htmlToText, unescapeEncodedHtml } from './html.ts';
export { levelFromDescription, levelFromTitle } from './level.ts';
export { isRemoteText, isUsLocation } from './location.ts';
export { annualize, parsePayFromText } from './pay.ts';
export type { ParsedPay } from './pay.ts';
