// The story, in one place: Acme sells two AI agents to its customers, Globex and Initech.
// Each customer has its own Keycard zone, its own sign-in, its own person and its own policies.
// Rename anything here and run `npm run teardown`, then `npm start`, to rebuild.

export const VENDOR = 'Acme';

/** What each customer's people use the agents for. The data is a stand-in; every Keycard decision is real. */
export const CUSTOMERS = [
  {
    key: 'globex', name: 'Globex', domain: 'globex.example',
    person: { key: 'gina', name: 'Gina Park', email: 'gina@globex.example', title: 'IT lead at Globex' },
    project: 'Q4 Launch',
    tasks: ['Draft the campaign brief', 'Book the launch webinar', 'Brief the sales team'],
    tickets: [
      { id: 'GLX-1042', title: 'SSO login loops for the Paris office', priority: 'High', state: 'Open' },
      { id: 'GLX-1039', title: 'Invoice export missing VAT column', priority: 'Medium', state: 'Open' },
      { id: 'GLX-1031', title: 'Add three seats to the analytics plan', priority: 'Low', state: 'Waiting on customer' },
    ],
  },
  {
    key: 'initech', name: 'Initech', domain: 'initech.example',
    person: { key: 'ivan', name: 'Ivan Petrov', email: 'ivan@initech.example', title: 'IT lead at Initech' },
    project: 'TPS Rollout',
    tasks: ['Update the TPS cover sheet', 'Schedule the training session'],
    tickets: [
      { id: 'INI-388', title: 'TPS report sync fails after the 2 a.m. batch', priority: 'High', state: 'Open' },
      { id: 'INI-385', title: 'Renewal quote for 2027 (confidential pricing)', priority: 'Medium', state: 'Open' },
    ],
  },
] as const;
export type Customer = (typeof CUSTOMERS)[number];
export type CustomerKey = Customer['key'];
export const customer = (key: string) => CUSTOMERS.find(c => c.key === key);

/** Acme Work: the product the agents work in. Policies name these tools; a tool nobody allowed is refused. */
export const WORK_TOOLS = [
  { name: 'list_tasks', label: 'Read tasks', risk: 'read' },
  { name: 'create_task', label: 'Create tasks', risk: 'write' },
  { name: 'upload_attachment', label: 'Upload attachments', risk: 'write' },
  { name: 'send_message', label: 'Send messages', risk: 'write' },
  { name: 'update_project', label: 'Update projects', risk: 'write' },
  { name: 'delete_project', label: 'Delete projects', risk: 'destructive' },
] as const;
export type WorkTool = (typeof WORK_TOOLS)[number]['name'];
export const toolLabel = (t: string) => WORK_TOOLS.find(x => x.name === t)?.label ?? t;

/**
 * The agents Acme sells. Each reaches Acme Work through its own Keycard gateway in each customer's zone,
 * so each customer can give each agent different tools. The Support Agent also reads support tickets,
 * with its own credential in each customer's zone.
 */
export const AGENTS = [
  {
    key: 'marketing', name: 'Acme Marketing Agent', slug: 'mktg', tickets: false,
    blurb: 'Plans campaigns in Acme Work: tasks, briefs, project updates.',
    defaults: ['list_tasks', 'create_task', 'upload_attachment', 'send_message'] as WorkTool[],
  },
  {
    key: 'support', name: 'Acme Support Agent', slug: 'support', tickets: true,
    blurb: 'Answers questions about your support tickets, and tracks follow-ups in Acme Work.',
    defaults: ['list_tasks', 'create_task'] as WorkTool[],
  },
] as const;
export type Agent = (typeof AGENTS)[number];
export type AgentKey = Agent['key'];
export const agent = (key: string) => AGENTS.find(a => a.key === key);
export const gatewayName = (a: Agent) => `${a.name} · Acme Work`;

/** Prompts the Acme app offers, per agent. `{other}` is the other customer's name. */
export const PROMPTS: Record<AgentKey, { label: string; text: string; expect: 'allowed' | 'denied' | 'both' }[]> = {
  marketing: [
    { label: 'Upload the brief', text: 'Upload the campaign brief, Q4-brief.pdf, to our project.', expect: 'allowed' },
    { label: 'Move the due date', text: 'Move our project’s due date to December 15.', expect: 'denied' },
    { label: 'Delete the project', text: 'Delete our project.', expect: 'denied' },
  ],
  support: [
    { label: 'Our open tickets', text: 'What are our open support tickets?', expect: 'allowed' },
    { label: 'Compare with {other}', text: 'Compare our open tickets with {other}’s open tickets.', expect: 'both' },
    { label: 'Upload the brief', text: 'Upload the campaign brief, Q4-brief.pdf, to our project.', expect: 'denied' },
  ],
};
