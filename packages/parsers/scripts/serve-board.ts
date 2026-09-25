// A local mock job board for trying the parsers: serves one JSON (or HTML) file on 127.0.0.1 at every path.
//   node packages/parsers/scripts/serve-board.ts <file> [--port 8765]
// It listens on loopback only, logs each request (time, method, path, user-agent) to stderr, and stops on Ctrl-C.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const portArg = args.indexOf('--port');
const port = portArg >= 0 ? Number(args[portArg + 1]) : 8765;
if (!file) {
  process.stderr.write('usage: node packages/parsers/scripts/serve-board.ts <file> [--port 8765]\n');
  process.exit(2);
}
const server = createServer((req, res) => {
  process.stderr.write(`${new Date().toISOString()} ${req.method} ${req.url} ua=${JSON.stringify(req.headers['user-agent'] ?? '')}\n`);
  let body: string;
  try { body = readFileSync(file, 'utf8'); } catch (e) { res.statusCode = 500; res.end(String(e)); return; }
  res.setHeader('content-type', body.trim().startsWith('<') ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8');
  res.end(body);
});
server.listen(port, '127.0.0.1', () => {
  process.stderr.write(`mock board: http://127.0.0.1:${port}/ serves ${file} (reloaded on every request)\n`);
});
