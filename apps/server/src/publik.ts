// publik.ts — Sign in with publik, usage counting, and publik API as one provider option.
// At app start, before any screen of your own: `const gate = await ensureSignedIn(ui)`. It
//   1. loads or provisions this computer's publik key (POST /api/v1/installs);
//   2. shows Sign in with publik until GET /api/v1/wallet says "claimed" (no other way past it);
//   3. when USES_AI: asks once how the app pays for AI and stores the answer (setChoice() changes it);
//   4. starts usage counting: app_opened now, active_session every 30 minutes (POST /api/v1/telemetry).
// This is the publik module from https://publikhq.com/sdk/publik.ts.md, copied as one file. In jobleft the
// server (the Node sidecar) owns it: main.ts runs the gate, http/publik-gate.ts draws its screens in the app
// window, and the AI engine takes this computer's key from readCredential() (through the server's sign-in hook).
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, homedir, hostname, platform } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { APP_VERSION as SERVER_VERSION } from "./version.ts";

export const APP_SLUG = "jobleft";
export const APP_VERSION = SERVER_VERSION;
/** false: the app calls no model. It still signs in and counts users; it skips the plan screen. */
export const USES_AI = true;
const ORIGIN = process.env.PUBLIK_ORIGIN || "https://publikhq.com"; // PUBLIK_ORIGIN: tests only
export const DEFAULT_BASE_URL = `${ORIGIN}/api/v1`;
/** Ask for a tier, never a vendor model name. */
export const MODELS = { fast: "publik-fast", balanced: "publik-balanced", smart: "publik-smart" } as const;
const POLL_MS = 3_000, POLL_LIMIT_MS = 10 * 60_000;
const OS = ({ darwin: "macos", win32: "windows", linux: "linux" } as Record<string, string>)[platform()];

export type Choice = "publik" | "own_key";
export interface PublikCredential { key: string; base_url: string; install_id: string; claim_url: string | null; choice?: Choice | null }
export interface Wallet {
  claim_state: "anonymous" | "claimed"; claim_url: string | null; account: { handle: string | null } | null;
  plan: { kind: "none" | "plan" | "pack"; label: string | null }; balance_micros: number; top_up_url: string; linked_at: string | null;
}
export type GateAction = "sign_in" | "retry" | "get_plan" | "connect" | "own_key";
export interface GateScreen { id: "sign_in" | "unreachable" | "choose"; title: string; body: string; note: string | null; buttons: { action: GateAction; label: string }[] }
/** show(): draw the screen and resolve with the button pressed. When `signal` aborts, close it (the promise may stay pending). */
export interface GateUI { show(screen: GateScreen, signal: AbortSignal): Promise<GateAction>; openUrl(url: string): unknown }
export type Provider = { kind: "own" | "publik"; baseURL: string; apiKey: string } | { kind: "needs_own_key" };

function appToken(): string {
  const env = process.env.PUBLIK_APP_TOKEN?.trim();
  if (env) return env;
  for (let dir = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir)) {
    const file = join(dir, "publik-app-token.txt");
    if (existsSync(file)) return readFileSync(file, "utf8").trim();
    if (dirname(dir) === dir) return "";
  }
}

/** ~/Library/Application Support/publik, %LOCALAPPDATA%\publik, ~/.config/publik: shared by every publik app. */
function publikDir(): string {
  const os = platform();
  const base = os === "darwin" ? join(homedir(), "Library", "Application Support")
    : os === "win32" ? (process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"))
    : (process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
  return join(base, "publik");
}
export const credentialPath = () => join(publikDir(), "apps", `${APP_SLUG}.json`);

export function readCredential(): PublikCredential | null {
  try {
    const c = JSON.parse(readFileSync(credentialPath(), "utf8")) as PublikCredential;
    return typeof c.key === "string" && c.key.startsWith("pk_") ? c : null;
  } catch { return null; }
}
function writeCredential(c: PublikCredential | null): void {
  const file = credentialPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(c ?? {}, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}
/** The person's answer to the plan screen. Settings call it to change the answer; null asks again at the next start. */
export function setChoice(choice: Choice | null): void {
  const c = readCredential();
  if (c) writeCredential({ ...c, choice });
}

/** The key this app uses: the stored choice decides. PUBLIK_API_KEY / PUBLIK_API_BASE_URL in the environment override (development). */
export function resolveProvider(userKey?: { baseURL: string; apiKey: string } | null): Provider {
  if (process.env.PUBLIK_API_KEY) return { kind: "publik", baseURL: process.env.PUBLIK_API_BASE_URL ?? DEFAULT_BASE_URL, apiKey: process.env.PUBLIK_API_KEY };
  const c = readCredential();
  if (c?.choice === "publik") return { kind: "publik", baseURL: c.base_url || DEFAULT_BASE_URL, apiKey: c.key };
  return userKey?.apiKey ? { kind: "own", ...userKey } : { kind: "needs_own_key" };
}

/** POST /api/v1/installs: this computer's publik key. Throws a readable message. */
export async function provision(): Promise<PublikCredential> {
  const token = appToken();
  if (!token.startsWith("pat_")) throw new Error("This build has no publik app token. Ask the developer for a new build.");
  const prior = readCredential();
  let installId = prior?.install_id ?? randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${ORIGIN}/api/v1/installs`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ app_token: token, app_slug: APP_SLUG, app_version: APP_VERSION, os: OS ?? "linux", ...(arch() === "arm64" || arch() === "x64" ? { arch: arch() } : {}),
        device_name: hostname().slice(0, 120), install_id: installId, disclosure_version: 1, dialects: ["chat_completions"] }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    const key: string | null = body.key ?? (res.status === 200 ? prior?.key ?? null : null);
    if ((res.status === 201 || res.status === 200) && key) {
      const c: PublikCredential = { key, base_url: body.base_url ?? DEFAULT_BASE_URL, install_id: body.install_id ?? installId, claim_url: body.claim_url ?? null, choice: prior?.choice ?? null };
      writeCredential(c); // the key reaches disk before anything else sees it
      return c;
    }
    if (res.status === 200 || body.error?.type === "install_revoked") { installId = randomUUID(); continue; }
    throw new Error(body.error?.message ?? `publik could not set up this computer (${res.status}).`);
  }
  throw new Error("publik could not set up this computer.");
}

/** GET /api/v1/wallet. 401: the key is gone (null wallet). Throws when publik is not reachable. */
export async function readWallet(key: string): Promise<{ status: number; wallet: Wallet | null; message: string | null }> {
  const res = await fetch(`${ORIGIN}/api/v1/wallet`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
  const b = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok || typeof b.claim_state !== "string") return { status: res.status, wallet: null, message: b.error?.message ?? null };
  return { status: res.status, message: null, wallet: { ...b, account: b.account ?? null, plan: b.plan ?? { kind: "none", label: null }, balance_micros: b.balance_micros ?? 0 } as Wallet };
}

const dollars = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;
/** The words of the gate. The same in every publik module. */
export function gateScreen(id: GateScreen["id"], w: Wallet | null, note: string | null = null, message?: string): GateScreen {
  if (id === "unreachable") return { id, title: "Sign in with publik", body: message ?? "publik is not reachable. Check your connection.", note, buttons: [{ action: "retry", label: "Retry" }] };
  if (id === "sign_in") return { id, title: "Sign in with publik", note, buttons: [{ action: "sign_in", label: "Sign in with publik" }],
    body: "This app uses your publik account. Click Sign in with publik, then sign in in your browser. This window continues when you are signed in." };
  const who = w?.account?.handle ? `You are signed in as @${w.account.handle}.` : "You are signed in to publik.";
  if (!w || (w.plan.kind === "none" && w.balance_micros === 0)) return { id, title: "Choose how to pay for AI", note,
    body: `${who} This app uses AI. Get a publik plan, or use your own key.`, buttons: [{ action: "get_plan", label: "Get a plan" }, { action: "own_key", label: "Use my own key" }] };
  const what = w.plan.kind === "plan" ? `Your plan: ${w.plan.label ?? "publik"}.` : `Your balance: ${dollars(w.balance_micros)}.`;
  return { id, title: "Connect your plan", note, body: `${who} ${what} Connect it to use AI in this app, or use your own key.`,
    buttons: [{ action: "connect", label: "Connect your plan" }, { action: "own_key", label: "Use my own key" }] };
}

/** Show a screen; with `until`, also poll GET /wallet every 3 s for at most 10 minutes. "done": the poll saw it; "timeout": it did not. */
async function ask(ui: GateUI, screen: GateScreen, key?: string, until?: (w: Wallet) => boolean): Promise<GateAction | "done" | "timeout"> {
  const stop = new AbortController();
  const poll = async (): Promise<"done" | "timeout"> => {
    for (const end = Date.now() + POLL_LIMIT_MS; Date.now() < end && !stop.signal.aborted; ) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (stop.signal.aborted) break;
      const w = await readWallet(key!).then((r) => r.wallet, () => null);
      if (w && until!(w)) return "done";
    }
    return "timeout";
  };
  try { return await Promise.race([ui.show(screen, stop.signal), ...(until ? [poll()] : [])]); } finally { stop.abort(); }
}

/** The gate (see the top of the file). Resolves once the person is signed in; `choice` is null when USES_AI is false. */
export async function ensureSignedIn(ui: GateUI = terminalUI()): Promise<{ key: string; wallet: Wallet; choice: Choice | null }> {
  if (process.env.PUBLIK_SELF_TEST) { console.log(await selfTest()); process.exit(0); }
  let signNote: string | null = null, signPoll = true, planNote: string | null = null, planPoll = false;
  for (;;) {
    let c: PublikCredential, r: Awaited<ReturnType<typeof readWallet>>;
    try {
      c = process.env.PUBLIK_API_KEY ? { key: process.env.PUBLIK_API_KEY, base_url: DEFAULT_BASE_URL, install_id: "", claim_url: null } : readCredential() ?? (await provision());
      r = await readWallet(c.key);
    } catch (e) {
      const offline = e instanceof TypeError || (e instanceof Error && /abort|timeout/i.test(e.name));
      await ask(ui, gateScreen("unreachable", null, null, offline ? undefined : String((e as Error).message)));
      continue;
    }
    if (r.status === 401 && !process.env.PUBLIK_API_KEY) { writeCredential(null); continue; } // a revoked key: provision again
    const w = r.wallet;
    if (!w) { await ask(ui, gateScreen("unreachable", null, null, r.message ?? undefined)); continue; }
    if (w.claim_state !== "claimed") {
      const a = await ask(ui, gateScreen("sign_in", w, signNote), c.key, signPoll ? (x) => x.claim_state === "claimed" : undefined);
      if (a === "sign_in") { ui.openUrl(w.claim_url ?? c.claim_url ?? `${ORIGIN}/wallet`); signNote = "Waiting for you to sign in in your browser."; signPoll = true; }
      if (a === "timeout") { signNote = "No sign-in after 10 minutes. Click Sign in with publik to try again."; signPoll = false; }
      continue;
    }
    let choice: Choice | null = USES_AI ? readCredential()?.choice ?? null : null;
    if (USES_AI && !choice) {
      if (w.plan.kind !== "none" || w.balance_micros > 0) { planNote = null; planPoll = false; } // the plan is there: Connect your plan
      const a = await ask(ui, gateScreen("choose", w, planNote), c.key, planPoll ? (x) => x.plan.kind !== "none" || x.balance_micros > 0 : undefined);
      planNote = null; planPoll = false;
      if (a === "get_plan") { ui.openUrl(w.top_up_url); planNote = "Waiting for your plan. Finish in your browser."; planPoll = true; }
      if (a === "timeout") planNote = "No plan after 10 minutes. Click Get a plan to try again.";
      if (a !== "connect" && a !== "own_key") continue; // "done": the plan is there; the next screen is Connect your plan
      choice = a === "connect" ? "publik" : "own_key";
      setChoice(choice);
    }
    startTelemetry();
    return { key: c.key, wallet: w, choice };
  }
}

/** Builder check, run by the BUILT app: PUBLIK_SELF_TEST=1 makes ensureSignedIn() print this line and exit. */
export async function selfTest(): Promise<string> {
  try {
    const r = await readWallet((await provision()).key);
    if (!r.wallet) throw new Error(r.message ?? `GET /wallet answered ${r.status}`);
    return `publik self-test: ok ${APP_SLUG} ${APP_VERSION}`;
  } catch (e) {
    const offline = e instanceof TypeError || (e instanceof Error && /abort|timeout/i.test(e.name));
    return `publik self-test: failed: ${offline ? "publik is not reachable. Check your connection." : e instanceof Error ? e.message : String(e)}`;
  }
}

/** A terminal UI for a command-line app. An Electron app passes its own GateUI (see the page). */
export function terminalUI(): GateUI {
  return {
    async show(s, signal) {
      console.log(`\n${s.title}\n${s.body}${s.note ? `\n${s.note}` : ""}\n${s.buttons.map((b, i) => `  ${i + 1}. ${b.label}`).join("\n")}`);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        for (;;) {
          const n = Number((await rl.question(s.buttons.length > 1 ? "Type a number and press Enter: " : "Press Enter: ", { signal })) || 1);
          if (s.buttons[n - 1]) return s.buttons[n - 1]!.action;
        }
      } catch { return new Promise<GateAction>(() => {}); } finally { rl.close(); }
    },
    openUrl(url) {
      console.log(`Open this link if your browser does not open: ${url}`);
      const [cmd, args] = platform() === "darwin" ? ["open", [url]] : platform() === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
      try { spawn(cmd as string, args as string[], { detached: true, stdio: "ignore" }).on("error", () => {}).unref(); } catch {}
    },
  };
}

// ---------- usage counting: /skills/telemetry.md sections 3-5 ----------
let timer: ReturnType<typeof setInterval> | null = null, installIdOnce: string | null = null;

function usageOff(): boolean {
  const dnt = (process.env.DO_NOT_TRACK ?? "").trim().toLowerCase();
  if (dnt !== "" && dnt !== "0" && dnt !== "false") return true;
  if (["0", "false", "off"].includes((process.env.PUBLIK_TELEMETRY ?? "").trim().toLowerCase())) return true;
  try { return JSON.parse(readFileSync(join(publikDir(), "consent.json"), "utf8")).usage === false; } catch { return false; }
}
/** One random UUID per computer account, shared by every publik app, in <publik dir>/telemetry.json (mode 0600). */
function telemetryInstallId(): string {
  const file = join(publikDir(), "telemetry.json");
  const saved = () => {
    try {
      const id = String(JSON.parse(readFileSync(file, "utf8")).install_id).toLowerCase();
      return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) ? id : null;
    } catch { return null; }
  };
  if ((installIdOnce ??= saved())) return installIdOnce;
  const fresh = randomUUID(); // if the file cannot be saved, this ID lasts for this run only
  try {
    mkdirSync(publikDir(), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ install_id: fresh, created_at: new Date().toISOString().replace(/\.\d+Z$/, "Z") }) + "\n", { flag: "wx", mode: 0o600 });
    return (installIdOnce = fresh);
  } catch { return (installIdOnce = saved() ?? fresh); } // another publik app saved its ID first
}
async function sendEvent(event: "app_opened" | "active_session"): Promise<void> {
  const say = (result: unknown) => { if (process.env.PUBLIK_TELEMETRY_DEBUG === "1") process.stderr.write(`publik-telemetry: ${event} -> ${result}\n`); };
  try {
    if (!OS) return;
    if (usageOff()) return say("off (opt-out)");
    const key = process.env.PUBLIK_API_KEY || readCredential()?.key;
    const body = { v: 1, app: APP_SLUG, install_id: telemetryInstallId(), event, app_version: APP_VERSION.replace(/^v/i, ""), os: OS,
      ...(arch() === "arm64" || arch() === "x64" ? { arch: arch() } : {}) };
    const res = await fetch(process.env.PUBLIK_TELEMETRY_URL || `${ORIGIN}/api/v1/telemetry`, { method: "POST", signal: AbortSignal.timeout(5_000),
      headers: { "content-type": "application/json", ...(key?.startsWith("pk_") ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });
    say(res.status);
  } catch (e) { say(e instanceof Error ? e.name : "error"); }
}
/** Called by ensureSignedIn(). app_opened now, active_session every 30 minutes; never fails the app, never blocks. */
export function startTelemetry(): void {
  if (timer) return;
  const s = Number(process.env.PUBLIK_TELEMETRY_INTERVAL_SECONDS); // tests only
  timer = setInterval(() => void sendEvent("active_session"), (s >= 1 && s <= 86_400 ? s : 1_800) * 1000);
  timer.unref?.();
  void sendEvent("app_opened");
}

// ---------- publik API calls ----------
/** OpenAI-compatible client config: new OpenAI(clientConfig(p)). */
export function clientConfig(p: Extract<Provider, { apiKey: string }>) { return { baseURL: p.baseURL, apiKey: p.apiKey }; }

/** A 402 renders its message plus exactly ONE link: this one. */
export function topUpUrlFrom402(body: unknown): { message: string; url: string | null } {
  const e = (body as { error?: { message?: string; top_up_url?: string } } | null)?.error;
  return { message: e?.message ?? "Not enough publik API balance.", url: e?.top_up_url ?? null };
}

/** `POST /search`: web results for `q` (quote a phrase to find it exactly), one published price per search; on 402 the message and the one link. */
export async function search(p: Extract<Provider, { apiKey: string }>, q: string, count = 10): Promise<{ results: Array<{ url: string; title: string; snippet: string; site: string }>; message?: string; url?: string | null }> {
  const res = await fetch(`${p.baseURL}/search`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${p.apiKey}` }, body: JSON.stringify({ q, count }) });
  const body = (await res.json().catch(() => ({}))) as { results?: Array<{ url: string; title: string; snippet: string; site: string }>; error?: { message?: string } };
  if (res.status === 402) return { results: [], ...topUpUrlFrom402(body) };
  if (!res.ok) throw new Error(body.error?.message ?? `publik API answered ${res.status}`);
  return { results: body.results ?? [] };
}
