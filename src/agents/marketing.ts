// Acme Marketing Agent: works only in Acme Work, through its own Keycard gateway in each customer's zone.
// It holds no credentials of its own. Acme's app hands it the person's token for its gateway, and the
// gateway asks Keycard, per tool call, whether this agent may use this tool for this customer.
import express from 'express';
import * as jose from 'jose';
import { PORT, state } from '../keycard.js';
import { CUSTOMERS, VENDOR, agent } from '../story.js';
import { acmeWork, runLoop, STYLE } from './loop.js';

const A = agent('marketing')!;
export const MARKETING_PORT = Number(process.env.MARKETING_PORT ?? PORT + 2);

export function startMarketingAgent() {
  const app = express();
  app.use(express.json());
  app.post('/ask', async (req, res) => {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    // The gateway verifies the token; the issuer only tells the agent which customer's gateway to use.
    let iss: string | undefined;
    try { iss = token ? jose.decodeJwt(token).iss : undefined; } catch { /* not a JWT */ }
    const c = CUSTOMERS.find(x => state.zone(x.key)?.issuer === iss);
    if (!token || !c) return res.status(401).json({ error: `A Keycard token from a ${VENDOR} customer’s zone is required.` });
    let work: Awaited<ReturnType<typeof acmeWork>> | undefined;
    try {
      work = await acmeWork(A.name, state.zone(c.key)!.gateways.marketing.url, token);
      res.json(await runLoop(`You are the ${A.name}, which ${VENDOR} provides to its customers. You are helping someone at ${c.name}, in their Acme Work project, ${c.project}.\n${STYLE}`,
        String((req.body as { prompt?: string }).prompt ?? ''), work.tools));
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
    finally { await work?.close(); }
  });
  app.listen(MARKETING_PORT, '127.0.0.1', () => console.log(`  ${A.name} listening on http://localhost:${MARKETING_PORT}`));
}
