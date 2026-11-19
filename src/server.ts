// npm start: the whole demo in one process.
//   http://localhost:4747                       Acme's app: each customer's person uses Acme's agents
//   http://localhost:4747/customers/<c>/settings Acme's settings page, as each customer's admin sees it
// It also serves, at the public URL, what Keycard must reach: each customer's IdP and Acme Work.
// On first start it builds the customer zones in your Keycard org; after that it only keeps them current.
import path from 'node:path';
import express from 'express';
import { api, consoleLinks, describeError, PORT, state, type ZoneRec } from './keycard.js';
import { ensureZones, resetCustomer } from './provision.js';
import { activate, publishRules, ruleIds, rulesFor } from './policies.js';
import { idpRouter } from './idp.js';
import { acmeWorkRouter } from './acme-work.js';
import { ticketsRouter } from './tickets.js';
import { decisionsSince } from './audit.js';
import { completeLogin, handTo, loginUrl, signedIn, signOut, SignInRequired } from './sessions.js';
import { publicUrl } from './tunnel.js';
import { startSupportAgent, SUPPORT_PORT } from './agents/support.js';
import { startMarketingAgent, MARKETING_PORT } from './agents/marketing.js';
import { AGENTS, CUSTOMERS, PROMPTS, VENDOR, WORK_TOOLS, agent, customer, gatewayName, type Customer, type WorkTool } from './story.js';

const app = express();
// Behind the tunnel, requests arrive as http. Acme Work's token check compares the token's audience with
// the address it was called at, so it must see the https address the tunnel was called at.
app.set('trust proxy', true);
app.use(express.json());
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.use(idpRouter());
app.use(acmeWorkRouter());
app.use(ticketsRouter());

// Everything below is Acme's own app and admin API: for the browser on this machine only, not the tunnel.
const local = (req: express.Request, res: express.Response, next: express.NextFunction) =>
  req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] ? res.status(404).end() : next();
const pub = path.resolve('public');
app.get('/', local, (_req, res) => res.sendFile(path.join(pub, 'index.html')));
app.get('/customers/:key/settings', local, (_req, res) => res.sendFile(path.join(pub, 'settings.html')));

/* ---------- Startup state ---------- */
const boot = { ready: false, error: '', log: [] as string[] };
const log = (l: string) => { boot.log.push(l); console.log(l); };

/** One policy change at a time per customer: each publishes a new set version. */
const queues = new Map<string, Promise<unknown>>();
const serial = <T>(key: string, fn: () => Promise<T>) => {
  const next = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  queues.set(key, next.catch(() => {}));
  return next;
};

app.get('/api/state', local, (_req, res) => {
  const s = state.read();
  res.json({
    ...boot, vendor: VENDOR, publicUrl: s.publicUrl ?? null,
    customers: CUSTOMERS.map(c => {
      const z = s.zones[c.key];
      return { key: c.key, name: c.name, person: c.person, project: c.project, signedIn: signedIn(c), built: !!z, console: z ? consoleLinks(z) : null, off: z?.off ?? [] };
    }),
    agents: AGENTS.map(a => ({ key: a.key, name: a.name, blurb: a.blurb, prompts: PROMPTS[a.key] })),
  });
});

/* ---------- Sign-in ---------- */
app.get('/login/:customer', local, async (req, res) => {
  const c = customer(String(req.params.customer));
  if (!c) return res.sendStatus(404);
  try { res.redirect(await loginUrl(c)); } catch (e) { res.status(500).send(describeError(e)); }
});
app.get('/auth/callback', local, async (req, res) => {
  try {
    const c = await completeLogin(req.query as Record<string, string>);
    res.redirect(`/?as=${c.key}`);
  } catch (e) { res.status(400).type('text').send(`Sign-in failed: ${describeError(e)}\n\nGo back to http://localhost:${PORT} and try again.`); }
});
app.post('/api/signout/:customer', local, (req, res) => { const c = customer(String(req.params.customer)); if (c) signOut(c); res.json({ ok: true }); });

/* ---------- Ask an agent ---------- */
interface Line { label: string; ok: boolean; detail: string; policy?: string | null; link?: string | null }

app.post('/api/ask', local, async (req, res) => {
  const b = req.body as { customer?: string; agent?: string; prompt?: string };
  const c = customer(String(b.customer)), a = agent(String(b.agent));
  const z = c && state.zone(c.key);
  if (!c || !a || !z) return res.status(400).json({ error: 'Pick a signed-in customer and an agent.' });
  const who = c.person.name.split(' ')[0];
  const lines: Line[] = [];
  const startedAt = new Date(Date.now() - 2000).toISOString();
  try {
    // Hop 1: Acme's sign-in app hands the person to the agent. For Acme Work, that's the agent's gateway.
    const gw = await handTo(c, z.gateways[a.key].url);
    lines.push({ label: `Keycard: ${who} → ${gatewayName(a)} (${c.name} zone)`, ok: gw.ok, detail: gw.ok ? 'token issued for the agent’s gateway' : gw.detail });
    let front: Awaited<ReturnType<typeof handTo>> | undefined;
    if (a.tickets) {
      front = await handTo(c, z.resources['agent:support'].identifier);
      lines.push({ label: `Keycard: ${who} → ${a.name} (${c.name} zone)`, ok: front.ok, detail: front.ok ? 'token issued for the agent' : front.detail });
    }
    const main = front ?? gw;
    if (!main.ok) return res.json({ reply: `Keycard refused to hand ${who} to the ${a.name}.`, lines: await withPolicies(c, startedAt, lines) });
    const r = await fetch(`http://127.0.0.1:${a.key === 'support' ? SUPPORT_PORT : MARKETING_PORT}/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${main.token}`, ...(front && gw.ok ? { 'x-acme-work-token': gw.token } : {}) },
      body: JSON.stringify({ prompt: String(b.prompt ?? '') }),
    });
    const body = await r.json().catch(() => ({})) as { reply?: string; error?: string; steps?: { agent: string; tool: string; system: string; ok: boolean; detail: string }[] };
    if (!r.ok) throw new Error(body.error ?? `${a.name}: HTTP ${r.status}`);
    for (const st of body.steps ?? []) lines.push({ label: `${st.agent} → ${st.system}: ${st.tool}`, ok: st.ok, detail: st.detail });
    res.json({ reply: body.reply, lines: await withPolicies(c, startedAt, lines) });
  } catch (e) {
    if (e instanceof SignInRequired) return res.status(401).json({ error: e.message, signIn: c.key });
    res.status(500).json({ error: describeError(e), lines });
  }
});

/** A refusal's reason, from Keycard's own record: it names the policy. Records can take a moment to land. */
async function withPolicies(c: Customer, since: string, lines: Line[]) {
  if (lines.every(l => l.ok)) return lines;
  let ds: Awaited<ReturnType<typeof decisionsSince>> = [];
  for (let i = 0; i < 4; i++) {
    ds = await decisionsSince(c, since).catch(() => []);
    if (ds.some(d => !d.ok)) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  const refused = ds.filter(d => !d.ok);
  return lines.map(l => {
    if (l.ok) return l;
    const tool = /: (\w+)$/.exec(l.label)?.[1];
    const d = refused.find(x => x.tool && x.tool === tool) ?? refused.find(x => !x.tool && l.label.includes(x.agent ?? '\u0000'));
    return d ? { ...l, detail: d.message ?? l.detail, policy: d.policy, link: d.link } : l;
  });
}

/* ---------- Acme's settings page, per customer ---------- */
const zoneOf = (req: express.Request) => {
  const c = customer(String(req.params.key));
  const z = c && state.zone(c.key);
  return c && z ? { c, z } : null;
};

app.get('/api/customers/:key', local, (req, res) => {
  const x = zoneOf(req);
  if (!x) return res.status(404).json({ error: 'That customer isn’t built in Keycard yet.' });
  const { c, z } = x;
  const rules = rulesFor(c, z);
  res.json({
    customer: { key: c.key, name: c.name }, admin: `${c.name}’s admin`,
    customers: CUSTOMERS.map(y => ({ key: y.key, name: y.name })),
    agents: AGENTS.map(a => ({ key: a.key, name: a.name, blurb: a.blurb, on: !z.off.includes(a.key), allowed: z.allowed[a.key] })),
    tools: WORK_TOOLS,
    policies: rules.map(r => ({ name: r.name, description: r.description, cedar: r.cedar, active: !r.standby || z.off.some(k => r.id === `switch-off-${k}`) })),
    console: consoleLinks(z),
  });
});

app.post('/api/customers/:key/agents/:agent/switch', local, async (req, res) => {
  const x = zoneOf(req), a = agent(String(req.params.agent));
  if (!x || !a) return res.sendStatus(404);
  const on = !!(req.body as { on?: boolean }).on;
  try {
    const version = await serial(x.c.key, async () => {
      const z = state.zone(x.c.key)!;
      z.off = on ? z.off.filter(k => k !== a.key) : [...new Set([...z.off, a.key])];
      const v = await activate(z, rulesFor(x.c, z));
      state.saveZone(x.c.key, z);
      return v;
    });
    res.json({ log: [
      { who: 'acme', text: `${x.c.name}’s admin switched the ${a.name} ${on ? 'on' : 'off'}.` },
      { who: 'keycard', text: `Acme → Keycard (Management API): ${x.c.name} policies, version ${version} is active, ${on ? 'without' : 'with'} “${a.name} is switched off”.` },
    ] });
  } catch (e) { res.status(500).json({ log: [{ who: 'acme', ok: false, text: describeError(e) }] }); }
});

app.post('/api/customers/:key/agents/:agent/tools', local, async (req, res) => {
  const x = zoneOf(req), a = agent(String(req.params.agent));
  const b = req.body as { tool?: string; allowed?: boolean };
  const tool = WORK_TOOLS.find(t => t.name === b.tool);
  if (!x || !a || !tool) return res.sendStatus(404);
  try {
    const version = await serial(x.c.key, async () => {
      const z: ZoneRec = state.zone(x.c.key)!;
      const now = new Set(z.allowed[a.key]);
      if (b.allowed) now.add(tool.name); else now.delete(tool.name);
      // In the catalog's order, so the policy reads the same way every time.
      z.allowed[a.key] = WORK_TOOLS.map(t => t.name).filter(t => now.has(t)) as WorkTool[];
      const rules = rulesFor(x.c, z);
      await publishRules(z, rules.filter(r => r.id === ruleIds.tools(a)));
      const v = await activate(z, rules);
      state.saveZone(x.c.key, z); // only once Keycard has it, so a failure leaves the old choice in place
      return v;
    });
    res.json({ log: [
      { who: 'acme', text: `${x.c.name}’s admin set “${tool.label}” to ${b.allowed ? 'Allow' : 'Block'} for the ${a.name}.` },
      { who: 'keycard', text: `Acme → Keycard (Management API): a new version of “${a.name} may use only the Acme Work tools ${x.c.name} allows”; ${x.c.name} policies version ${version} is active.` },
    ] });
  } catch (e) { res.status(500).json({ log: [{ who: 'acme', ok: false, text: describeError(e) }] }); }
});

app.get('/api/customers/:key/history', local, async (req, res) => {
  const x = zoneOf(req);
  if (!x) return res.sendStatus(404);
  // What the agents themselves asked for; the sign-in app handing people to them is left out.
  const names = new Set<string>(AGENTS.map(a => a.name));
  try { res.json({ decisions: (await decisionsSince(x.c, new Date(Date.now() - 3 * 3600_000).toISOString())).filter(d => d.agent && names.has(d.agent)).slice(0, 40) }); }
  catch (e) { res.json({ error: `Couldn’t load activity from Keycard: ${describeError(e)}`, decisions: [] }); }
});

/** Put both customers back to the start: default tools, every agent on. */
app.post('/api/reset', local, async (_req, res) => {
  try {
    for (const c of CUSTOMERS) await serial(c.key, () => resetCustomer(c));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: describeError(e) }); }
});

app.use(express.static(pub));

/* ---------- Start ---------- */
app.listen(PORT, async () => {
  console.log(`\nAcme’s app: http://localhost:${PORT}\n`);
  try {
    api(); // fail fast on missing credentials
    if (!process.env.ANTHROPIC_API_KEY) log('Note: ANTHROPIC_API_KEY isn’t set, so the agents can’t answer yet. Add it to .env and restart.');
    startSupportAgent();
    startMarketingAgent();
    const url = await publicUrl(log);
    const s = state.read(); s.publicUrl = url; state.write(s);
    log(`Keycard reaches this machine at ${url}`);
    await ensureZones(url, log);
    boot.ready = true;
    log(`\n✓ Ready. Open http://localhost:${PORT}`);
  } catch (e) {
    boot.error = describeError(e);
    console.error(`\n✗ ${boot.error}`);
  }
});
