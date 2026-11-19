// Acme Work: the product Acme's agents work in, as an MCP server. One per customer, served from this
// machine at https://<public url>/acme-work/<customer>/mcp. Each is protected by that customer's own
// zone: it accepts only Keycard tokens issued by that zone and audienced to its URL. Callers never
// reach it directly: each agent's gateway exchanges the person's token for one, per tool call, after
// Keycard decides whether that agent may use that tool. The data is a stand-in; the token check is real.
import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireBearerAuth } from '@keycardai/mcp/server/auth/middleware/bearerAuth';
import { state } from './keycard.js';
import { customer, type Customer } from './story.js';

export const workUrl = (publicUrl: string, customerKey: string) => `${publicUrl.replace(/\/$/, '')}/acme-work/${customerKey}/mcp`;

function buildServer(c: Customer) {
  const p = c.project;
  const server = new McpServer({ name: 'acme-work', version: '1.0.0' });
  const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
  server.registerTool('list_tasks', { title: 'List tasks', description: `Open tasks in ${p}.`, inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => text(JSON.stringify(c.tasks.map(t => ({ project: p, task: t, state: 'Open' })))));
  server.registerTool('create_task', { title: 'Create a task', description: `Create a task in ${p}.`, inputSchema: { title: z.string() } },
    async ({ title }) => text(`Created “${title}” in ${p}.`));
  server.registerTool('upload_attachment', { title: 'Upload an attachment', description: `Attach a file to ${p}.`, inputSchema: { file: z.string() } },
    async ({ file }) => text(`Uploaded “${file}” to ${p}.`));
  server.registerTool('send_message', { title: 'Send a message', description: `Post a message to ${p}’s channel.`, inputSchema: { text: z.string() } },
    async () => text(`Posted to #${p.toLowerCase().replace(/\s+/g, '-')}.`));
  server.registerTool('update_project', { title: 'Update a project', description: `Change ${p}’s details, such as its due date.`, inputSchema: { change: z.string() } },
    async ({ change }) => text(`Updated ${p}: ${change}.`));
  server.registerTool('delete_project', { title: 'Delete a project', description: `Delete ${p}.`, inputSchema: {}, annotations: { destructiveHint: true } },
    async () => text(`Deleted ${p}.`));
  return server;
}

const verifiers = new Map<string, ReturnType<typeof requireBearerAuth>>();

export function acmeWorkRouter() {
  const router = express.Router();
  router.all('/acme-work/:customer/mcp', express.json(), (req, res, next) => {
    const c = customer(String(req.params.customer));
    const zone = c && state.zone(c.key);
    if (!c || !zone) return res.status(404).json({ error: 'No such Acme customer.' });
    const audience = zone.resources.work.identifier;
    const rpc = req.body as { method?: string; params?: { name?: string } } | undefined;
    if (process.env.DEBUG) res.on('finish', () => console.log(`Acme Work (${c.name}) ← ${req.method} ${rpc?.method ?? ''} ${rpc?.params?.name ?? ''} → ${res.statusCode} ${res.getHeader('www-authenticate') ?? ''}`));
    // SDK bearer middleware: this customer's zone as issuer, this server's URL as audience.
    const k = `${zone.issuer}|${audience}`;
    if (!verifiers.has(k)) verifiers.set(k, requireBearerAuth({ issuers: zone.issuer, audiences: audience }));
    verifiers.get(k)!(req, res, async (err?: unknown) => {
      if (err) return next(err);
      try {
        const server = buildServer(c);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => { transport.close(); server.close(); });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (e) { next(e); }
    });
  });
  return router;
}
