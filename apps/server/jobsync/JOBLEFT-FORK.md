# jobsync fork inside jobleft

This folder is a fork of jobsync (MIT licence, see `LICENSE`, copyright (c) 2024 gsync).

| Item | Value |
|---|---|
| Upstream | https://github.com/Gsync/jobsync |
| Commit | `527333e` (release 1.1.20), taken from the read-only clone `vendor/jobsync` |
| Copied | The source tree without `node_modules`, `.next`, `.git` and the screenshots |
| Patches | The four spike S3 patches in `spikes/s3-shell/patches/`, applied in order with `patch -p1` (all four applied cleanly; the result is identical to the spike's patched tree) |
| Removed | The old jobsync pages and every route under `src/app` (dashboard and admin pages, sign-in pages, all `/api/*` routes, including the MCP agent-tool endpoint), `src/middleware.ts`, the Playwright end-to-end tests, the Docker, deploy and CI files, `public/`, `evals/` and the nine unit tests that tested the removed routes and pages |

## What runs, and what does not

jobleft does NOT run this Next.js app. The jobleft server is the plain Node server in `apps/server/src`
(docs/INTERFACES.md, decision 1: one small process, no Next build, no Prisma engines, the security rules of section
6.1 in one place). Nothing in this folder is served, bundled or started, so none of its old pages or routes can answer
a request.

This folder is the port source. The pieces the jobleft server uses today are ported into `apps/server/src` with a
notice at the top of each file:

| jobleft file | Ported from (this folder) | What |
|---|---|---|
| `apps/server/src/interim/ai.ts` | `src/lib/ai/custom-endpoint.ts`, `src/lib/ai/provider-registry.server.ts` (patch 03) | An OpenAI-compatible provider is a base URL plus an optional key, served through Chat Completions; its check asks `GET <base>/models`, and a 404 there still means "usable" |
| `apps/server/src/interim/ai.ts` | `src/lib/ai/ollama-capabilities.ts`, `src/app/api/ai/chat/route.ts` (patch 04) | Ollama gets `think: true` only for models whose `/api/show` lists the "thinking" capability |

`@jobleft/ai-engine` replaces the ported provider code when that lane lands.

## Tests that still apply

The unit tests of the code that remains still pass (229 test files, 2,795 tests, run again on 2026-09-25 by the server
lane), including the provider tests that patches 03 and 04 changed (`__tests__/custom-provider.spec.ts`,
`__tests__/provider-registry.spec.ts`). They need jobsync's own dependencies, which are not part of the jobleft
workspace. `apps/server/README.md` section 14 gives the exact commands (install outside the repository with
`--ignore-scripts`, add `jsdom`, make the Prisma client), then:

```sh
JOBSYNC_DEPS=/private/tmp/jl-jobsync-deps/node_modules apps/server/scripts/jobsync-tests.sh
```
