// @jobleft/extension: the Chrome MV3 autofill extension (assisted apply). It fills, the person reviews, the person
// submits. It talks only to the paired app on 127.0.0.1 (protocol in @jobleft/contracts src/extension.ts).
// It never submits, never solves a CAPTCHA, never reads a page until asked, and never works on LinkedIn, Indeed or
// Glassdoor. Sensitive questions (EEO, work authorization, sponsorship, pay, date of birth) stay empty unless the
// person saved an answer. Written answers are drafts until the person accepts them.
//
// This entry point is the Node-side interface of the package: the pure modules the APP uses to answer the
// extension (the server's `fill`, `extensionPage` and `extensionDrafts` routes). The browser bundles are built
// from src/background.ts, src/popup.ts and src/content/main.ts by `pnpm --filter @jobleft/extension build`.
// Interface: docs/INTERFACES.md, section "@jobleft/extension" and "Extension protocol".

import { DEFAULT_PORT, EXTENSION_PROTOCOL_VERSION, PORT_SPAN } from '@jobleft/contracts';
import type { AtsId } from '@jobleft/contracts';
import { SUPPORT } from './support.ts';

export const PACKAGE_NAME = '@jobleft/extension';
export { EXTENSION_PROTOCOL_VERSION };

/** Where the extension looks for the app: GET /api/v1/health on each port until one answers app "jobleft". */
export const APP_PORTS: readonly number[] = Array.from({ length: PORT_SPAN }, (_, i) => DEFAULT_PORT + i);

/**
 * Support level the popup shows before a fill (extension O13). Greenhouse, Lever, Ashby and Workable are supported.
 * Workday is partial (last). iCIMS is partial: no iCIMS form could be tested (no live iCIMS requests are allowed).
 */
export const ATS_SUPPORT: Readonly<Partial<Record<AtsId, 'supported' | 'partial'>>> = SUPPORT;

/** Hosts where the extension never reads, fills or adds anything (every country domain and subdomain too). */
export const NEVER_HOSTS = /(^|\.)(linkedin|indeed|glassdoor)(\.[a-z]{2,}){1,2}$|(^|\.)(lnkd\.in|licdn\.com)$/i;

export { answerFill, openQuestions } from './answer.ts';
export type { AnswerContext, ResumeFile } from './answer.ts';
export { classify, isSensitive, SENSITIVE_TOPICS } from './classify.ts';
export type { Classification, SensitiveTopic, Topic } from './classify.ts';
export { pickOption, pickMany, parseDegree } from './options.ts';
export type { MatchKind, Opt } from './options.ts';
export { templateDraft, contactLeaks } from './drafts.ts';
export type { DraftJob } from './drafts.ts';
export { pageKey } from './pagekey.ts';
export { isNeverHost, supportFromUrl, supportFor, atsFromUrl } from './support.ts';
export type { SupportInfo, SupportLevel } from './support.ts';
