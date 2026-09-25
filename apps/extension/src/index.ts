// @jobleft/extension: the Chrome MV3 autofill extension (assisted apply). It fills, the person reviews, the person
// submits. It talks only to the paired app on 127.0.0.1 (protocol in @jobleft/contracts src/extension.ts).
// It never submits, never solves a CAPTCHA, never reads a page until asked, and never works on LinkedIn, Indeed or
// Glassdoor. Sensitive questions (EEO, work authorization, sponsorship, pay, date of birth) stay empty unless the
// person saved an answer. Written answers are drafts until the person accepts them.
// Status: skeleton (foundation). The extension lane builds the service worker, content scripts and popup.
// Interface: docs/INTERFACES.md, section "@jobleft/extension" and "Extension protocol".

import { DEFAULT_PORT, EXTENSION_PROTOCOL_VERSION, PORT_SPAN } from '@jobleft/contracts';
import type { AtsId } from '@jobleft/contracts';

export const PACKAGE_NAME = '@jobleft/extension';
export { EXTENSION_PROTOCOL_VERSION };

/** Where the extension looks for the app: GET /api/v1/health on each port until one answers app "jobleft". */
export const APP_PORTS: readonly number[] = Array.from({ length: PORT_SPAN }, (_, i) => DEFAULT_PORT + i);

/** Support level the popup shows before a fill (extension O13). Workday is partial and last. */
export const ATS_SUPPORT: Readonly<Partial<Record<AtsId, 'supported' | 'partial'>>> = {
  greenhouse: 'supported', lever: 'supported', ashby: 'supported', workable: 'supported', icims: 'supported', workday: 'partial',
};

/** Hosts where the extension never reads, fills or adds anything. */
export const NEVER_HOSTS = /(^|\.)(linkedin\.com|indeed\.com|glassdoor\.com)$/i;
