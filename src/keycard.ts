// Keycard Management API client, and what this repo remembers about the zones it built.
// State lives in .state/ (gitignored): zone ids, the apps' client secrets Keycard issued, and
// each customer's choices in Acme's settings. Delete it with `npm run teardown`.
import fs from 'node:fs';
import path from 'node:path';
import KeycardAPI from '@keycardai/api';
import type { AgentKey, CustomerKey, WorkTool } from './story.js';

/** Zones this repo creates carry this tag in their description, so nothing else in the org is touched. */
export const TAG = '[keycard-b2b-agents-demo]';
export const PORT = Number(process.env.PORT ?? 4747);
export const CONSOLE = process.env.KEYCARD_CONSOLE_URL ?? 'https://console.keycard.ai';

let client: KeycardAPI | null = null;
export function api(): KeycardAPI {
  const { KEYCARD_CLIENT_ID, KEYCARD_CLIENT_SECRET, KEYCARD_API_BASE_URL } = process.env;
  if (!(KEYCARD_CLIENT_ID && KEYCARD_CLIENT_SECRET)) {
    throw new Error('Set KEYCARD_CLIENT_ID and KEYCARD_CLIENT_SECRET in .env (a service account from your Keycard org). See README.');
  }
  return client ??= new KeycardAPI({
    clientID: KEYCARD_CLIENT_ID, clientSecret: KEYCARD_CLIENT_SECRET,
    baseURL: KEYCARD_API_BASE_URL || undefined, maxRetries: 2,
  });
}

export interface AppRec { id: string; identifier: string; clientId: string; clientSecret: string }
export interface ZoneRec {
  zoneId: string;
  orgId: string;
  name: string;
  issuer: string;
  idpProviderId: string;
  /** The customer's sign-in address Keycard was given (it moves with the tunnel) */
  idpIssuer: string;
  apps: { support: AppRec; portal: AppRec };
  /** tickets, work (Acme Work), agent:support and agent:portal (what people sign in to and hand work to) */
  resources: Record<string, { id: string; identifier: string }>;
  gateways: Record<AgentKey, { appId: string; resourceId: string; url: string }>;
  policySetId: string;
  schemaVersion: string;
  /** Rule id → Keycard policy and the version in use */
  policies: Record<string, { policyId: string; versionId: string; cedar: string }>;
  /** The customer's choices in Acme's settings */
  allowed: Record<AgentKey, WorkTool[]>;
  off: AgentKey[];
}
export interface State {
  publicUrl?: string;
  zones: Partial<Record<CustomerKey, ZoneRec>>;
}

const DIR = path.resolve(process.env.STATE_DIR ?? '.state');
const FILE = path.join(DIR, 'zones.json');
export const state = {
  read: (): State => fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : { zones: {} },
  write: (s: State) => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 }); },
  zone: (key: string) => state.read().zones[key as CustomerKey],
  saveZone: (key: CustomerKey, z: ZoneRec) => { const s = state.read(); s.zones[key] = z; state.write(s); },
  clear: () => fs.rmSync(FILE, { force: true }),
  file: (name: string) => { fs.mkdirSync(DIR, { recursive: true }); return path.join(DIR, name); },
};

/** Every zone in the org that this repo created. */
export async function listDemoZones() {
  const out: { id: string; name: string }[] = [];
  let after: string | undefined;
  do {
    const page = await api().zones.list({ limit: 100, ...(after ? { after } : {}) });
    for (const z of page.items) if (z.description?.startsWith(TAG)) out.push({ id: z.id, name: z.name });
    after = page.pagination?.after_cursor ?? undefined;
  } while (after);
  return out;
}

/** Deep links into the Keycard Console for one customer's zone. */
export function consoleLinks(z: ZoneRec) {
  const zone = `${CONSOLE}/orgs/${z.orgId}/zones/${z.zoneId}`;
  return {
    zone, audit: `${zone}/audit`, policies: `${zone}/policies`, policySet: `${zone}/policy-sets/${z.policySetId}`,
    applications: `${zone}/applications`, resources: `${zone}/resources`, providers: `${zone}/providers`,
  };
}

/** One readable line for an API error. */
export function describeError(e: unknown): string {
  if (e instanceof KeycardAPI.APIError) {
    const body = e.error as { message?: string; details?: unknown } | undefined;
    return `Keycard API ${e.status}: ${body?.message ?? e.message}${body?.details ? ` ${JSON.stringify(body.details)}` : ''}`;
  }
  return (e as Error)?.message ?? String(e);
}
