// Keeps the repo's publik stand-in (packages/ai-engine/src/mock/publik-server.ts) up on a fixed port for a black-box
// check of the installed app: the balance starts at $0.00 and unlinked, like a real new install. The app token it
// accepts is JOBLEFT_PUBLIK_APP_TOKEN when set (the packaged app sends the token it ships with), else the stand-in's
// own. Usage: node qa/bin/publik-standin.mjs <port>   (from the repository root; stop it with the process id it prints)
const { startMockPublikServer, STANDIN_APP_TOKEN } = await import('../../packages/ai-engine/src/mock/publik-server.ts');
const port = Number(process.argv[2] ?? 47991);
const appToken = process.env.JOBLEFT_PUBLIK_APP_TOKEN || STANDIN_APP_TOKEN;
const s = await startMockPublikServer({ port, balanceUsd: 0, priceUsd: 0.01, appToken, log: null });
console.log(JSON.stringify({ pid: process.pid, port: s.port, baseUrl: s.baseUrl, admin: `http://127.0.0.1:${s.port}/__admin` }));
const stop = () => { s.close().then(() => process.exit(0), () => process.exit(0)); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
setInterval(() => {}, 1 << 30);
