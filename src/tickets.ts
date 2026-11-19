// Acme Support's ticket API. Each customer's tickets are their own Keycard resource in their own zone,
// so a request needs a token from that customer's zone, audienced to that customer's tickets.
// The data is a stand-in; the token check is real (Keycard's SDK).
import express from 'express';
import { TokenVerifier } from '@keycardai/oauth';
import { state } from './keycard.js';
import { customer } from './story.js';

const verifiers = new Map<string, TokenVerifier>();

export function ticketsRouter() {
  const router = express.Router();
  router.get('/support-api/tickets/:customer', async (req, res) => {
    const c = customer(String(req.params.customer));
    const zone = c && state.zone(c.key);
    if (!c || !zone) return res.status(404).json({ detail: 'No such Acme customer.' });
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token) return res.status(401).json({ detail: 'A Keycard token is required.' });
    const audience = zone.resources.tickets.identifier;
    const k = `${zone.issuer}|${audience}`;
    if (!verifiers.has(k)) verifiers.set(k, new TokenVerifier({ issuer: zone.issuer, audience }));
    const ok = await verifiers.get(k)!.verifyToken(token).catch(() => null);
    if (!ok) return res.status(403).json({ detail: `That token isn’t for ${c.name}’s tickets.` });
    res.json({ detail: `${c.name}’s tickets (token verified)`, data: c.tickets });
  });
  return router;
}
