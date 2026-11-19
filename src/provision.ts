// Build each customer's Keycard zone, the way Acme would onboard a new customer through Keycard's
// Management API: its IdP, its people's sign-in to Acme, Acme's agents as applications, a gateway per
// agent in front of Acme Work, and the customer's own policies. A zone is built once and kept; a new
// public URL only moves the addresses Keycard holds for this machine.
import { api, describeError, listDemoZones, state, TAG, PORT, type AppRec, type ZoneRec } from './keycard.js';
import { activate, pickSchema, publishRules, rulesFor } from './policies.js';
import { idpClient, idpName, issuerFor } from './idp.js';
import { workUrl } from './acme-work.js';
import { AGENTS, CUSTOMERS, VENDOR, gatewayName, type Customer } from './story.js';

export type Log = (line: string) => void;
export const callbackUrl = () => `http://localhost:${PORT}/auth/callback`;
const ticketsId = (c: Customer) => `https://support.acme.example/tickets/${c.key}`;
const frontDoor = (c: Customer, name: string) => `https://${name}.agents.${c.domain}`;

/** Build missing zones, and point existing ones at this machine's current public URL. */
export async function ensureZones(publicUrl: string, log: Log) {
  const s = state.read();
  const known = new Set(Object.values(s.zones).map(z => z!.zoneId));
  const inOrg = await listDemoZones();
  // Zones from an earlier copy of this repo whose .state is gone can't be reused: their client secrets are lost.
  for (const z of inOrg.filter(z => !known.has(z.id))) {
    log(`Deleting a leftover demo zone “${z.name}” (${z.id})`);
    await api().zones.delete(z.id);
  }
  for (const c of CUSTOMERS) {
    const z = state.zone(c.key);
    if (z && inOrg.some(x => x.id === z.zoneId)) await syncZone(c, z, publicUrl, log);
    else state.saveZone(c.key, await buildZone(c, publicUrl, log));
  }
}

async function buildZone(c: Customer, publicUrl: string, log: Log): Promise<ZoneRec> {
  const k = api();
  const name = `${VENDOR} customer · ${c.name}`;
  log(`Creating zone “${name}”`);
  const zone = await k.zones.create({ name, description: `${TAG} ${c.name}, a customer of ${VENDOR}: its people use ${VENDOR}’s agents, governed by ${c.name}’s own policies.` });
  const zoneId = zone.id;
  await makeAdminsManagers(zoneId, zone.organization_id, log);
  const sts = (await k.zones.providers.list(zoneId, { 'filter[type]': 'keycard-sts' })).items[0];
  if (!sts) throw new Error(`Zone ${zoneId} has no keycard-sts provider`);

  // The customer's own IdP signs its people in, matched on their email.
  const idpIssuer = issuerFor(c, publicUrl);
  log(`  Sign-in: ${idpName(c)} (${idpIssuer})`);
  const idp = await k.zones.providers.create(zoneId, {
    identifier: idpIssuer, name: idpName(c), description: `${c.name}’s corporate IdP (served by this demo)`,
    client_id: idpClient(c).clientId, client_secret: idpClient(c).clientSecret,
    protocols: { oauth2: { issuer: idpIssuer }, openid: { user_identifier_claim: 'email' } },
  } as never);
  await k.zones.update(zoneId, { user_identity_provider_id: idp.id });

  const resources: ZoneRec['resources'] = {};
  // The tickets live in Acme's service, but each customer's are a Keycard resource in that customer's zone only.
  log(`  Resource: ${c.name} support tickets`);
  const tickets = await k.zones.resources.create(zoneId, {
    identifier: ticketsId(c), name: `${c.name} support tickets`, description: `${c.name}’s tickets in Acme Support`,
    credential_provider_id: sts.id, credential_lifetime_seconds: 300,
  });
  resources.tickets = { id: tickets.id, identifier: ticketsId(c) };

  const app = async (key: 'support' | 'portal', o: { identifier: string; name: string; description: string; deps: string[]; front: string }): Promise<AppRec> => {
    log(`  Application: ${o.name}`);
    const a = await k.zones.applications.create(zoneId, {
      identifier: o.identifier, name: o.name, description: o.description, consent: 'implicit',
      protocols: { oauth2: { redirect_uris: [callbackUrl()] } },
    });
    // Dependencies passed at create time aren't registered; add each one.
    for (const id of o.deps) await k.zones.applications.dependencies.add(id, { zoneId, id: a.id });
    const cred = await k.zones.applicationCredentials.create(zoneId, { type: 'password', application_id: a.id });
    // Its front door: what people sign in to, and what other apps hand people to.
    const r = await k.zones.resources.create(zoneId, {
      identifier: o.front, name: o.name, description: 'What people sign in to; the app then acts for them',
      application_id: a.id, credential_provider_id: sts.id, credential_lifetime_seconds: 300,
    });
    resources[`agent:${key}`] = { id: r.id, identifier: o.front };
    return { id: a.id, identifier: o.identifier, clientId: cred.identifier, clientSecret: cred.type === 'password' ? cred.password ?? '' : '' };
  };
  const support = await app('support', {
    identifier: 'agent:acme-support', name: 'Acme Support Agent', deps: [tickets.id], front: frontDoor(c, 'acme-support'),
    description: `The support agent ${VENDOR} sells. In ${c.name}’s zone it has its own credential, separate from every other customer’s.`,
  });
  const portal = await app('portal', {
    identifier: `app:${c.key}-sign-in`, name: `${c.name} sign-in to ${VENDOR}`, deps: [resources['agent:support'].id], front: frontDoor(c, `${c.key}-sign-in`),
    description: `Where ${c.name}’s people sign in to ${VENDOR}; it hands their identity to ${VENDOR}’s agents.`,
  });

  // Acme Work, protected by this customer's own zone, behind each agent's own gateway.
  const url = workUrl(publicUrl, c.key);
  log(`  Resource: Acme Work → ${url}`);
  const work = await k.post(`/zones/${zoneId}/resources`, { body: {
    name: 'Acme Work', identifier: url, credential_provider_id: sts.id, prefix: true,
    traits: ['mcp-server'], supported_actions: [{ type: 'mcp', action: 'tools/call' }],
  } }) as { id: string };
  resources.work = { id: work.id, identifier: url };
  const events = (await k.zones.resources.list(zoneId, { limit: 100 } as never)).items.find(r => r.identifier.endsWith('.keycard.cloud/events'));
  const gateways = {} as ZoneRec['gateways'];
  for (const a of AGENTS) {
    // Built the way the Console builds a gateway. The typed SDK doesn't model gateways yet, so these are raw calls.
    const base = `https://unified-${a.slug}-${zoneId}.mcp.gateway.context.cloud`;
    const gw = `${base}/mcp`;
    log(`  Gateway: ${gatewayName(a)} → ${gw}`);
    const gApp = await k.post(`/zones/${zoneId}/applications`, { body: { name: gatewayName(a), identifier: gw, consent: 'implicit', traits: ['unified-gateway', 'mcp-server'] } }) as { id: string };
    await k.post(`/zones/${zoneId}/application-credentials`, { body: { application_id: gApp.id, type: 'url', identifier: `${base}/oauth_client` } });
    const gRes = await k.zones.resources.create(zoneId, { identifier: gw, name: gatewayName(a), application_id: gApp.id, credential_provider_id: sts.id, prefix: true });
    for (const id of [work.id, ...(events ? [events.id] : [])]) await k.zones.applications.dependencies.add(id, { zoneId, id: gApp.id });
    // The sign-in app hands people to each gateway.
    await k.zones.applications.dependencies.add(gRes.id, { zoneId, id: portal.id });
    gateways[a.key] = { appId: gApp.id, resourceId: gRes.id, url: gw };
  }

  const z: ZoneRec = {
    zoneId, orgId: zone.organization_id, name, issuer: zone.protocols.oauth2.issuer, idpProviderId: idp.id, idpIssuer,
    apps: { support, portal }, resources, gateways,
    policySetId: '', schemaVersion: await pickSchema(zoneId), policies: {},
    allowed: Object.fromEntries(AGENTS.map(a => [a.key, [...a.defaults]])) as ZoneRec['allowed'], off: [],
  };
  state.saveZone(c.key, z); // saved before policies, so a failure here can still be torn down
  const rules = rulesFor(c, z);
  log(`  Policies: ${rules.filter(r => !r.standby).map(r => r.name).join('; ')}`);
  await publishRules(z, rules);
  z.policySetId = (await k.zones.policySets.create(zoneId, { name: `${c.name} policies`, target_type: 'zone' })).id;
  await activate(z, rules);
  return z;
}

/** A new public URL (quick tunnels change): move the customer's IdP and Acme Work to it. */
async function syncZone(c: Customer, z: ZoneRec, publicUrl: string, log: Log) {
  const k = api();
  const iss = issuerFor(c, publicUrl);
  if (z.idpIssuer !== iss) {
    log(`${c.name}: sign-in moves to ${iss}`);
    await k.zones.providers.update(z.idpProviderId, { zoneId: z.zoneId, identifier: iss, protocols: { oauth2: { issuer: iss } } } as never);
    // People Keycard created under the old address can't sign in again until it re-creates them.
    const users = (await k.zones.users.list(z.zoneId, { limit: 100 } as never)).items as { id: string; issuer?: string; provider_id?: string }[];
    for (const u of users.filter(u => u.provider_id === z.idpProviderId && u.issuer && u.issuer !== iss)) {
      await k.delete(`/zones/${z.zoneId}/users/${u.id}`);
    }
    z.idpIssuer = iss;
  }
  const url = workUrl(publicUrl, c.key);
  if (z.resources.work.identifier !== url) {
    log(`${c.name}: Acme Work moves to ${url}`);
    await k.zones.resources.update(z.resources.work.id, { zoneId: z.zoneId, identifier: url });
    z.resources.work.identifier = url;
  }
  // Policies changed in this repo since the zone was built get a new version.
  const rules = rulesFor(c, z);
  const changed = await publishRules(z, rules);
  if (changed.length) { log(`${c.name}: updated policies ${changed.join('; ')}`); await activate(z, rules); }
  state.saveZone(c.key, z);
}

/** Put a customer back to the start: default tools, every agent on. */
export async function resetCustomer(c: Customer) {
  const z = state.zone(c.key)!;
  z.allowed = Object.fromEntries(AGENTS.map(a => [a.key, [...a.defaults]])) as ZoneRec['allowed'];
  z.off = [];
  const rules = rulesFor(c, z);
  await publishRules(z, rules);
  await activate(z, rules);
  state.saveZone(c.key, z);
}

/**
 * Make the org's admins Managers of the new zone, as the Console does for whoever creates a zone.
 * Without it, a zone created by a service account shows admins only the audit log.
 */
async function makeAdminsManagers(zoneId: string, orgId: string, log: Log) {
  const k = api();
  const platformZoneId = (await k.organizations.retrieve(orgId)).zone_id;
  const users = await k.zones.users.list(platformZoneId, { 'expand[]': 'role-assignments' });
  for (const u of users.items) {
    const roles = (u.role_assignments ?? []) as { role_identifier: string; scope: { id?: string } | null }[];
    if (!roles.some(r => r.role_identifier === 'admin' && r.scope === null)) continue;
    await k.post(`/zones/${platformZoneId}/users/${encodeURIComponent(u.identifier)}/roles`, {
      body: { role_identifier: 'admin', owner_type: 'platform', scope_type: 'zone', scope_id: zoneId },
    }).then(() => log(`  Console access: ${u.email} manages this zone`), e => log(`  (couldn’t make ${u.email} a Manager: ${describeError(e)})`));
  }
}
