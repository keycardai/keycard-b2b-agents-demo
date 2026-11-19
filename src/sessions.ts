// Acme's own app: each customer's person signs in to Acme through their company's Keycard zone (and
// their company's IdP), and Acme's app hands them to an agent by token exchange. All through Keycard's
// SDK: web sign-in with PKCE, refresh, and RFC 8693 token exchange. Sessions are kept in memory only,
// so restarting the app signs everyone out.
import * as jose from 'jose';
import { TokenExchangeClient, OAuthError, beginAuthorization, completeAuthorization, refreshAuthorization } from '@keycardai/oauth';
import { state, type ZoneRec } from './keycard.js';
import { callbackUrl } from './provision.js';
import { customer, type Customer, type CustomerKey } from './story.js';

interface Session { accessToken: string; refreshToken?: string; expiresAt: number }
const sessions = new Map<CustomerKey, Session>();
const pending = new Map<string, { customer: CustomerKey; codeVerifier: string; exp: number }>();

export const signedIn = (c: Customer) => sessions.has(c.key);
export const signOut = (c: Customer) => sessions.delete(c.key);
const need = (c: Customer) => { const z = state.zone(c.key); if (!z) throw new Error(`${c.name} isn’t built in Keycard yet.`); return z; };

/** Where the person goes to sign in: Acme's sign-in app in their own company's zone. */
export async function loginUrl(c: Customer) {
  const z = need(c);
  const begin = await beginAuthorization(z.issuer, {
    clientId: z.apps.portal.clientId, redirectUri: callbackUrl(),
    resources: [z.resources['agent:portal'].identifier], scopes: ['openid', 'email', 'profile'],
  });
  pending.set(begin.state, { customer: c.key, codeVerifier: begin.codeVerifier, exp: Date.now() + 10 * 60_000 });
  // prompt=login: Keycard asks the customer's IdP again, so each sign-in is that customer's own.
  const u = new URL(begin.url);
  u.searchParams.set('prompt', 'login');
  return u.toString();
}

export async function completeLogin(params: Record<string, string>) {
  const p = pending.get(params.state ?? '');
  pending.delete(params.state ?? '');
  if (!p || p.exp < Date.now()) throw new Error('Sign-in expired. Try again.');
  const c = customer(p.customer)!;
  const z = need(c);
  const t = await completeAuthorization(z.issuer, {
    callbackParams: params, state: params.state, codeVerifier: p.codeVerifier,
    clientId: z.apps.portal.clientId, clientSecret: z.apps.portal.clientSecret, redirectUri: callbackUrl(),
  });
  const sub = jose.decodeJwt(t.accessToken).sub;
  if (sub !== c.person.email) throw new Error(`Expected ${c.person.email}, but the sign-in came back as ${sub}.`);
  sessions.set(c.key, { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: Date.now() + (t.expiresIn ?? 300) * 1000 });
  return c;
}

/** The person's current token for Acme's sign-in app, renewed through Keycard when it's close to expiring. */
async function subjectToken(c: Customer, z: ZoneRec) {
  const s = sessions.get(c.key);
  if (!s) throw new SignInRequired(c);
  if (s.expiresAt - 15_000 > Date.now()) return s.accessToken;
  if (!s.refreshToken) { sessions.delete(c.key); throw new SignInRequired(c); }
  try {
    const t = await refreshAuthorization(z.issuer, { refreshToken: s.refreshToken, clientId: z.apps.portal.clientId, clientSecret: z.apps.portal.clientSecret });
    sessions.set(c.key, { accessToken: t.accessToken, refreshToken: t.refreshToken ?? s.refreshToken, expiresAt: Date.now() + (t.expiresIn ?? 300) * 1000 });
    return t.accessToken;
  } catch (e) {
    sessions.delete(c.key);
    throw new SignInRequired(c, e instanceof OAuthError ? e.message : (e as Error).message);
  }
}

export class SignInRequired extends Error {
  constructor(readonly customer: Customer, why?: string) { super(`${customer.person.name} needs to sign in${why ? ` (${why})` : ''}.`); }
}

const exchangers = new Map<string, TokenExchangeClient>();
/** Acme's sign-in app hands the person to one place (an agent's front door, or its gateway). */
export async function handTo(c: Customer, resource: string) {
  const z = need(c);
  const subject = await subjectToken(c, z);
  const k = `${z.issuer}|${z.apps.portal.clientId}`;
  if (!exchangers.has(k)) exchangers.set(k, new TokenExchangeClient(z.issuer, { clientId: z.apps.portal.clientId, clientSecret: z.apps.portal.clientSecret }));
  try {
    return { ok: true as const, token: (await exchangers.get(k)!.exchangeToken({ subjectToken: subject, resource })).accessToken };
  } catch (e) {
    return { ok: false as const, detail: e instanceof OAuthError ? e.message : (e as Error).message };
  }
}
