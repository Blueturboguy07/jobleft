// Starts the loopback stand-ins (see mocks.ts) and prints the environment that points jobleft at them.
//
//   node apps/server/scripts/mock-servers.ts --dir /private/tmp/jl-mocks [--boards-port 4010] [--ai-port 4020] [--publik-port 4030]
//
// It writes <dir>/boards.json (one Greenhouse board "mockco" with three postings, if the file does not exist yet)
// and appends every request to <dir>/requests.ndjson and to <dir>/<boards|ai|publik>-requests.ndjson. Edit boards.json at any time: the next request reads it.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { greenhouseJob, startAi, startBoards, startPublik } from './mocks.ts';

const { values } = parseArgs({ options: {
  dir: { type: 'string' }, 'boards-port': { type: 'string' }, 'ai-port': { type: 'string' }, 'publik-port': { type: 'string' },
} });
const dir = values.dir ?? '/private/tmp/jl-mocks';
mkdirSync(dir, { recursive: true });
const boardsFile = join(dir, 'boards.json');
if (!existsSync(boardsFile)) {
  writeFileSync(boardsFile, JSON.stringify({
    greenhouse: {
      mockco: [
        greenhouseJob(1001, { board: 'mockco', title: 'Data Analyst', location: 'Austin, TX', content: '<p>Analyze data. Pay: $80,000 - $100,000 per year.</p>', posted: '2026-09-20T15:00:00-04:00', pay: { min: 80000, max: 100000 } }),
        greenhouseJob(1002, { board: 'mockco', title: 'Registered Nurse', location: 'Remote - US', content: '<p>Care for patients.</p>', posted: null }),
        greenhouseJob(1003, { board: 'mockco', title: 'Senior Software Engineer', location: 'New York, NY', content: '<p>Build things. 5+ years of experience.</p>', posted: '2026-09-18T09:30:00Z' }),
      ],
    },
  }, null, 2));
}
const log = join(dir, 'requests.ndjson');
// One log per stand-in (so a search of the job-board log is not mixed with what the person chose to send to the AI),
// and all of them together in requests.ndjson.
const logOf = (name: string) => [log, join(dir, `${name}-requests.ndjson`)];
const boards = await startBoards({ file: boardsFile, port: Number(values['boards-port'] ?? 4010), logFile: logOf('boards') });
const ai = await startAi({ port: Number(values['ai-port'] ?? 4020), logFile: logOf('ai') });
const publik = await startPublik({ port: Number(values['publik-port'] ?? 4030), logFile: logOf('publik') });

process.stdout.write([
  'jobleft stand-ins are running on 127.0.0.1 (Ctrl+C stops them).',
  `  job boards: ${boards.origin}  (edit ${boardsFile}; Greenhouse, Lever and Ashby list endpoints)`,
  `  AI server:  ${ai.origin}/v1  (OpenAI-compatible; model "mock-model")`,
  `  publik:     ${publik.origin}/api/v1  (balance: POST ${publik.origin}/__admin/balance {"micros":0})`,
  `  every request is logged to ${log}, and per stand-in to ${join(dir, 'boards-requests.ndjson')}, ai-requests.ndjson, publik-requests.ndjson`,
  '',
  'Start jobleft with:',
  `  export JOBLEFT_HOST_MAP='${JSON.stringify({ 'boards-api.greenhouse.io': boards.origin, 'api.lever.co': boards.origin, 'api.ashbyhq.com': boards.origin })}'`,
  `  export JOBLEFT_PUBLIK_BASE_URL='${publik.origin}/api/v1'`,
  '',
].join('\n'));

const stop = () => { void Promise.all([boards.close(), ai.close(), publik.close()]).then(() => process.exit(0)); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
