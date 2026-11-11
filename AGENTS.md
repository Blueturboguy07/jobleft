# jobleft for agents

The desktop shell is `apps/shell` (Tauri 2, a Node sidecar); the local service is `apps/server`; the UI is `apps/ui`.
The publik module is `apps/server/src/publik.ts`; its page in the app window is `apps/server/src/http/publik-gate.ts`;
`apps/server/src/main.ts` runs the gate as soon as the server listens.

## publik API
- Base URL: https://publikhq.com/api/v1 (OpenAI Chat Completions, Responses, Anthropic Messages)
- Models: publik-fast, publik-balanced, publik-smart only; never a vendor model name
- Sign in with publik: the publik module's gate runs at start-up, before the first screen; it also sends usage telemetry
- Key: per-install `pk_` from POST /installs, stored at the publik credential path; env PUBLIK_API_KEY / PUBLIK_API_BASE_URL override
- App token: `apps/shell/publik-app-token.local` (git-ignored) or JOBLEFT_PUBLIK_APP_TOKEN at build time; the shell passes it to the sidecar at run time
- 402: show error.message plus error.top_up_url only
- Never print or log a key
- Docs: https://publikhq.com/llms.txt, https://publikhq.com/developers, https://publikhq.com/skills/api.md
