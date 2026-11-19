// Each customer's own Keycard policies. Nothing here keeps customers apart: separate zones do that.
// What these do: each customer decides, per Acme agent, which Acme Work tools it may use, and can
// switch an agent off for its people. Acme's settings page changes them through the Management API.
// Every rule is its own named Keycard policy, so the Console reads like the settings page.
import { api, type ZoneRec } from './keycard.js';
import { AGENTS, WORK_TOOLS, gatewayName, toolLabel, type Agent, type Customer } from './story.js';

export interface Rule { id: string; name: string; description: string; cedar: string; standby?: boolean }
const rule = (id: string, name: string, description: string, body: string, standby = false): Rule =>
  ({ id, name, description, cedar: `@id("${id}")\n${body.trim()}`, standby });

export const ruleIds = {
  off: (a: Agent) => `switch-off-${a.key}`,
  tools: (a: Agent) => `acme-work-tools-${a.key}`,
};

export function rulesFor(c: Customer, z: Pick<ZoneRec, 'allowed'>): Rule[] {
  return [
    // Same intent as Keycard's managed defaults, under names that read well.
    rule('people-use-their-own-access', 'People use their own access',
      'Signed-in people may access resources in this zone directly.',
      'permit (principal is Keycard::User, action, resource);'),
    rule('agents-act-for-signed-in-people', 'Agents act for signed-in people',
      'An agent may request access on behalf of the person it acts for. The forbid rules below narrow this.',
      'permit (principal is Keycard::Application, action, resource)\nwhen { context.on_behalf == true };'),
    rule('agents-reach-only-their-dependencies', 'Agents reach only their dependencies',
      'With no person involved, an agent may only access resources registered as its dependencies.',
      `permit (principal is Keycard::Application, action, resource)
when { principal.dependencies.contains(resource) && context.on_behalf == false && context.impersonate == false };`),
    // Kill switches: published, but in the active set only while the customer has the agent switched off.
    // The agent's own application and its Acme Work gateway both start with its name.
    ...AGENTS.map(a => rule(ruleIds.off(a), `${a.name} is switched off`,
      `${c.name}’s own switch, set by ${c.name}’s admin in Acme’s settings. While this policy is in ${c.name}’s active set, Keycard refuses the ${a.name} for ${c.name}’s people, everywhere it works, and every refusal names this policy. Other customers are unaffected.`, `
forbid (principal is Keycard::Application, action, resource)
when { principal.name like "${a.name}*" };`, true)),
    // An allowlist per agent, at its gateway: the token exchange itself ("any") and MCP's own protocol
    // traffic, plus the tools the customer allowed, each named as its action.
    ...AGENTS.map(a => {
      const allowed = z.allowed[a.key] ?? [];
      return rule(ruleIds.tools(a), `${a.name} may use only the Acme Work tools ${c.name} allows`,
        `${c.name}’s admin chose these in Acme’s settings: ${allowed.length ? allowed.map(toolLabel).join(', ') : 'none'}. Every other Acme Work tool, including any Acme adds later, is refused for this agent at ${c.name}.`, `
forbid (principal is Keycard::Application, action, resource)
when { principal.name == "${gatewayName(a)}" }
unless {
  action == Keycard::Action::"any" ||
  action in Keycard::Action::"MCPProtocol"${allowed.map(t => ` ||\n  action == Keycard::Action::"mcp::tools/call::${t}"`).join('')}
};`);
    }),
  ];
}

/** Per-tool gateway rules (mcp::tools/call::…) need schema 2026-06-18; use it when the zone offers it. */
export async function pickSchema(zoneId: string) {
  const items = (await api().zones.policySchemas.list(zoneId)).items;
  const s = items.find(x => x.version === '2026-06-18') ?? items.find(x => x.is_default) ?? items[0];
  if (!s) throw new Error('No Cedar schema version available for this zone');
  return s.version;
}

/** Bring the zone's policies in line with rulesFor: new rules are created, changed ones get a new version. Returns the names that changed. */
export async function publishRules(z: ZoneRec, rules: Rule[]) {
  const changed: string[] = [];
  const squash = (s: string) => s.replace(/\s+/g, '');
  for (const r of rules) {
    const p = z.policies[r.id];
    if (p && squash(p.cedar) === squash(r.cedar)) continue;
    const policyId = p?.policyId ?? (await api().zones.policies.create(z.zoneId, { name: r.name, description: r.description })).id;
    if (p) await api().zones.policies.update(policyId, { zone_id: z.zoneId, name: r.name, description: r.description });
    const v = await api().zones.policies.versions.create(policyId, { zone_id: z.zoneId, schema_version: z.schemaVersion, cedar_raw: r.cedar });
    z.policies[r.id] = { policyId, versionId: v.id, cedar: r.cedar };
    changed.push(r.name);
  }
  return changed;
}

/**
 * Make the zone's active policy set hold every rule except kill switches that are off. Keycard keeps one
 * set version per manifest, so a manifest it already has (switching back on, say) is made active again.
 */
export async function activate(z: ZoneRec, rules: Rule[]) {
  const live = rules.filter(r => !r.standby || z.off.some(k => r.id === `switch-off-${k}`));
  const entries = live.map(r => ({ policy_id: z.policies[r.id].policyId, policy_version_id: z.policies[r.id].versionId }));
  const key = (es: { policy_version_id: string }[]) => es.map(e => e.policy_version_id).sort().join(',');
  const versions = await api().zones.policySets.versions.list(z.policySetId, { zone_id: z.zoneId } as never) as unknown as
    { items: { id: string; version: number; active?: boolean; manifest?: { entries: { policy_version_id: string }[] } }[] };
  const v = versions.items.find(x => key(x.manifest?.entries ?? []) === key(entries))
    ?? await api().zones.policySets.versions.create(z.policySetId, { zone_id: z.zoneId, schema_version: z.schemaVersion, manifest: { entries } }) as { id: string; version: number; active?: boolean };
  if (!v.active) await api().zones.policySets.versions.update(v.id, { zone_id: z.zoneId, policy_set_id: z.policySetId, active: true });
  return v.version;
}

export const TOOL_NAMES = WORK_TOOLS.map(t => t.name);
