# publik contract excerpt (copied for offline ground truth)

Source: ~/publik-api-research/CONTRACT.md (v1, 2026-09-18) and memos/R21 section 2. Copied verbatim.

## 1. Base URL, auth, envelopes, headers

- Base URL: `https://publikhq.com/api/v1`. It is **also a response field** (`base_url`) of `POST /installs` and apps honour the response over their compiled default. `api.publikhq.com` is not needed in v1. [S8]
- Auth on gateway calls: `Authorization: Bearer pk_live_…` or `x-api-key: pk_live_…`. Key format `pk_(live|test)_[a-z0-9]{12}_[a-z0-9]{32}`; only `sha256(secret)` is stored; the 12-char id is the public handle.
- Error envelope: `{"error":{"type":"…","message":"…", …extra}}`. On `/messages` wrap as `{"type":"error","error":{…}}` for every status, not only 400.
- Every response: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `x-publik-request-id`.
- Headers on every metered call (R21 §2.4): `x-publik-model` (served slug), `x-publik-balance` (available micros after admission), `x-publik-week-used`, `x-publik-week-budget` (micros or `none`), `x-publik-week-resets-at` (RFC 3339), `x-publik-claim-state` (`anonymous|claimed`), `x-publik-starter-remaining` (while > 0), `x-publik-reserved-micros` (streams: the hold), `x-publik-charge-micros` (non-stream only; streams settle after headers — apps reconcile via `GET /wallet`).
- Status codes: `401 invalid_api_key` (one answer for missing/malformed/unknown); `401 key_revoked` with `"reprovision": true|false` (true only from the idle sweep) [B2]; `402 insufficient_credit`; `402 model_requires_claim` (anonymous key asked for `publik-smart`); `429 rate_limit_exceeded | daily_cap_reached | week_budget_reached` with `Retry-After`; `400 unknown_model` naming the three tiers; `413` is Vercel's (body > 4.5 MB) — the contract page tells apps to keep requests under 4 MB and cue resizes screenshots to ≤ 1568 px JPEG q70 [B8]; `503 gateway_unavailable` (+ `Retry-After`) when Upstash or the DB is unreachable — fail closed.
- The 402 body (union of R21 §2.5 and the prototype) [B2]:
  ```json
  {"error":{"type":"insufficient_credit","message":"Not enough publik credit for this request.",
    "available_micros":1240,"required_micros":41000,"claim_state":"anonymous",
    "top_up_url":"<claim_url while anonymous, add_credit_url once claimed>",
    "claim_url":"https://publikhq.com/claim/HK7F-2QWD","add_credit_url":"https://publikhq.com/dashboard/api/add",
    "plans_url":"https://publikhq.com/developers#plans",
    "week":{"used_micros":248760,"budget_micros":null,"resets_at":"2026-09-25T17:04:11Z"}}}
  ```
  Apps render the message plus **exactly one** link: `top_up_url`.
- CORS [B7, S3]: no CORS on `/api/v1` by default. `publik_app_tokens.allowed_origins text[]` (null for desktop apps) drives it: a request whose `Origin` matches the presenting key's app-token allowlist gets `Access-Control-Allow-Origin: <origin>`, `Access-Control-Expose-Headers: x-publik-*`; `OPTIONS` preflights (no auth) are answered from the cached union of all active tokens' origins. Desktop apps whose renderer runs on a `http://127.0.0.1:<port>` origin (NitroAI) proxy through their own local server instead — the key never enters a renderer.
- Copy rule, enforced by `lib/publik-api/copy-guard.test.ts` [S7]: the strings `OpenAI API access`, `ChatGPT credits`, `credits` as a unit, and any per-token dollar figure are forbidden in `lib/publik-api/**`, `app/dashboard/api/**`, `app/developers/**`, `app/claim/**`, `lib/apps-config.ts`, `lib/guides/**`. Provider name is always **"publik API"**. Dollars, never tokens, never "credits".

---

### 3.1 Metered gateway (`app/api/v1/…/route.ts`, `runtime = "nodejs"`, `dynamic = "force-dynamic"`, `maxDuration = 300`)

| Route | Upstream | Method of metering |
|---|---|---|
| `POST /chat/completions` | passthrough to `https://api.openai.com/v1/chat/completions` with `model` rewritten to the served slug, `Authorization` swapped, `stream_options.include_usage=true` injected when streaming, `max_tokens/max_completion_tokens` defaulted from the alias when absent, `prompt_cache_key` = app slug | final chunk / body `usage` (`prompt_tokens`, `prompt_tokens_details.cached_tokens`, `completion_tokens`, `completion_tokens_details.reasoning_tokens`) |
| `POST /responses` | passthrough to `/v1/responses`, same rewrites, `store=false` forced, `prompt_cache_key` = app slug | `response.completed` event / body `usage` (`input_tokens`, `input_tokens_details.cached_tokens`, `input_tokens_details.cache_write_tokens`, `output_tokens`, `output_tokens_details.reasoning_tokens`) |
| `POST /messages` | translate Anthropic Messages → Responses with the prototype's `anthropic-to-responses.ts` (tested), then the `/responses` path; stream back Anthropic SSE events; server-side Anthropic tools → 400 | same as `/responses` |
| `POST /embeddings` | passthrough | `usage.prompt_tokens`, factor 1.0 |
| `POST /audio/transcriptions` | passthrough (multipart, ≤ 4.5 MB — document; NitroAI chunks client-side) | duration from the response (`duration` when `verbose_json`) else request audio length estimated by size; unit `audio_minute`, factor 1.0 |
| `POST /audio/speech` | passthrough | input characters, unit `character`, factor 1.0 |
| `POST /images/generations` | passthrough (`gpt-image-1`) | images × quality unit price, factor 1.0 |
| `GET /models` | local | — |

Serve pipeline for every metered route (`lib/publik-api/gateway/handle.ts`; R20 §1.4): resolve key (Redis cache 300 s / negative 30 s → Postgres) → per-key `limitHits` 60/min → daily cap → **reserve** (RPC, see §5) → forward upstream with a 15 s SSE-comment heartbeat until first byte → stream to the client while an independent reader consumes upstream to completion (bounded 300 s) → **settle** inside Next `after()` with the metered usage; client disconnect never cancels upstream and never skips settlement; `response.failed` / upstream 5xx settles as failure with zero charge and answers 502. Never set Vercel `supportsCancellation` on these routes.

Reserve estimate: `(estimated_input_tokens × in_price + default_max_output × out_price) × price_factor`; input estimated at `ceil(bytes/4)`; images/audio reserve one unit.

### 3.2 Provisioning (`app/api/v1/installs…`) [B1]

`POST /installs` — no auth (optional Supabase bearer binds the install to that user at mint). Accepts the app token **either** as `Authorization: Bearer pat_…` **or** as body `app_token`. Body (≤ 4 KB):

```json
{"app_token":"pat_cue_<32>","app_slug":"cue","app_version":"1.4.2",
 "os":"macos","os_version":"15.6","arch":"arm64","device_name":"Example MacBook Pro",
 "install_id":"<v4 uuid minted by the app>","disclosure_version":1,"dialects":["chat_completions"]}
```
Accept `platform` as an alias of `os` and `app` as an alias of `app_slug`; `device_name` optional; `disclosure_version` any integer ≥ 1 — the server **records** it and never rejects on it [S18]. Checks in order (R21 §2.1 table) with these limits [S5]: per-IP 5/h; per-IP-per-app **25/day**; per-token daily mint cap (default 500, alert at 60%); starter only if first mint for this `install_id` and `starter:ip:<ip>` < **5 per 30 days** and the token's daily starter cap (200) is not reached. Replay of an existing unrevoked `install_id` → `200` with `"key": null`, `"starter_micros": 0`, `"claim_state"`; an app that has no credential file on a 200 mints a fresh `install_id` once [B1]. Consent precedes mint: the app calls this only after the disclosure is accepted [S4].

`201` body: R21 §2.1 response **plus** `"balance_micros"` (= starter) and `"starting_credit_micros"` (same value, one release) so every app spec's field name resolves [B1]. `key` appears exactly once.

`GET /wallet` (key auth) — R21 §2.3 shape; `GET /balance` is an alias returning the same body plus `available_micros` (= `balance_micros`) and `top_up_url` [B2]. `week.budget_micros` is `null` without an entitled plan.

`GET /installs/claim?code=` and `POST /installs/claim` — R21 §2.2 (cookie session or bearer; one-answer `404 not_claimable`; merge via `publik_claim_install`). `POST /installs/revoke` — R21 §2.6.

## 5. Wallet semantics (the one sentence) [B3]

**A $P plan includes $P of metered usage per month, released as `P × 12/52` per fixed 7-day window anchored at wallet creation ($8 → $1.85, $20 → $4.62); unused window budget lapses at the window end; starter credit expires 30 days after grant; pack credit never lapses; spend order is plan window budget → starter → packs; `past_due` keeps the plan until `entitled_until` (period end + 3 days), then the wallet is `plan='none'`.** In v1 the window budget is soft: when it is spent, calls continue on starter/packs at the same rate; with none left, `402`. Per-key daily cap: anonymous $0.25; claimed `clamp(window_budget/2, $0.50, $2.00)` ($0.92 Basic, $2.00 Pro), pack-only $2.00, user-raisable on the dashboard up to the window budget, $10 hard ceiling. Anonymous keys cannot use `publik-smart` (`402 model_requires_claim`, `top_up_url` = claim link).

---

## 11. Amendments from the wave-2 app specs (2026-09-18, after the build started — the integrator applies these)

Cheap now, expensive as a later `alter`:
1. `publik_installs.os` and the `POST /installs` validator accept `macos | windows | linux | web | ios | android` (nutcracker, FreeHarmony, Lunara, Nut AI). `os_version`, `arch` nullable; `device_name` may be coarse ("Browser on macOS", "iPhone").
2. `dialects` values: `chat_completions | responses | messages | embeddings | audio | images | gemini | fal_queue`; unknown values are stored, never rejected.
3. Every 401/402/403/429 from the gateway also carries `x-should-retry: false` (the Anthropic SDK obeys it; otherwise it retries 429s twice — R23-freeharmony).
4. `claim_url` / `add_credit_url` / `plans_url` are always on `https://publikhq.com/…`; apps drop any other host.
5. `publik_app_tokens` gains `daily_cap_micros_default bigint null` (per-app override of the claimed-key daily cap; Hickeyfield's video jobs exceed the $2 default) and `starter_micros_override bigint null` (a source-built app's committed public token gets a lower starter).
6. Non-streaming responses carry `x-publik-charge-micros` and `x-publik-balance` after settlement (Lunara, Nut AI, nutcracker read them); streaming responses carry the reservation only (unchanged).
7. `POST /installs` accepts `app_token` in the body with no `Authorization` header (browser callers) — already in §3.2; restated because two specs assumed the opposite.

Wave 2 gateway lines (NOT in this build; each needs a founder account and a decision first): Gemini `generateContent` alias-only passthrough (`/api/v1/gemini/v1beta/models/<alias>:generateContent`, Google paid tier, R26 D35); fal queue passthrough with rewritten job URLs (`/api/v1/fal/...`, fal account, counsel read of fal ToS §4(b)(ii) — R28 F2); Anthropic Messages passthrough for `claude-*` names on the existing project key (FreeHarmony wants real Claude vision; also carries an Anthropic usage-policy question, R23-freeharmony FH-1); Responses `web_search` tool metering (Nut AI); vision capability of `gpt-5.6-luna` must be verified live before Nut AI defaults to `publik-fast` for photo scans.

---

## 12. In-app CTA and justification (founder, 2026-09-19)

The subscription CTA has to appear where someone has just set up publik API — inside the app, right after provisioning — and every mention of money has to say why it costs money. Applies to every app that ships publik API as its default (§0), Iris included when it gets there.

1. **First-run card, immediately after `POST /installs` succeeds.** The app's publik card shows, in this order: (a) the **balance line** — "$0.25 of free starter usage" from `starter_micros` / `balance_micros`, then live from `x-publik-balance`; (b) the **one-sentence justification**, verbatim from `disclosure.cost` or from the site's `whyItCostsSentence` (lib/publik-api/why-it-costs.ts): *the AI model behind the app is run by a provider that charges per use; publik passes that on at half the provider's list price, nothing is charged behind your back, and every call is visible on the dashboard*; (c) a **primary button "Link this computer & pick a plan"** that opens `claim_url`. The site's `/claim/<code>` page finishes the job: after Confirm it is the plan chooser (Basic $8 / Pro $20, one click to Stripe, a pack link, and "Not now — keep the free starter").
2. **The same button in the settings card**, for as long as `claim_state` is `anonymous`. Once `claimed`, the button becomes "Add a plan or pack" and opens `add_credit_url`.
3. **The 402 always leads to `top_up_url`.** The `insufficient_credit` message now carries the justification and says in words what the link does ("Link this computer and pick a plan at the link below" while anonymous, "Add a plan or a pack at the link below" once claimed). Apps render the message plus exactly one link, `top_up_url`, as §1 already says — and then keep working with the user's own key where one is set.
4. **Never a silent starter.** An app must not consume the starter without having shown (a)–(c) at least once. The disclosure sheet before `POST /installs` (§3.2 [S4]) is not that card: the card comes after provisioning, with the real balance on it.
5. **Copy rule holds** (§1): "publik API", dollars, never tokens, never "credits" as a unit, never the provider's name in the justification.

Site side, shipped 2026-09-19 (branch `api/cta`): `/claim/<code>` post-confirm plan chooser; `/dashboard/api` leads with the chooser while there is no plan and no pack; `components/api/WhyItCosts` under every price, expanded at `/developers#why`; a first-class **API** nav item; the dashboard opens with an API usage card.


---

### 2.1 `POST /api/v1/installs` — mint an anonymous install key

**Auth:** none. Optional `Authorization: Bearer <Supabase access token>` binds the install to that user at mint (no cohort app has a sign-in today; the door is left open and `getBearerUser` already exists, `~/publik/lib/supabase/bearer.ts:9-25`).

**Request** (JSON, ≤ 4 KB):

```json
{
  "app_token": "pat_cue_k3m9x2q7v5n8r4t6w1y0z2b5c8d1f4g7",
  "app_slug": "cue",
  "app_version": "1.4.2",
  "os": "macos",
  "os_version": "15.6",
  "arch": "arm64",
  "device_name": "Example MacBook Pro",
  "install_id": "3f1c9b5e-7a2d-4c8e-9f0b-1d2e3f4a5b6c",
  "disclosure_version": 2,
  "dialects": ["chat_completions"]
}
```

Rules, in evaluation order (each is a separate early return with its own error type, house style of `sessions/route.ts`):

| # | Check | Failure |
|---|---|---|
| 0 | `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and the Upstash pair present | `503 installs_unavailable` |
| 1 | per-IP window `limitHits({key:"installs:ip:"+ip, limit:5, windowSeconds:3600, failClosed:true})` — the same 5/h as guide sessions | `429 rate_limited` + `Retry-After` |
| 2 | body parses; `app_token` matches `^pat_([a-z0-9]+(?:[a-z0-9-]{0,62}[a-z0-9])?)_([a-z0-9]{32})$`; `app_slug` equals the token's slug segment; `app_version` 1–32 chars and `device_name` 1–120 chars (the `desktop_devices` checks, `0006_desktop_devices.sql:9-13`); `os ∈ {macos,windows,linux}`; `install_id` is a v4 UUID; `disclosure_version ≥ 2` | `400 invalid_field` with `"field":"…"` |
| 3 | `publik_app_tokens` row for the slug exists, `sha256(secret)` matches in constant time, `revoked_at is null`; the app's `apps.suspended_at is null` (0010) | `401 invalid_app_token` (one answer for unknown / wrong / revoked); `403 app_suspended` |
| 4 | per-IP-per-app `installs:ip:<ip>:<slug>` 2/day (again the sessions precedent) | `429 rate_limited` |
| 5 | per-token daily mint cap `installs:token:<slug>` = `publik_app_tokens.daily_mint_cap` (default 500); an alert fires at 60% | `429 mint_cap_reached` + `Retry-After` to UTC midnight |
| 6 | replay: an unrevoked `publik_installs` row with this `install_id` and this app already exists | `200` with the current install (see below), **no new key, no new starter** |
| 7 | mint via one security-definer RPC `publik_mint_install(...)` (the `iris_create_guide_session` pattern: random secret generated in SQL, only the digest stored, service-role only — `0003_iris_guides.sql:69-83`) which inserts the install, the key (`publik_api_keys`, R09 §5 shape), the anonymous ledger account `anon:<install_id>` (`kind='user_credit'`, `owner_id=install_id`), and posts the starter grant if eligible | `500 mint_failed` |

**Starter eligibility inside step 7:** `starter_micros = 250_000` ($0.25, §3.2) only if all hold: first mint for this `install_id`; `starter:ip:<ip>` has fewer than 1 grant in 30 days (Redis, `limitHits` with `windowSeconds: 2_592_000`); the app token's `starter_grants:<slug>` daily count is under `daily_starter_cap` (default 200). Otherwise `starter_micros = 0` and the key still mints — the install works the moment the user claims it or adds credit. The response does not say *why* starter was 0.

**Response `201 Created`:**

```json
{
  "install_id": "3f1c9b5e-7a2d-4c8e-9f0b-1d2e3f4a5b6c",
  "key": "pk_live_a8k2m9x4q7v1_h3n6r9t2w5y8z1b4c7d0f3g6j9k2m5p8",
  "key_id": "a8k2m9x4q7v1",
  "base_url": "https://publikhq.com/api/v1",
  "models": { "fast": "publik-fast", "balanced": "publik-balanced", "smart": "publik-smart" },
  "dialects": ["chat_completions", "responses", "messages"],
  "claim_code": "HK7F-2QWD",
  "claim_url": "https://publikhq.com/claim/HK7F-2QWD",
  "claim_expires_at": "2026-10-18T17:04:11Z",
  "starter_micros": 250000,
  "wallet": { "...": "identical to GET /api/v1/wallet, §2.3" },
  "disclosure": {
    "version": 2,
    "cost": "cue runs on publik API by default. Every request is priced per use at 50% of the model's published list price, from your publik balance. Most people spend under $2 a month.",
    "data_path": "Your prompts go through publik's servers to a shared model account. publik never trains on them and does not store them. You can switch to your own key at any time."
  }
}
```

`key` appears exactly once (`keys.ts:93` "Returns the plaintext exactly once"). The app **writes the credential file before anything else**, then acks nothing — there is no ack. `Idempotency-Key` is not needed: `install_id` is the idempotency key.

**Response `200 OK` on replay (step 6):** the same body with `"key": null`, `"starter_micros": 0`, plus `"claim_state": "anonymous" | "claimed"`. If the app finds itself here with no credential file (crash between mint and write), it mints a fresh `install_id` and retries once; the orphaned key idles into the sweep (§3.5) and the second mint gets no starter because the per-IP starter window already fired. Starter is spent by the crash, not farmed.

**The app-side contract**, written once for all four apps, is the convention's resolution order (`PLAN-default-in-all-apps.md` §2, unchanged): a user-entered key always wins; then `PUBLIK_API_KEY`; then `<slug>.json`; then the app's own provider list. `POST /installs` runs only when steps 1–3 all resolve empty, on first launch, after the disclosure sheet (§4.3) has been accepted. The file gains three fields over the plan's example: `install_id`, `claim_code`, `claim_url`.

### 2.2 `GET /api/v1/installs/claim?code=…` and `POST /api/v1/installs/claim` — adopt an install

**Auth:** the signed-in publik user — Supabase cookie session on the web (`createSupabaseServer`, as `/api/claim/[slug]/route.ts:24-30`) or a bearer. `401 auth_required` otherwise; the page at `/claim/<code>` sends the visitor through the existing sign-in and returns to the same URL (the 0022 callback already carries claim intent through sign-in for attributed listings; carrying `?code` the same way is the one web change — **not verified against the callback code this pass**, see Skeptic).

**GET** returns the RFC 8628 §5.4 preview so the user confirms possession before anything moves:

```json
{ "app": { "slug": "cue", "name": "cue" }, "os": "macos", "device_name": "Example MacBook Pro",
  "minted_at": "2026-09-18T17:04:11Z", "last_seen_at": "2026-09-18T17:31:02Z",
  "starter_remaining_micros": 181240, "spent_micros": 68760 }
```

**POST** body `{"claim_code":"HK7F-2QWD","confirm":true}`. Rules:

| # | Check | Failure |
|---|---|---|
| 1 | per-user `claim:user:<uid>` 10/h and per-IP `claim:ip:<ip>` 20/h (GitHub allows 50/h per application; publik's code space is bigger, §3.4, so the rate can be lower) | `429 rate_limited` |
| 2 | code parses `^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$` (no 0/O/1/I; 32 symbols) | `400 invalid_field` |
| 3 | `sha256(code)` matches a `publik_installs` row with `claimed_at is null`, `revoked_at is null`, `claim_code_expires_at > now()` | `404 not_claimable` — **one answer** for unknown, expired, already-claimed and revoked, the `/api/claim/[slug]` rule (`:55-61`) |
| 4 | run the merge RPC `publik_claim_install(p_install_id, p_user_id)` (§5) atomically | `500 claim_failed` |

**Response `200`:**

```json
{ "claimed": true, "install_id": "…", "app_slug": "cue",
  "merge": { "starter_moved_micros": 181240, "starter_forfeited_micros": 0, "claim_bonus_micros": 750000, "keys_rebound": 1 },
  "wallet": { "...": "the account wallet after the merge, §2.3 shape" } }
```

The app learns it was claimed on its next call: `x-publik-claim-state: claimed` and the wallet's `claim_state`. No push, no restart, same key.

### 2.3 `GET /api/v1/wallet` — what the app shows in its balance line

**Auth:** `Authorization: Bearer pk_live_…` (also `x-api-key`, `app.ts:62-63`). Replaces the prototype's `GET /v1/balance` (`app.ts:75-79`), whose three fields are kept.

```json
{
  "install_id": "3f1c9b5e-…",
  "app_slug": "cue",
  "claim_state": "anonymous",
  "balance_micros": 181240,
  "starter": { "remaining_micros": 181240, "expires_at": "2026-10-18T17:04:11Z" },
  "plan": { "id": "none", "label": "No plan", "monthly_micros": 0 },
  "week": { "used_micros": 68760, "budget_micros": null, "resets_at": "2026-09-25T17:04:11Z", "window_days": 7 },
  "daily_cap_micros": 250000,
  "spent_today_micros": 68760,
  "claim_code": "HK7F-2QWD",
  "claim_url": "https://publikhq.com/claim/HK7F-2QWD",
  "add_credit_url": "https://publikhq.com/wallet/add?install=3f1c9b5e-…",
  "plans_url": "https://publikhq.com/api/plans",
  "price_epoch": "2026-09-08"
}
```

Field semantics:

- `balance_micros` = posted balance − open reservations, the ledger's `available()` (`ledger.ts:94-96`). Never Stripe (PRD §1.3).
- `week.budget_micros`: `null` for a wallet with no plan (the bar then shows balance, Ollama-style). With a plan, `round(monthly_micros × 7 / 30.4375)`: $8 → **$1.84/week**, $20 → **$4.60/week**. `week.resets_at` is a rolling 7-day anchor set at plan start (Claude/Codex precedent: rolling, with the reset time shown), re-anchored on plan change.
- `week.used_micros` = `sum(charge_micros)` over `publik_usage_events` for this wallet since `resets_at − 7d`. Per-app split comes from the same rows' `app_id` and is what the dashboard's per-app bars read.
- `claim_code` / `claim_url` are re-issued here if the previous code expired (30-day TTL), so a long-idle install can still be claimed from its settings panel. Both are `null` once claimed.
- `daily_cap_micros` is $0.25 while anonymous and the account's cap (D26 default $2) after claim.

### 2.4 Headers on every gateway call

Added to the prototype's existing set (`x-publik-request-id`, `x-publik-model`, `x-publik-charge-micros`, `x-publik-balance-micros`, `app.ts:226, 247`):

| Header | Value | Note |
|---|---|---|
| `x-publik-balance` | integer micros, available after this call | the task's name; keep `x-publik-balance-micros` as an alias for one release, then drop |
| `x-publik-week-used` | integer micros | on streaming responses this is the value **at admission plus the reservation** (headers are sent before settlement; `x-publik-reserved-micros` already documents this, `app.ts:226`); the app reconciles from `GET /wallet` |
| `x-publik-week-budget` | integer micros or `none` | |
| `x-publik-week-resets-at` | RFC 3339 UTC | |
| `x-publik-claim-state` | `anonymous` \| `claimed` | the cheapest way for an app to notice a claim |
| `x-publik-starter-remaining` | integer micros | present only while starter > 0 |

`Access-Control-Expose-Headers` lists all of them.

### 2.5 The 402 and 429 shapes

**`402 insufficient_credit`** — extends the prototype (`app.ts:101-106`):

```json
{ "error": { "type": "insufficient_credit",
  "message": "Not enough publik credit for this request.",
  "available_micros": 1240, "required_micros": 41000,
  "claim_state": "anonymous",
  "claim_url": "https://publikhq.com/claim/HK7F-2QWD",
  "add_credit_url": "https://publikhq.com/wallet/add?install=…",
  "plans_url": "https://publikhq.com/api/plans",
  "week": { "used_micros": 248760, "budget_micros": null, "resets_at": "…" } } }
```

For an anonymous install the actionable link is `claim_url` (you cannot add credit to a wallet nobody owns); once claimed it is `add_credit_url`. Apps render the message plus exactly one link, chosen by `claim_state`.

**`429`** — three types, all with `Retry-After` in seconds:

| type | when | `Retry-After` | extra |
|---|---|---|---|
| `rate_limit_exceeded` | per-key 60/min (`limitHits`, PRD §3.2) or an upstream 429 (`app.ts:158-159`) | window remainder or upstream's | — |
| `daily_cap_reached` | `spent_today ≥ daily_cap` (`app.ts:94-96`) | seconds to 00:00 UTC (the prototype's fixed 3600 is wrong after 23:00) | `spent_today_micros`, `daily_cap_micros`, `claim_url` when anonymous |
| `week_budget_reached` | only if decision 2 (§6) makes the weekly budget hard | seconds to `week.resets_at` | `week{…}`, `add_credit_url` |

**`401 invalid_api_key`** stays one answer for missing / malformed / unknown. **`403 key_revoked`** is new and distinct, with `"reprovision": true|false`: `true` only when the revocation came from the idle sweep (§3.5) — the app may silently re-run `POST /installs` with its existing `install_id`; `false` when the user revoked from the dashboard or an uninstaller hook — the app flips to "publik API is disconnected" and does not re-mint on its own.

### 2.6 `POST /api/v1/installs/revoke` — self-revoke

**Auth:** the install's own `pk_` key. Body empty. `204`, idempotent (`keys.ts:118-120` uses `coalesce(revoked_at, now)`). Used by the settings panel's "Disconnect publik API" and by the Windows uninstaller hooks (§3.5). Also `POST /api/v1/installs/revoke` with a Supabase session and `{"install_id"}` for the dashboard's device list, mirroring `desktop_devices`.

