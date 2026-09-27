// Makes sure the running app has jobs: starts one refresh when the store is empty and waits until jobs exist.
// Usage: node qa/bin/wait-for-jobs.mjs   (env JOBLEFT_QA_API, JOBLEFT_QA_TOKEN; JOBLEFT_QA_WAIT_S default 480)
const API = process.env.JOBLEFT_QA_API; const TOKEN = process.env.JOBLEFT_QA_TOKEN;
if (!API || !TOKEN) { console.error('JOBLEFT_QA_API and JOBLEFT_QA_TOKEN are needed'); process.exit(2); }
const H = { 'x-jobleft-token': TOKEN, 'content-type': 'application/json' };
const total = async () => { const r = await fetch(`${API}/jobs/search`, { method: 'POST', headers: H, body: JSON.stringify({ sort: 'recent' }) }); if (!r.ok) throw new Error(`search ${r.status}: ${(await r.text()).slice(0, 200)}`); return (await r.json()).total; };
let n = await total().catch(async () => { const r = await fetch(`${API}/jobs/search`, { method: 'POST', headers: H, body: JSON.stringify({ sort: 'recommended' }) }); return (await r.json()).total; });
console.log(`jobs now: ${n}`);
if (n === 0) {
  const r = await fetch(`${API}/crawl/run`, { method: 'POST', headers: H, body: '{}' });
  console.log(`crawl/run: ${r.status} ${(await r.text()).slice(0, 200)}`);
}
const deadline = Date.now() + Number(process.env.JOBLEFT_QA_WAIT_S ?? 480) * 1000;
while (n === 0 && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 5000));
  n = await total().catch(() => 0);
  const st = await fetch(`${API}/crawl/status`, { headers: H }).then((r) => r.json()).catch(() => null);
  console.log(`jobs: ${n}; crawl: ${st ? JSON.stringify(st).slice(0, 160) : '?'}`);
}
if (n === 0) { console.error('no jobs after the wait'); process.exit(1); }
console.log(`ready with ${n} jobs`);
