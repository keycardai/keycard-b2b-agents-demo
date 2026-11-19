// Acme Support Agent: one running service, many customers.
//
// - Each customer has its own Keycard zone. The agent is registered in every customer's zone as its own
//   application, with a separate credential in each, and a front door (resource) of its own in each.
// - A caller presents their person's token, audienced to the agent's front door in their own zone. The
//   agent reads the token's issuer only to pick which zone's verifier to use, then verifies it there.
// - For tickets it exchanges that token (RFC 8693, through Keycard's SDK) for a short-lived credential to
//   one customer's tickets. For Acme Work it uses its own gateway, with the token Acme's app handed it.
//
// One deliberate weakness, and it's in the code, not the model: the agent picks the customer zone from
// what was asked for, not from who is asking. Ask it for another customer's tickets and it uses that
// customer's credential with your token, the classic multi-tenant bug. Keycard is what stops it: a
// person's token from one customer's zone means nothing in another's.
import express from 'express';
import * as jose from 'jose';
import { TokenExchangeClient, TokenVerifier, OAuthError } from '@keycardai/oauth';
import { PORT, state, type ZoneRec } from '../keycard.js';
import { CUSTOMERS, VENDOR, agent, type Customer } from '../story.js';
import { acmeWork, runLoop, STYLE, type Step, type Tool } from './loop.js';

const A = agent('support')!;
export const SUPPORT_PORT = Number(process.env.SUPPORT_PORT ?? PORT + 1);

/** The agent's own registration in each customer's zone. */
const tenants = () => CUSTOMERS.flatMap(c => {
  const z = state.zone(c.key);
  return z ? [{ c, z }] : [];
});
const exchangers = new Map<string, TokenExchangeClient>();
const exchanger = (z: ZoneRec) => {
  const k = `${z.issuer}|${z.apps.support.clientId}`;
  if (!exchangers.has(k)) exchangers.set(k, new TokenExchangeClient(z.issuer, { clientId: z.apps.support.clientId, clientSecret: z.apps.support.clientSecret }));
  return exchangers.get(k)!;
};
const verifiers = new Map<string, TokenVerifier>();

/** Which customer's zone a caller's token comes from. The issuer only picks a verifier; it's never trusted on its own. */
async function callerTenant(token: string) {
  let iss: string | undefined;
  try { iss = jose.decodeJwt(token).iss; } catch { return undefined; }
  const t = tenants().find(x => x.z.issuer === iss);
  if (!t) return undefined;
  const audience = t.z.resources['agent:support'].identifier;
  const k = `${iss}|${audience}`;
  if (!verifiers.has(k)) verifiers.set(k, new TokenVerifier({ issuer: t.z.issuer, audience }));
  return (await verifiers.get(k)!.verifyToken(token).catch(() => null)) ? t : undefined;
}

/** The weakness: the zone comes from the customer asked for. The right code would use the caller's tenant, always. */
function readTickets(personToken: string): Tool {
  return {
    def: {
      name: 'read_tickets', description: `Read the open support tickets of one ${VENDOR} customer.`,
      input_schema: { type: 'object', properties: { customer: { type: 'string', enum: CUSTOMERS.map(c => c.name) } }, required: ['customer'] },
    },
    run: async (input, steps) => {
      const target = tenants().find(t => t.c.name.toLowerCase() === String(input.customer ?? '').toLowerCase());
      if (!target) return { ok: false, content: `No ${VENDOR} customer called ${input.customer}.` };
      const step = { agent: A.name, tool: 'read_tickets', system: `${target.c.name} support tickets` };
      let credential: string;
      try {
        credential = (await exchanger(target.z).exchangeToken({ subjectToken: personToken, resource: target.z.resources.tickets.identifier })).accessToken;
      } catch (e) {
        const detail = e instanceof OAuthError ? e.message : (e as Error).message;
        steps.push({ ...step, ok: false, detail });
        return { ok: false, content: `Keycard refused access to ${target.c.name}’s tickets: ${detail}` };
      }
      const r = await fetch(`http://localhost:${PORT}/support-api/tickets/${target.c.key}`, { headers: { authorization: `Bearer ${credential}` } });
      const body = await r.json().catch(() => ({})) as { data?: unknown; detail?: string };
      steps.push({ ...step, ok: r.ok, detail: body.detail ?? `HTTP ${r.status}` });
      return { ok: r.ok, content: JSON.stringify(body.data ?? body.detail) };
    },
  };
}

const system = (c: Customer) => `You are the ${A.name}, the support agent ${VENDOR} provides to its customers. You are helping someone at ${c.name}.
Use read_tickets for every customer the person mentions, including other customers when they ask to compare. You can also work in ${c.name}’s Acme Work project with the other tools.
${STYLE}`;

export function startSupportAgent() {
  const app = express();
  app.use(express.json());
  app.post('/ask', async (req, res) => {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    // Only a person's token issued for this agent, by one of its customers' zones, gets an answer.
    const caller = token ? await callerTenant(token) : undefined;
    if (!token || !caller) return res.status(401).json({ error: `A Keycard token for this agent, from a ${VENDOR} customer’s zone, is required.` });
    const workToken = String(req.headers['x-acme-work-token'] ?? '');
    let work: Awaited<ReturnType<typeof acmeWork>> | undefined;
    const steps: Step[] = [];
    try {
      if (workToken) {
        try { work = await acmeWork(A.name, caller.z.gateways.support.url, workToken); }
        catch (e) { steps.push({ agent: A.name, tool: 'tools/list', system: 'Acme Work', ok: false, detail: (e as Error).message }); }
      }
      const out = await runLoop(system(caller.c), String((req.body as { prompt?: string }).prompt ?? ''), [readTickets(token), ...(work?.tools ?? [])]);
      res.json({ reply: out.reply, steps: [...steps, ...out.steps] });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
    finally { await work?.close(); }
  });
  app.listen(SUPPORT_PORT, '127.0.0.1', () => console.log(`  ${A.name} listening on http://localhost:${SUPPORT_PORT}`));
}
