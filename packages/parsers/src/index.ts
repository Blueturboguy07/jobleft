// @jobleft/parsers: pure, offline readers for the facts of a job posting (level, pay, place, work model, years).
// Every function is pure (no network, no clock, no file access), so it is safe in any process.
// Interface: docs/INTERFACES.md, section "@jobleft/parsers". Use `extractFacts` for everything at once.

export const PACKAGE_NAME = '@jobleft/parsers';

export type { Level, PayPeriod } from './types.ts';

// All facts at once.
export { extractFacts } from './facts.ts';
export type { PostingFacts } from './facts.ts';

// Board formats (fact fields of public job-board answers).
export { detectFormat, fromAshby, fromBoard, fromGreenhouse, fromJsonLd, fromLever, fromPersonio, fromRecruitee, fromWorkable, postingsFromBoard } from './board.ts';
export type { BoardFormat, PostingInput } from './board.ts';

// HTML.
export { decodeEntities, htmlToText, unescapeEncodedHtml } from './html.ts';

// Pay.
export { annualize, parseNumber, parsePay, parsePayFromText, payFromBoard } from './pay.ts';
export type { BoardPay, ParsedPay, PayParseOptions, PayResult } from './pay.ts';
export { formatPay, PAY_FILTER_RULE, payMeetsMinimum, paySortKey, yearlyPay } from './pay-filter.ts';

// Places and country.
export { countryName, isRemoteText, isUsLocation, parseLocationText, parsePlaces, placeFromAddress, placesFromText, usFromFacts } from './places.ts';
export type { BoardAddress, LocationParse } from './places.ts';

// Work model and remote area.
export { parseWorkModel, regionsOfArea, workModelFromField } from './workmodel.ts';
export type { WorkModelFields, WorkModelResult } from './workmodel.ts';

// Seniority and years.
export { BUCKETS, bucketsForYears, bucketsFromBoardSeniority, levelFromDescription, levelFromTitle, levelsOf, parseLevel, readTitle } from './level.ts';
export type { LevelInput, LevelResult } from './level.ts';
export { parseYearsRequired } from './years.ts';
export type { YearsResult } from './years.ts';

// What the posting says about sponsorship, clearance and citizenship; employment type.
export { parseEmploymentType, parseStatements } from './statements.ts';
export type { StatementsResult } from './statements.ts';
