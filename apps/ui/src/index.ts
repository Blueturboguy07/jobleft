// @jobleft/ui: the desktop UI. React and Ant Design 5, built by Vite into apps/ui/dist, served by the local server
// at "/". It talks only to the LOCAL API (createLocalApiClient from @jobleft/contracts) with the launch token that
// the shell puts in the URL fragment (#token=...). It loads nothing from the internet (fonts and icons are bundled).
// Status: built by the UI lane (React 18, Ant Design 5, Vite). This file stays free of React so Node can import it.
// Interface: docs/INTERFACES.md, section "@jobleft/ui".

export const PACKAGE_NAME = '@jobleft/ui';

/** The screens (hash routes) of the app. Layout targets are the measured design notes of the research folder (ui/UI-SPEC and ui/UI-SPEC-LOGGED-IN). */
export const SCREENS = {
  feed: '#/jobs',                        // Recommended feed: filters, sort, saved filters, cards with match tiles
  liked: '#/jobs/liked',                 // Liked tab (Active / Closed)
  applied: '#/jobs/applied',             // Applied tab (Applied, Interviewing, Offer Received, Rejected, Archived)
  external: '#/jobs/external',           // External tab (add a job by URL or text)
  hidden: '#/jobs/hidden',               // "Not interested" list with undo
  job: '#/jobs/:jobId',                  // Job detail (Overview, Company) opened in place; Esc returns to the list
  resumes: '#/resume',                   // Resume list, editor, analysis report, tailoring review
  profile: '#/profile',                  // Profile (Personal, Education, Work Experience, Skills, Equal Employment)
  onboarding: '#/onboarding',            // First run: preferences, resume upload, provider choice
  network: '#/network',                  // Network tool (import, companies, who to contact, plan, tracking)
  practice: '#/interview',               // Interview practice per job and the personal question bank
  boards: '#/boards',                    // Board directory, user boards, sources and their health
  settings: '#/settings',                // AI provider, publik balance, crawl schedule, data folder, backup, pairing
  // added by the UI lane (additive)
  tracker: '#/tracker',                  // Application tracker: board and table by stage, reminders, closed postings
  dashboard: '#/dashboard',              // Counts, applications per week, reminders, refresh summary, alerts
  assistant: '#/assistant',              // The assistant (copilot chat), full screen, with saved conversations
  notifications: '#/notifications',      // Notifications: new jobs, saved-filter alerts, reminders, follow-ups
  settingsTab: '#/settings/:tab',        // ai, balance, alerts, sources, data, extension, about
  resumeEditor: '#/resume/:resumeId',    // One resume in the editor
} as const;

/** Reads the launch token from the URL fragment once, then removes it from the address bar. */
export function takeTokenFromFragment(hash: string): { token: string | null; rest: string } {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const token = params.get('token');
  params.delete('token');
  return { token, rest: params.toString() };
}
