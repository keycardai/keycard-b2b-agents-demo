# Keycard: your agents, your customers' rules

A SaaS vendor, **Acme**, sells AI agents to its customers. Two customers, **Globex** and **Initech**, each get their own Keycard zone with their own sign-in, people and policies. This repo builds both zones in **your** Keycard org and runs Acme's app on your laptop, so you can try it yourself:

- **One agent, many customers, no leaks.** The Acme Support Agent is one service registered in both customers' zones. It has a deliberate multi-tenant bug: asked to compare with Initech, it uses its Initech credential with Gina-from-Globex's token. Initech's zone refuses, because a token from Globex's zone means nothing there. No policy had to anticipate the bug.
- **Each customer governs your agents, per agent and per tool.** Each agent reaches Acme Work (an MCP server) through its own Keycard gateway in each customer's zone. Globex lets the Marketing Agent upload attachments but not update projects; the Support Agent gets less. Tools nobody allowed, including ones Acme adds later, are refused.
- **Customers change the rules in your product, not in Keycard.** Acme's settings page (what a customer's admin sees) publishes new versions of that customer's policies through Keycard's Management API. Switch an agent off at Globex: Gina is refused on her next request, Ivan at Initech isn't.
- **Every decision is recorded,** in each customer's own audit log, naming the person, the agent, the tool and the policy.

Every Keycard decision is real. The IdPs, ticket data and Acme Work's data are stand-ins served by this app; the agents are real Claude agents built with Keycard's SDK.

## What you need

- **Node 22 or later.**
- **Your own Keycard org.** Sign up at [console.keycard.ai](https://console.keycard.ai), or ask your Keycard contact for one.
- **A service account in that org:** Console → **Settings → Service accounts** → create one, and copy its client ID and secret. The app uses it to build and change the zones, the way Acme's backend would.
- **An Anthropic API key** for the agents.
- **cloudflared** (`brew install cloudflared`), so Keycard can reach the customer IdPs and Acme Work on your laptop. Or set `PUBLIC_URL` to any stable https address that forwards to `localhost:4747`.

## Run it

```bash
git clone git@github.com:keycard-sandbox/keycard-b2b-agents-demo.git
cd keycard-b2b-agents-demo
npm install
cp .env.example .env
```

Fill in `.env` (service account and Anthropic key), then:

```bash
npm start
```

The first start opens a Cloudflare tunnel and builds two zones in your org, **Acme customer · Globex** and **Acme customer · Initech** (a minute or two). When it prints **✓ Ready**, open http://localhost:4747.

Later starts reuse the zones. If the tunnel address changed, the app points Keycard at the new one, and you sign in again.

Your org's admins are made Managers of both zones, so they appear in the Console's zone switcher. To give a teammate access, invite them to your org in the Console.

## Try it

Open http://localhost:4747. Sign in as **Gina** (Globex) and **Ivan** (Initech): each goes through their own company's zone and IdP. Then, under **What Keycard decided**, every request shows each Keycard decision and links to the audit log.

1. **Gina → Support Agent: "Our open tickets."** Allowed, in Globex's zone. Ivan asks the same: allowed, in Initech's.
2. **Gina → Support Agent: "Compare with Initech."** Globex's tickets come back; Initech's zone refuses the agent's request with Gina's token.
3. **Gina → Marketing Agent: "Upload the brief"** (allowed), then **"Move the due date"** (refused, naming *Acme Marketing Agent may use only the Acme Work tools Globex allows*). The refused call never reaches Acme Work.
4. **Gina → Support Agent: "Upload the brief."** Refused: Globex gives each agent its own tools.
5. **Globex's settings** (link on Globex's card): set **Update projects** to **Allow** for the Marketing Agent. Gina's due-date change now works; Ivan's is still refused, because Initech made no such choice.
6. **Globex's settings:** switch the **Support Agent** off. Gina is refused, naming *Acme Support Agent is switched off*; Ivan isn't affected.
7. In the Console, use the zone switcher: each customer's **Policies** show a new policy-set version for each change, and each **Audit log** has only that customer's records.

**Put everything back** (top right) restores the default tools and switches every agent back on, for both customers.

## How it's built

| Piece | Where | What Keycard does |
| --- | --- | --- |
| Customer zones | `src/provision.ts` | One zone per customer, built through the Management API: its IdP, Acme's sign-in app, the Support Agent (own credential per zone), a gateway per agent, Acme Work and the tickets as resources, and the customer's policies |
| Customer IdPs | `src/idp.ts` | Stand-in OIDC IdPs for Globex and Initech. Swap in a real one (Okta, Entra, Google) by pointing the zone's provider at it |
| Acme's app | `src/server.ts`, `public/` | Signs each person in to their own zone (PKCE), then hands them to an agent by token exchange (RFC 8693) |
| Support Agent | `src/agents/support.ts` | Verifies the caller's token against its zone, exchanges it for that customer's tickets, and reaches Acme Work through its gateway. Contains the tenant bug on purpose |
| Marketing Agent | `src/agents/marketing.ts` | Holds no credentials; works only through its gateway |
| Acme Work | `src/acme-work.ts` | MCP server per customer that accepts only tokens from that customer's zone, for its own URL |
| Policies | `src/policies.ts` | Cedar, one named policy per rule: a per-agent tool allowlist and a per-agent kill switch, per customer |
| Settings page | `public/settings.html` | Acme's admin page for a customer. Each change publishes a new policy version and activates a new policy-set version |
| History | `src/audit.ts` | The customer zone's own decision records, from the Management API |

The story (customers, people, agents, tools, prompts) is in `src/story.ts`. Change it, run `npm run teardown`, and `npm start` builds it again.

## Clean up

```bash
npm run teardown
```

This deletes the zones this repo built (they're tagged `[keycard-b2b-agents-demo]` in their description; nothing else in your org is touched), forgets them locally, and stops the tunnel.

## Troubleshooting

- **"Set KEYCARD_CLIENT_ID…"**: `.env` is missing the service account.
- **Stuck on the tunnel**: quick tunnels sometimes take a minute. Run `npm start` again, or set `PUBLIC_URL`.
- **"needs to sign in"**: sessions are kept in memory, so restarting the app signs everyone out. Click **Sign in** on their card.
- **Something looks wrong in a zone**: `npm run teardown`, then `npm start` rebuilds everything from scratch.

Local state (zone ids, the app credentials Keycard issued, the IdP's signing key) is in `.state/`, which git ignores.
