// What Keycard itself recorded: a customer zone's credential decisions, from the Management API's
// events (the same records the Console's audit log shows). Acme's settings page shows them as the
// customer's History, and the app uses them to name the policy behind a refusal.
import { api, consoleLinks, state } from './keycard.js';
import { AGENTS, gatewayName, type Customer } from './story.js';

export interface Decision {
  at: string; ok: boolean; person: string | null; agent: string | null; resource: string | null;
  tool: string | null; policy: string | null; message: string | null; link: string | null;
}
interface KeycardEvent {
  zone_id?: string; occurred_at: string;
  actor?: { identities?: { id: string; type: string }[] };
  entity?: { attributes?: Record<string, unknown>; credential_provider?: string; scopes?: string[] };
  request?: { request_id?: string };
  state?: { status?: string; message?: string };
}
const DENIED_BY = /denied by Polic(?:y|ies) "([^"]+)"/;

/** Credential decisions in a customer's zone since a moment, newest first. Sign-ins are left out. */
export async function decisionsSince(c: Customer, since: string): Promise<Decision[]> {
  const z = state.zone(c.key);
  if (!z) return [];
  const k = api();
  const page = await k.get(`/zones/${z.zoneId}/events?limit=100&order=desc&filter[action][0]=credentials:issue`) as { items: KeycardEvent[] };
  const from = Date.parse(since);
  const events = page.items.filter(e => e.zone_id === z.zoneId && Date.parse(e.occurred_at) >= from && !(e.entity?.scopes ?? []).includes('openid'));
  if (!events.length) return [];
  const [users, apps] = await Promise.all([
    k.zones.users.list(z.zoneId, { limit: 100 } as never).then(r => r.items as { id: string; email?: string }[]).catch(() => []),
    k.zones.applications.list(z.zoneId, { limit: 100 } as never).then(r => r.items as { id: string; name?: string }[]).catch(() => []),
  ]);
  const audit = consoleLinks(z).audit;
  // Behind a gateway the calling application is the gateway; show the agent it belongs to.
  const agentOf = (name?: string) => AGENTS.find(a => name === gatewayName(a))?.name ?? name ?? null;
  return events.map(e => {
    const ids = e.actor?.identities ?? [];
    const message = e.state?.message ?? null;
    const attrs = e.entity?.attributes ?? {};
    const rid = e.request?.request_id;
    return {
      at: e.occurred_at,
      ok: e.state?.status === 'success',
      person: users.find(u => u.id === ids.find(i => i.type === 'user')?.id)?.email ?? null,
      agent: agentOf(apps.find(a => a.id === ids.find(i => i.type === 'application')?.id)?.name),
      resource: (attrs.resource_display_name as string | undefined) ?? e.entity?.credential_provider ?? null,
      // Allowed gateway calls name the tool in the request's authorization details; refusals name it in the message.
      tool: (attrs.authorization_details as { name?: string }[] | undefined)?.find(d => d.name)?.name
        ?? /Action "mcp::tools\/call::([^"]+)"/.exec(message ?? '')?.[1] ?? null,
      policy: (message && DENIED_BY.exec(message)?.[1]) ?? null,
      message,
      link: rid ? `${audit}?requestId=${encodeURIComponent(rid)}` : audit,
    };
  });
}
