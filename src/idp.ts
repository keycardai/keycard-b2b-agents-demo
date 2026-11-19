// A tiny OIDC identity provider for each customer, standing in for Globex's and Initech's own
// corporate IdPs. Each customer's Keycard zone signs its people in here. In a real deployment each
// customer brings its own IdP (Okta, Entra, Google...) and nothing else changes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import * as jose from 'jose';
import { state } from './keycard.js';
import { customer, type Customer } from './story.js';

const KEYS = state.file('idp.json');
function secrets(): { clientSecret: string; jwk: jose.JWK } {
  if (fs.existsSync(KEYS)) return JSON.parse(fs.readFileSync(KEYS, 'utf8'));
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...(privateKey.export({ format: 'jwk' }) as jose.JWK), kid: crypto.randomBytes(8).toString('hex'), alg: 'RS256', use: 'sig' };
  const s = { clientSecret: crypto.randomBytes(24).toString('base64url'), jwk };
  fs.writeFileSync(KEYS, JSON.stringify(s), { mode: 0o600 });
  return s;
}
const publicJwk = (): jose.JWK => { const { kty, n, e, kid, alg, use } = secrets().jwk; return { kty, n, e, kid, alg, use }; };

export const idpName = (c: Customer) => `${c.name} IdP`;
export const issuerFor = (c: Customer, publicUrl: string) => `${publicUrl.replace(/\/$/, '')}/idp/${c.key}`;
/** The client each customer's zone uses to talk to its IdP. */
export const idpClient = (c: Customer) => ({ clientId: `keycard-zone-${c.key}`, clientSecret: secrets().clientSecret });

interface Code { customer: string; email: string; redirectUri: string; nonce?: string; challenge?: string; scope: string; exp: number }
const codes = new Map<string, Code>();
const esc = (s: string) => s.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);

/** Sign-in codes go back only to the customer's own Keycard zone. */
const allowedRedirect = (c: Customer, uri: string) => {
  const z = state.zone(c.key);
  return !!z && uri === `${z.issuer.replace(/\/$/, '')}/oauth/2/redirect`;
};

export function idpRouter() {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));
  const of = (req: express.Request) => customer(String(req.params.customer));
  const iss = (c: Customer) => issuerFor(c, state.read().publicUrl ?? '');

  router.get('/idp/:customer/.well-known/openid-configuration', (req, res) => {
    const c = of(req); if (!c) return res.sendStatus(404);
    const i = iss(c);
    res.json({
      issuer: i, authorization_endpoint: `${i}/authorize`, token_endpoint: `${i}/token`, userinfo_endpoint: `${i}/userinfo`, jwks_uri: `${i}/jwks`,
      response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: ['openid', 'profile', 'email'], token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      claims_supported: ['sub', 'email', 'email_verified', 'name'], code_challenge_methods_supported: ['S256'], grant_types_supported: ['authorization_code'],
    });
  });
  router.get('/idp/:customer/jwks', (req, res) => of(req) ? res.json({ keys: [publicJwk()] }) : res.sendStatus(404));

  // The customer's sign-in screen: one person per customer, so it continues as them, as an IdP with a session would.
  router.get('/idp/:customer/authorize', (req, res) => {
    const c = of(req); if (!c) return res.sendStatus(404);
    const q = req.query as Record<string, string>;
    if (q.client_id !== idpClient(c).clientId) return res.status(400).send('unknown client_id');
    if (!allowedRedirect(c, String(q.redirect_uri ?? ''))) return res.status(400).send(`redirect_uri is not ${c.name}’s Keycard zone`);
    const hidden = Object.entries(q).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(String(v))}">`).join('');
    const p = c.person;
    res.type('html').send(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(idpName(c))}</title>
<style>body{font:15px system-ui;background:#f4f4f2;color:#141413;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
form{background:#fff;border:1px solid #ddd;border-radius:12px;padding:24px;width:min(420px,100%)}h1{font-size:18px;margin:0 0 4px}p{color:#666;margin:0 0 16px}
button{display:grid;gap:2px;width:100%;text-align:left;padding:12px;border:2px solid #141413;border-radius:8px;background:#fff;font:inherit;cursor:pointer}span{font-size:12px;color:#666}</style>
<form method="post" action="authorize">${hidden}<h1>${esc(idpName(c))}</h1><p>Signing in…</p>
<button name="login_email" value="${esc(p.email)}" autofocus><b>${esc(p.name)}</b><span>${esc(p.email)}</span></button></form>
<script>setTimeout(()=>document.querySelector('button').click(),400)</script>`);
  });

  router.post('/idp/:customer/authorize', (req, res) => {
    const c = of(req); if (!c) return res.sendStatus(404);
    const b = req.body as Record<string, string>;
    if (b.client_id !== idpClient(c).clientId || !allowedRedirect(c, b.redirect_uri ?? '') || b.login_email !== c.person.email) {
      return res.status(400).send('Invalid sign-in request.');
    }
    const code = crypto.randomBytes(24).toString('base64url');
    codes.set(code, { customer: c.key, email: b.login_email, redirectUri: b.redirect_uri, nonce: b.nonce, challenge: b.code_challenge, scope: b.scope ?? 'openid', exp: Date.now() + 120_000 });
    const u = new URL(b.redirect_uri);
    u.searchParams.set('code', code);
    if (b.state) u.searchParams.set('state', b.state);
    res.redirect(302, u.toString());
  });

  router.post('/idp/:customer/token', async (req, res) => {
    const c = of(req); if (!c) return res.sendStatus(404);
    const b = req.body as Record<string, string>;
    let id = b.client_id, secret = b.client_secret;
    const auth = req.headers.authorization;
    if (auth?.startsWith('Basic ')) [id, secret] = Buffer.from(auth.slice(6), 'base64').toString().split(':').map(decodeURIComponent);
    const client = idpClient(c);
    if (id !== client.clientId || secret !== client.clientSecret) return res.status(401).json({ error: 'invalid_client' });
    if (b.grant_type !== 'authorization_code') return res.status(400).json({ error: 'unsupported_grant_type' });
    const p = codes.get(b.code); codes.delete(b.code);
    if (!p || p.exp < Date.now() || p.customer !== c.key || p.redirectUri !== b.redirect_uri) return res.status(400).json({ error: 'invalid_grant' });
    if (p.challenge && crypto.createHash('sha256').update(b.code_verifier ?? '').digest('base64url') !== p.challenge) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE' });
    }
    const idToken = await new jose.SignJWT({ email: p.email, email_verified: true, name: c.person.name, ...(p.nonce ? { nonce: p.nonce } : {}) })
      .setProtectedHeader({ alg: 'RS256', kid: secrets().jwk.kid })
      .setIssuer(iss(c)).setSubject(p.email).setAudience(id).setIssuedAt().setExpirationTime('10m')
      .sign(await jose.importJWK(secrets().jwk, 'RS256'));
    res.json({ token_type: 'Bearer', access_token: idToken, id_token: idToken, expires_in: 600, scope: p.scope });
  });

  router.get('/idp/:customer/userinfo', async (req, res) => {
    const c = of(req); if (!c) return res.sendStatus(404);
    try {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const { payload } = await jose.jwtVerify(token, await jose.importJWK(publicJwk(), 'RS256'), { issuer: iss(c) });
      if (payload.sub !== c.person.email) throw new Error('unknown');
      res.json({ sub: payload.sub, email: payload.sub, email_verified: true, name: c.person.name });
    } catch { res.status(401).json({ error: 'invalid_token' }); }
  });
  return router;
}
