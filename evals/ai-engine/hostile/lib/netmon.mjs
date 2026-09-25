// Evaluator-written network monitor, preloaded with NODE_OPTIONS=--import into the product process.
// It records every TCP connect and DNS lookup (host, port) to $HOSTILE_NETMON_LOG. It does not change behaviour.
import net from 'node:net';
import dns from 'node:dns';
import fs from 'node:fs';

const LOG = process.env.HOSTILE_NETMON_LOG;
function rec(o) {
  if (!LOG) return;
  try { fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), pid: process.pid, ...o }) + '\n'); } catch {}
}
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  try {
    let o = args[0];
    if (Array.isArray(o)) o = o[0];
    if (o && typeof o === 'object') rec({ kind: 'connect', host: o.host ?? null, port: o.port ?? null, path: o.path ?? null });
    else rec({ kind: 'connect', host: typeof args[1] === 'string' ? args[1] : null, port: o });
  } catch {}
  return origConnect.apply(this, args);
};
const origLookup = dns.lookup;
dns.lookup = function (host, ...rest) { rec({ kind: 'dns', host }); return origLookup.call(this, host, ...rest); };
const origPLookup = dns.promises.lookup;
dns.promises.lookup = function (host, ...rest) { rec({ kind: 'dns', host }); return origPLookup.call(this, host, ...rest); };
