// The public URL Keycard reaches this machine at: PUBLIC_URL from .env if set (a named Cloudflare
// tunnel, ngrok or `tailscale funnel` give a stable one), else a Cloudflare quick tunnel. The quick
// tunnel runs on its own and is reused across restarts, so Keycard's settings stay put until it dies.
import dns from 'node:dns';
import fs from 'node:fs';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { PORT, state } from './keycard.js';

const LOG = state.file('cloudflared.log');
const SAVED = state.file('tunnel.json');
const alive = (pid?: number) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

// A brand-new tunnel hostname looked up too early gets cached as "no such host" by the OS resolver for
// minutes. Keycard resolves it from the internet, so check it the same way: through public DNS.
const resolver = new dns.Resolver();
resolver.setServers(['1.1.1.1', '8.8.8.8']);
const publicLookup: https.RequestOptions['lookup'] = (host, opts, cb) => {
  resolver.resolve4(host, (err, addrs) => {
    if (err || !addrs.length) return (cb as (e: Error | null, a: string, f: number) => void)(err ?? new Error('no address'), '', 4);
    if ((opts as { all?: boolean }).all) return (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, addrs.map(address => ({ address, family: 4 })));
    (cb as (e: null, a: string, f: number) => void)(null, addrs[0], 4);
  });
};
const probe = (url: string) => new Promise<boolean>(resolve => {
  const req = https.get(`${url}/healthz`, { lookup: publicLookup, timeout: 5000 }, res => { res.resume(); resolve(res.statusCode === 200); });
  req.on('timeout', () => req.destroy());
  req.on('error', () => resolve(false));
});

export async function reachable(url: string, ms = 90_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await probe(url)) return true;
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

export async function publicUrl(log: (l: string) => void): Promise<string> {
  if (process.env.PUBLIC_URL) {
    const url = process.env.PUBLIC_URL.replace(/\/$/, '');
    if (!/^https:\/\//.test(url)) throw new Error('PUBLIC_URL must be an https:// address.');
    log(`Checking ${url} reaches this app…`);
    if (!(await reachable(url))) throw new Error(`${url} doesn’t reach this app on port ${PORT}.`);
    return url;
  }
  const prev = fs.existsSync(SAVED) ? JSON.parse(fs.readFileSync(SAVED, 'utf8')) as { pid?: number; url?: string } : {};
  if (alive(prev.pid) && prev.url) {
    log(`Reusing the Cloudflare tunnel at ${prev.url}…`);
    if (await reachable(prev.url, 15_000)) return prev.url;
    // Cloudflare drops quick tunnels after a while while cloudflared keeps running. Start a new one.
    log('It stopped working (Cloudflare drops quick tunnels after a while). Starting a new one.');
    try { process.kill(prev.pid!); } catch { /* gone */ }
  }
  log('Starting a Cloudflare quick tunnel…');
  fs.writeFileSync(LOG, '');
  const out = fs.openSync(LOG, 'a');
  const proc = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], { detached: true, stdio: ['ignore', out, out] });
  let failed = false;
  proc.on('error', () => { failed = true; });
  proc.unref();
  let url: string | undefined;
  for (const until = Date.now() + 30_000; !url && !failed && Date.now() < until;) {
    await new Promise(r => setTimeout(r, 500));
    // api.trycloudflare.com is where cloudflared asks for a tunnel, not the tunnel itself.
    url = fs.readFileSync(LOG, 'utf8').match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/)?.[0];
  }
  if (failed) throw new Error('cloudflared is not installed. Run: brew install cloudflared (or set PUBLIC_URL in .env)');
  if (!url) throw new Error(`Cloudflare didn’t hand out a tunnel in 30s. See ${LOG}`);
  fs.writeFileSync(SAVED, JSON.stringify({ pid: proc.pid, url }));
  // Don't look the name up before Cloudflare has the tunnel: wait for cloudflared to register a connection.
  for (const until = Date.now() + 30_000; Date.now() < until && !/Registered tunnel connection/.test(fs.readFileSync(LOG, 'utf8'));) {
    await new Promise(r => setTimeout(r, 500));
  }
  log(`Tunnel: ${url}. Waiting until it’s reachable (up to a minute)…`);
  if (!(await reachable(url))) throw new Error(`${url} isn’t reachable yet. Run npm start again.`);
  return url;
}

export function stopTunnel() {
  const prev = fs.existsSync(SAVED) ? JSON.parse(fs.readFileSync(SAVED, 'utf8')) as { pid?: number } : {};
  if (alive(prev.pid)) try { process.kill(prev.pid!); } catch { /* gone */ }
  fs.rmSync(SAVED, { force: true });
}
