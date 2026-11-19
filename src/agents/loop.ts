// What both of Acme's agents share: a Claude tool loop, and Acme Work's tools reached through the
// agent's own Keycard gateway with the token it was handed for the person it acts for.
import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface Step { agent: string; tool: string; system: string; ok: boolean; detail: string }
export interface Tool { def: Anthropic.Tool; run: (input: Record<string, unknown>, steps: Step[]) => Promise<{ ok: boolean; content: string }> }

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5';
let claude: Anthropic | null = null;
const model = () => {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Set ANTHROPIC_API_KEY in .env: Acme’s agents need a model.');
  return claude ??= new Anthropic();
};

/** Acme Work's tools through the agent's gateway. The gateway names them <upstream>__<tool>; the agent uses the bare name. */
export async function acmeWork(agentName: string, gatewayUrl: string, token: string) {
  const client = new Client({ name: agentName, version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(gatewayUrl), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  const listed = (await client.listTools()).tools;
  const tools: Tool[] = listed.map(t => {
    const bare = t.name.replace(/^.*__/, '');
    return {
      def: { name: bare, description: t.description ?? bare, input_schema: (t.inputSchema ?? { type: 'object' }) as Anthropic.Tool.InputSchema },
      run: async (input, steps) => {
        const step = { agent: agentName, tool: bare, system: 'Acme Work' };
        try {
          const r = await client.callTool({ name: t.name, arguments: input });
          const text = (r.content as { type: string; text?: string }[] | undefined)?.find(c => c.type === 'text')?.text ?? '';
          steps.push({ ...step, ok: !r.isError, detail: text });
          return { ok: !r.isError, content: text };
        } catch (e) {
          // The gateway refuses before the call reaches Acme Work. Its message doesn't name the policy; Acme's app looks that up.
          const detail = (e as Error).message;
          steps.push({ ...step, ok: false, detail });
          return { ok: false, content: `Keycard refused ${bare}: ${detail}` };
        }
      },
    };
  });
  return { tools, close: () => client.close().catch(() => {}) };
}

export async function runLoop(system: string, prompt: string, tools: Tool[]) {
  const steps: Step[] = [];
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: prompt }];
  for (let turn = 0; turn < 6; turn++) {
    const res = await model().messages.create({ model: MODEL, max_tokens: 2000, system, tools: tools.map(t => t.def), messages });
    const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || !uses.length) {
      return { reply: res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('\n').trim(), steps };
    }
    messages.push({ role: 'assistant', content: res.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const u of uses) {
      const t = tools.find(x => x.def.name === u.name);
      const r = t ? await t.run(u.input as Record<string, unknown>, steps) : { ok: false, content: `No tool ${u.name}` };
      results.push({ type: 'tool_result', tool_use_id: u.id, content: r.content, is_error: !r.ok });
    }
    messages.push({ role: 'user', content: results });
  }
  return { reply: 'I stopped after several steps without finishing.', steps };
}

// Short answers: the Keycard decision is the point, not the prose.
export const STYLE = `Answer briefly in plain text (no Markdown): at most two short sentences, or one short line per item, each starting with "- ". No preamble, no follow-up offers.
If a tool reports that Keycard refused it, say in one sentence what was refused. Don't suggest workarounds, and don't try another tool to do the same thing.`;
