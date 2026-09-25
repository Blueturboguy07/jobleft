# @jobleft/ai-engine

The AI engine of jobleft. It does these things:

- It sends AI requests to ONE provider that the person chooses: the publik API, a model server on this computer (Ollama, llama.cpp, MLX, LM Studio or any OpenAI-style server on 127.0.0.1), a custom OpenAI-style address, or the person's own key for OpenAI, Anthropic, OpenRouter or Google.
- It tests a provider when the person saves it, and names the real problem in plain words.
- It connects publik without a typed key, shows the publik balance in dollars, and gives one top-up link when the balance is too low.
- It keeps keys in the macOS Keychain (or in an encrypted 0600 file). It never shows more than the last 4 characters of a key.
- It reads structured answers from small models, and it refuses a bad answer. It never invents a value.

There is no sign-in with a Claude consumer subscription. The engine never moves a request to another provider by itself, and it never tries a failed request again by itself.

The app screens do not exist yet. Until they do, the command line tool `jobleft-ai` (this package's `src/cli.ts`) is the front end of this package. Two stand-in servers come with it: a publik stand-in and a model stand-in. No step below uses the live publik service or real money.

## 1. What you need

- Node 24 or newer, and pnpm. From the repository root, run `pnpm install` once.
- macOS for the Keychain. On other systems, or to keep the Keychain clean, set `JOBLEFT_SECRET_STORE=file`.
- Optional: a real local model server, for example Ollama with a 7B to 14B instruction model.

All commands below run from the repository root.

## 2. Set up a test shell

Run this in each terminal that you use:

```sh
export JOBLEFT_HOME=/private/tmp/jl-ai-demo            # the data folder (created if missing)
export JOBLEFT_SECRET_STORE=file                         # keys in $JOBLEFT_HOME/secrets (encrypted). Omit it to use the macOS Keychain
export JOBLEFT_PUBLIK_BASE_URL=http://127.0.0.1:4020/api/v1
export JOBLEFT_PUBLIK_APP_TOKEN=pat_jobleft_devstandin0000000000000000000000
alias jl='node packages/ai-engine/src/cli.ts'
```

`jl help` lists every command.

This build never contacts the live publik service. With a publik address that is not on 127.0.0.1, `publik connect` answers "Connecting to publik is not available in this build yet (it has no publik app token)" and sends nothing.

## 3. Start the stand-ins

Terminal 1, the model stand-in (it speaks the OpenAI, Ollama and Anthropic dialects):

```sh
node packages/ai-engine/src/cli.ts mock-model --port 4030 --log /private/tmp/jl-ai-demo-model.log
```

Terminal 2, the publik stand-in ($5.00 balance, $0.01 for each metered call):

```sh
node packages/ai-engine/src/cli.ts mock-publik --port 4020 --balance 5.00 --price 0.01 --log /private/tmp/jl-ai-demo-publik.log
```

Each stand-in logs every request with all its headers, to the `--log` file and at `GET /__admin/log`.

### 3.1 Model stand-in: modes

Change the mode while it runs:

```sh
curl -s -X POST http://127.0.0.1:4030/__admin/mode -H 'content-type: application/json' -d '{"mode":"stall"}'
```

| Mode | What it does |
|---|---|
| `ok` | Answers normally: "ready" to the setup test, a value that fits the schema to a structured request, else a fixed sentence |
| `slow` | Answers normally, one small piece every `slowMs` (set it with `{"mode":"slow","slowMs":500}`; default 1000) |
| `stall` | Accepts the connection and never sends anything |
| `stall-after-headers` | Sends the headers of a stream, then nothing |
| `half` | Streams half of the answer, then drops the connection |
| `refuse-key` | Answers 401 to every AI request, and echoes the key it got in the error text (to catch leaks) |
| `model-not-found` | Lists its models, but answers 404 "model does not exist" to every chat |
| `html` | Answers every request with a web page (200, text/html) |
| `broken` | Streams one good piece, then text that is not JSON |
| `empty` | Streams a complete answer with no text |
| `cutoff` | Streams half of the answer and says that it hit the length limit |
| `text` | Answers plain text, also when JSON is asked for |
| `badscore` | Answers JSON with 140 in every number (out of range) |
| `think` | Starts the answer with an inline `<think>...</think>` block |
| `think-only` | Sends only thinking text and no answer |
| `error500` | Answers 500 to every AI request |

Other options: `--key K` (every AI request must carry this key), `--models a,b` (the models it has; default `standin-7b`, `standin-think-8b`, `standin-embed`), `--thinking-models a` (Ollama models that can think; an Ollama `think` option sent to any other model gets a 400, like real Ollama). `{"key":"..."}` in the mode body changes the required key while it runs. It refuses `/api/pull` (and logs it), so a test can prove that jobleft never downloads a model.

### 3.2 publik stand-in: admin

| Request | Effect |
|---|---|
| `POST /__admin/balance {"usd":0}` | Set the balance |
| `POST /__admin/add {"usd":5}` | Add money |
| `POST /__admin/price {"usd":0.01}` | Price of one metered call |
| `POST /__admin/claim {"claimed":true}` | Link the install to an account (anonymous is the default) |
| `POST /__admin/mode {"mode":"ok"}` | `ok`, `stall` (stream headers, then nothing), `half`, `unavailable` (503), `revoked` (403 key_revoked) |
| `POST /__admin/revoke-all` | Revoke every key (as a dashboard would) |
| `GET /__admin/state`, `GET /__admin/log` | Balance, charges, keys; the request log |

Admin requests go to `http://127.0.0.1:4020/__admin/...` with `-H 'content-type: application/json'`. It serves `POST /installs`, `GET /wallet`, `GET /balance`, `POST /installs/revoke`, `GET /models`, `POST /chat/completions`, `POST /embeddings`, `POST /fetch` and `POST /search` under `/api/v1`, from the publik build contract (sections 1, 3.2 and 12). It charges once for each admitted metered call, when it admits the call. A call that it refuses (402, 401, 403, 503) costs nothing.

## 4. A walk through each provider type

### 4.1 A custom address

```sh
jl use custom --url 127.0.0.1:4030
```

You see: `Setup check: problem (other). Choose a model. This server has: standin-7b, standin-think-8b, standin-embed.`

```sh
jl use custom --url http://127.0.0.1:4030 --model standin-7b
jl chat "Reply with the word ready"
```

You see the active provider in brackets, the answer, and `[done]`:

```
[the AI server at http://127.0.0.1:4030 (standin-7b)]
ready
[done]
```

The address works with or without `/v1`, with or without a trailing slash, and with or without `http://`. A key is optional:

```sh
printf '%s' 'sk-canary-7Q4Z-jobleft-test' | jl key set     # reads the key from stdin; in a terminal it asks without echo
jl status                                                  # Key: saved, ends in "test"
```

### 4.2 A model server on this computer

```sh
jl detect                                                  # finds Ollama (11434), LM Studio (1234), llama.cpp (8080)
jl use local --kind ollama --model qwen2.5:7b              # native Ollama API; default address http://127.0.0.1:11434
jl use local --kind llamacpp --url http://127.0.0.1:8080   # llama.cpp, MLX, LM Studio: OpenAI-style
jl use local --kind openai_compatible --url http://127.0.0.1:4030 --model standin-7b
```

The model stand-in also plays Ollama: `jl use local --kind ollama --url http://127.0.0.1:4030 --model standin-7b`.

A local provider must be on this computer. `jl use local --url http://192.168.1.20:8080` is refused: "A local provider must run on this computer (127.0.0.1 or localhost). For a server elsewhere, choose "custom address"."

Ollama rules: the model list is the installed models (`/api/tags`). jobleft never pulls a model. It sends the `think` option only to models whose `/api/show` capabilities include "thinking" (`false`, or `"low"` for gpt-oss, which cannot turn thinking off). The thinking text is never shown. An embedding-only model is refused as a chat model, with a plain message.

### 4.3 Your own key

The key goes only to the vendor's own address (api.openai.com, api.anthropic.com, openrouter.ai, generativelanguage.googleapis.com). For a test, point the vendor host at a stand-in on 127.0.0.1 (loopback targets only):

```sh
export JOBLEFT_AI_HOST_MAP='{"api.openai.com":"http://127.0.0.1:4030","api.anthropic.com":"http://127.0.0.1:4030"}'
jl use own-key --vendor anthropic --model standin-7b
printf '%s' 'sk-canary-7Q4Z-jobleft-test' | jl key set
jl check
jl chat "Reply with the word ready"
```

Anthropic gets the key in the `x-api-key` header. OpenAI, OpenRouter and Google get it as `Authorization: Bearer`. A key saved for one vendor is not the key of another vendor.

### 4.4 The publik API

```sh
jl publik connect
```

You see the two-sentence disclosure and a question. Type `yes` (or add `--yes`). No field asks for a key:

```
publik is connected. No key was typed, pasted or shown; it is in the secret store.
Balance: $5.00
Why it costs money: The AI model behind publik charges per use; ...
Link this computer & pick a plan: https://publikhq.com/claim/XXXX-XXXX
```

```sh
jl use publik                        # Setup check: Works: publik is connected. Balance: $5.00. Model: publik-balanced.
jl chat "Reply with the word ready"  # ... [done]  then  publik balance: $4.99
jl status                            # publik: connected. Balance: $4.99 (read <time>)
jl publik disconnect                 # the key is revoked at publik and deleted here
```

Tiers: `publik-fast`, `publik-balanced` (default) and `publik-smart` (`jl use publik --model publik-smart`). publik-smart needs a linked account; while the install is anonymous the check says so and gives the one link to link this computer. The setup check for publik spends nothing: it reads `/wallet` and `/models`.

### 4.5 No provider

`jl use none`. Every AI action then says: "No AI provider is set up. jobleft works without one; set one up in Settings > AI to use this feature." Nothing is sent anywhere.

## 5. How to check each outcome

The outcomes are in `docs/outcomes/ai-engine.md`. "jl" is the alias from section 2.

| Outcome | How to see it with this package |
|---|---|
| O1 Chat works through every type | Sections 4.1 to 4.4. Each chat prints the active provider and model in brackets. The choice is saved in `$JOBLEFT_HOME/ai/state.json`; each `jl` command is a new process, so every command after the first is "after a restart". `jl providers` lists the options: there is no Claude subscription sign-in |
| O2 publik connects with no key typed; disconnect stops spending | `jl publik connect`, `jl use publik`, `jl chat ...`, then `jl publik disconnect`. After that, `jl chat` and `jl json` answer "publik is not connected" and the publik stand-in log shows no new request. `grep -r pk_test_ "$JOBLEFT_HOME"` finds nothing. With the Keychain store: `security find-generic-password -a jobleft.publik.key -s <service>` finds nothing (service: see section 6) |
| O3 The setup check names the real problem | `jl check` after each change: stop the stand-in (unreachable), `--key` or mode `refuse-key` (key refused), mode `model-not-found` (model does not exist), mode `html` (not an AI server), publik balance 0 (balance too low, with the one link). Each message is different and each check ends within 60 s |
| O4 Every request ends; cancel works | Stopped server: a plain message at once (a host that does not answer: within 10 s). Mode `stall` or `stall-after-headers`: a plain message after 110 s of silence. Mode `slow`, then Ctrl-C during `jl chat`: it stops in well under 2 s, prints `[cancelled: the part above is incomplete]`, and the stand-in log shows "client closed the connection". Mode `half`: the partial answer stays, then `[incomplete: ...]` |
| O5 Useful with no provider | `jl use none`, then `jl chat hi`: a plain "No AI provider is set up" message. The other features are in other packages |
| O6 Out of money: one message, one link, nothing lost | `curl -s -X POST http://127.0.0.1:4020/__admin/balance -H 'content-type: application/json' -d '{"usd":0}'`, then `jl chat "my question"` and `jl json "..."`. You see "Your publik balance ran out ($0.00 left). Link this computer and pick a plan at the link below, then send your message again." and exactly one `Add money:` link. The message is kept in `$JOBLEFT_HOME/ai/unsent.json` with `"status":"not sent"`. The stand-in log has one request per action. Add $5 with `/__admin/add`, then `jl chat --resend` works with no restart |
| O7 Balance in dollars, correct, fresh | Balance $5.00, three `jl chat` runs at $0.01, then `jl status`: `$4.97`. The balance is read again after every paid call and on every `jl status`. Dollars are floored to the cent, and a positive balance under a cent shows as `<$0.01` |
| O8 A saved key is never shown, logged or in plain text | `printf '%s' sk-canary-7Q4Z-jobleft-test \| jl key set`, mode `refuse-key` (it echoes the key), `jl chat hi`, `jl check`: no output shows more than `test`. `grep -r canary "$JOBLEFT_HOME"` finds nothing: the key is in the Keychain, or AES-256-GCM encrypted in `$JOBLEFT_HOME/secrets/secrets.enc` (0600). The engine writes no log files |
| O9 A key goes only to its own provider | Run two model stand-ins (one with `--key sk-canary-...`) and the publik stand-in. Save the key for the first, chat, then `jl use custom --url <second>` and chat. The canary is only in the first stand-in's log, only in the `authorization` header, never in a path. A changed address starts with no key (`Key: none saved`) |
| O10 No provider switch by itself | Choose a local or custom provider and stop it. `jl chat` and `jl json` report "Nothing answers at ..."; the publik stand-in and any other stand-in log no request |
| O11 Local means nothing leaves | A local provider must be on 127.0.0.1 or localhost. With `JOBLEFT_OFFLINE=1`, only loopback providers work; others answer "jobleft is in offline mode". The engine has no telemetry, no crash reporter and no model download for chat |
| O12 A bad answer is refused | Modes `empty`, `cutoff`, `text`, `badscore`, then `jl json "Jordan Testwell, SQL analyst. Job: data analyst with SQL and Tableau."`. Each prints `Cannot use this answer: ...` and `Try again: ...`. No number is filled in. In `jl chat`, a cut-off answer ends with `[incomplete: ...]` |
| O13 Small local models | `jl use local --kind ollama --model qwen2.5:7b`, then `jl json "<resume and job text>"` five times. Structured requests send the schema as Ollama `format` (or `response_format` on OpenAI-style servers); a plain-text answer is read by the line fallback when it can be, and refused when it cannot. A long text gets a larger Ollama context (`num_ctx`), and a text that cannot fit the model is refused in plain words before anything is sent, so Ollama never cuts it silently. Mode `think` shows only the answer; mode `think-only` says that the model spent its answer on thinking. Measured on 2026-09-25 with Ollama `qwen2.5:7b` on this Mac: 5 of 5 fit answers usable (scores 70 to 78, reasons name the missing Tableau and years) |
| O14 A web page cannot use the local API | `jl serve` prints an address and a launch token (routes: section 8). Requests with no token, a guessed token, a token in the URL, a foreign or `null` Origin, a changed Host header, or a form post (`text/plain`, form types) are refused (401, 403 or 415) before any work. There is no CORS header. (The real app server mounts the same route handlers behind the same rules) |
| O15 Paid fetch and search are off until turned on | `jl metered status` shows `off` and the prices per 1,000 requests (search $5.00, page $2.00, page that needs JavaScript $4.00). Connecting publik does not turn it on. `jl metered on` shows the prices first and asks. The fetch client itself belongs to `@jobleft/sources-other` |

## 6. Where things are stored

| What | Where |
|---|---|
| Provider choice, model, the last 4 characters of each key, the publik install id, links and the last balance read | `$JOBLEFT_HOME/ai/state.json` (mode 0600). Never a key |
| A message that was not sent | `$JOBLEFT_HOME/ai/unsent.json` (0600), until it is sent |
| Keys (default on macOS) | The macOS Keychain, through `/usr/bin/security`. The key goes to `security` on stdin, never in the argument list. Service `jobleft` for the default data folder, `jobleft-<hash>` for any other folder (`jl status` prints it). Account: `jobleft.publik.key`, or `jobleft.ai.<slot>.key` |
| Keys with `JOBLEFT_SECRET_STORE=file` | `$JOBLEFT_HOME/secrets/secrets.enc` (AES-256-GCM, 0600) and `$JOBLEFT_HOME/secrets/master.key` (0600), folder 0700. This stops plain-text search and accidental copies. It cannot stop a program that runs as the same user and reads both files. Backups and exports must leave this folder out |
| Logs | None. The engine writes no log file. The stand-ins write their own logs only where `--log` says |

A key belongs to one provider address (its "slot"): `own_key.<vendor>`, or `custom@<hash>` and `local@<hash>` for the origin of an address. `jl key forget` deletes the key of the current provider. `jl secrets forget-all` deletes every key this data folder saved and disconnects publik.

To clean up after a test: `jl secrets forget-all`, then `rm -rf "$JOBLEFT_HOME"`.

## 7. Limits and timings

| Limit | Value |
|---|---|
| Connect | 10 s for the TCP (and TLS) connection |
| Silence | 110 s with no byte, before or after the headers. So a silent provider always ends inside 2 minutes |
| Setup check | Ends within 55 s. It sends a real chat test ("Reply with the word ready") and stops at the first word, except for publik (no paid request) |
| Retries | None. One exception: a server that refuses the JSON-mode option with a 400 gets the same request once more without it (nothing was generated or charged) |
| Cancel | Closes the connection at once; the provider sees the request stop |

## 8. Use it from code

```ts
import { createEngineFromEnv, AiError, toApiError, createAiRouteHandlers } from '@jobleft/ai-engine';
const { engine } = createEngineFromEnv();              // or new AiEngine({ settings, secrets, state, publikBaseUrl, publikAppToken })
const ai = engine.client();                            // throws AiError('no_provider') when none is chosen
for await (const c of ai.chat({ messages: [{ role: 'user', content: 'hi' }], requestId: 'r1' })) { /* delta | done */ }
const fit = await ai.json({ schema: SomeContractSchema, messages, lineFallback });   // AiError('bad_answer') when unusable
engine.cancel('r1');
```

Tool calls: pass `tools: [{ name, description, parameters }]` in the request. The stream then gives `{ type: 'tool_call', call: { id, name, arguments, rawArguments } }`, and `complete()` gives `toolCalls`. Send the result back as `{ role: 'tool', toolCallId, name, content }` after `{ role: 'assistant', content, toolCalls }`. This works the same for OpenAI-style servers, Ollama and Anthropic. Without `tools`, no tool call ever appears.

Embeddings from the chosen provider: `ai.embed(texts, { model: 'nomic-embed-text' })` (OpenAI-style `/embeddings`, Ollama `/api/embed`, publik `/embeddings`; Anthropic has none and says so). The free local fit model is `createLocalEmbedder({ modelDir })` (bge-small-en-v1.5, 384 dimensions); see section 10.

`apps/server` mounts `createAiRouteHandlers(engine)` for the routes this lane owns and passes its `SettingsStore` as `state`. The full list of exports is in `docs/INTERFACES.md`, section `@jobleft/ai-engine`.

`jl serve` serves these routes on 127.0.0.1 with the app's security rules, for probing this package alone: `GET /api/v1/health`, `GET|PUT /api/v1/ai/settings`, `PUT|DELETE /api/v1/ai/key`, `POST /api/v1/ai/check`, `GET /api/v1/ai/models`, `POST /api/v1/ai/chat` (server-sent events: `start`, `delta`, then one `done` or `error`), `POST /api/v1/ai/requests/:requestId/cancel`, `GET /api/v1/publik`, `POST /api/v1/publik/connect` (`{"disclosureAccepted":true,"disclosureVersion":1}`), `POST /api/v1/publik/disconnect`, `POST /api/v1/publik/refresh`. Send the token in the `x-jobleft-token` header and JSON bodies with `content-type: application/json`. Example:

```sh
curl -s -N -X POST http://127.0.0.1:<port>/api/v1/ai/chat -H "x-jobleft-token: <token>" -H 'content-type: application/json' \
  -d '{"requestId":"r1","messages":[{"role":"user","content":"Reply with the word ready"}]}'
```

## 9. Tests

```sh
pnpm --filter @jobleft/ai-engine test        # about 38 tests, about 3 s; loopback stand-ins only
pnpm --filter @jobleft/ai-engine typecheck
JOBLEFT_TEST_KEYCHAIN=1 pnpm --filter @jobleft/ai-engine test   # also writes, reads and deletes one test item in the macOS Keychain
```

## 10. Not done yet

- The assistant presets, chat history, action proposals and interview practice (their routes and tables) are not built. `chat` streams one answer and does not save it.
- The fit model embedder (`createLocalEmbedder`) is written and was checked once against the spike S2 reference (same token ids, cosine 1.000000 for texts under 512 tokens), but ONNX Runtime is not a dependency yet (287 MB). Without `onnxruntime-node` (or `JOBLEFT_ORT_MODULE` pointing at an installed copy) it answers "The fit model runtime (ONNX Runtime) is not installed in this build". It downloads the model once from `JOBLEFT_MODEL_BASE_URL` and refuses a file whose sha256 does not match.
- Windows Credential Manager is not wired. On Windows and Linux the encrypted file store is used.
- Own-key requests to the real vendors were not tried (no real keys). They were tested against the stand-in through `JOBLEFT_AI_HOST_MAP`.
