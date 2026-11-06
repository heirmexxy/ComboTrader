// Chat with Adaeze, the Chief of Staff. Admins ask questions about the business, give instructions and suggestions;
// she answers from the live facts, runs tasks on the right agent, and passes standing instructions on to agents.
// Each admin may only direct the agents their role covers. Nothing here can move money or change rates or terms.
import { q, now } from './db';
import type { User } from './http';
import { completeJson, useAI, AiUnavailable, POLICY } from './ai';
import { audit } from './audit';
import { gatherFacts, assignTask, TASK_KINDS, rolesOf, type TaskKind, type AdminRole } from './chief';
import { addInstruction, endInstruction } from './instructions';
import { PERSONAS, agentLabel, type PersonaKey } from './personas';
import { offMessage, playbookFor } from '../content/playbook';

/** Which agents each admin role may direct (super admins: all). */
const ROLE_AGENTS: Record<AdminRole, PersonaKey[]> = {
  super: Object.keys(PERSONAS) as PersonaKey[],
  content: ['social', 'email', 'growth', 'prospector', 'chief'],
  support: ['support', 'onboarding', 'chief'],
  finance: ['treasury', 'risk', 'chief'],
  operations: ['ops', 'risk', 'treasury', 'chief'],
};
export function agentsFor(roles: AdminRole[]) { return [...new Set(roles.flatMap((r) => ROLE_AGENTS[r] || []))]; }
const byName = (name: string) => (Object.entries(PERSONAS).find(([, p]) => p.name.toLowerCase() === name.toLowerCase())?.[0] as PersonaKey | undefined);

export function chatHistory(adminId: number, limit = 40) {
  return q.all<any>('SELECT * FROM (SELECT * FROM chief_chat WHERE admin_id=? ORDER BY id DESC LIMIT ?) ORDER BY id', adminId, limit);
}

type Plan = { reply: string; tasks: { kind: string; detail?: Record<string, unknown>; reason?: string }[]; instructions: { agent: string; text: string; days?: number }[]; end_instructions: number[] };

/** Carries out what Adaeze decided, within what this admin may direct. Returns lines describing what was done. */
async function act(admin: User, plan: Plan) {
  const allowed = agentsFor(rolesOf(admin.admin_roles));
  const done: string[] = [];
  for (const t of plan.tasks.slice(0, 3)) {
    if (!(t.kind in TASK_KINDS)) continue;
    const agent = TASK_KINDS[t.kind as TaskKind].agent as PersonaKey;
    if (!allowed.includes(agent)) { done.push(`Not done: your role can’t direct ${agentLabel(agent)}.`); continue; }
    const r = await assignTask({ kind: t.kind as TaskKind, detail: t.detail || {}, reason: `Asked by ${admin.first_name} in chat${t.reason ? `: ${t.reason}` : ''}` }, admin.id);
    done.push(`${agentLabel(agent)}: ${r.message}`);
  }
  for (const i of plan.instructions.slice(0, 3)) {
    const agent = (i.agent in PERSONAS ? i.agent : byName(i.agent)) as PersonaKey | undefined;
    if (!agent || !i.text) continue;
    if (!allowed.includes(agent)) { done.push(`Not passed on: your role can’t direct ${agentLabel(agent)}.`); continue; }
    const bad = offMessage(i.text);
    if (bad.length) { done.push(`Not passed on to ${agentLabel(agent)}: it would break the playbook (${bad.join(', ')}).`); continue; }
    const until = i.days ? new Date(Date.now() + Math.min(90, Number(i.days)) * 864e5).toISOString() : null;
    const id = addInstruction({ agent, text: i.text, by: admin.id, until, via: 'chief chat' });
    done.push(`Passed on to ${agentLabel(agent)} (instruction #${id}${until ? `, until ${until.slice(0, 10)}` : ''}): “${i.text}”`);
  }
  for (const id of plan.end_instructions.slice(0, 5)) {
    const row = q.get<any>('SELECT * FROM agent_instructions WHERE id=? AND active=1', Number(id));
    if (row && allowed.includes(row.agent)) { endInstruction(row.id); done.push(`Instruction #${row.id} to ${agentLabel(row.agent)} ended.`); }
  }
  return done;
}

/** Without AI: "tell Temi …" passes an instruction on; anything else gets today's picture and what she can do. */
async function rulesReply(admin: User, message: string): Promise<Plan> {
  const m = /^\s*(?:tell|ask|instruct|remind)\s+([a-z]+)\s*(?:to|that|:|,)?\s+(.+)$/i.exec(message);
  if (m && byName(m[1])) return { reply: `I’ll pass that on to ${agentLabel(byName(m[1])!)}. They follow written instructions once they run in AI mode; in rules mode they keep to their fixed templates.`, tasks: [], instructions: [{ agent: byName(m[1])!, text: m[2].trim() }], end_instructions: [] };
  const brief = q.get<any>('SELECT headline FROM chief_briefs ORDER BY id DESC LIMIT 1');
  const mine = rolesOf(admin.admin_roles);
  const open = q.all<any>("SELECT text FROM chief_recs WHERE status='open' ORDER BY priority LIMIT 5");
  return {
    reply: [
      `I’m in rules mode, so I can’t read free-text questions yet. Switch the agents to AI in Admin → AI agents and I’ll answer anything about the business and pass on your instructions.`,
      brief ? `Today: ${brief.headline}` : '',
      open.length ? `Open decisions${mine.includes('super') ? '' : ' (all roles)'}:\n${open.map((o) => `• ${o.text}`).join('\n')}` : '',
      `Meanwhile you can write “tell Temi to …” (or Chidi, Ibrahim, Hauwa, Ngozi, Tolu…) and I’ll pass it on, or use “Ask an agent to do something” on the Chief of Staff page.`,
    ].filter(Boolean).join('\n\n'),
    tasks: [], instructions: [], end_instructions: [],
  };
}

export async function chatWithChief(admin: User, message: string) {
  const text = message.trim().slice(0, 2000);
  if (!text) return null;
  q.insert('chief_chat', { admin_id: admin.id, role: 'admin', text, created_at: now() });
  const roles = rolesOf(admin.admin_roles), allowed = agentsFor(roles);
  let plan: Plan;
  if (useAI('chief')) {
    try {
      const facts = await gatherFacts();
      const r = await completeJson<Plan>('chief', { trigger: `chat:${admin.id}`, maxTokens: 1800,
        system: `${POLICY}\n${playbookFor('chief')}\nYou are chatting with ${admin.first_name}, a ComboTrader admin (roles: ${roles.join(', ')}). Answer questions about the business from the facts given (numbers, lots, queues, email health, decisions, tasks); say plainly when the facts don't cover something. When they give an instruction or suggestion meant for an agent, pass it on:
- as a one-off "task" when it matches one of these kinds: ${Object.entries(TASK_KINDS).map(([k, v]) => `${k} (${v.agent}: ${v.what}; needs ${v.needs || 'nothing'})`).join('; ')};
- otherwise as a standing "instruction" to the right agent, written as a clear, short directive in the agent's terms, with "days" if it should expire. Agents: ${Object.entries(PERSONAS).map(([k, p]) => `${k} = ${p.name}, ${p.role}`).join('; ')}. This admin may only direct: ${allowed.join(', ')}.
- to stop an existing instruction, put its id in "end_instructions".
Never pass on anything that would move money, change rates or terms, promise returns, or contact people who haven't opted in; explain why instead. If an instruction is unclear, ask one short question and don't act. Keep "reply" short (under 120 words), warm and direct; say who you passed things to.
Return {"reply":string,"tasks":[{"kind":string,"detail":object,"reason":string}],"instructions":[{"agent":string,"text":string,"days":number}],"end_instructions":[number]}.`,
        input: { message: text, conversation: chatHistory(admin.id, 12).map((c) => ({ from: c.role === 'admin' ? admin.first_name : 'Adaeze', text: c.text })), facts,
          open_decisions: q.all<any>("SELECT id, roles, priority, text FROM chief_recs WHERE status='open' ORDER BY priority LIMIT 15"),
          recent_tasks: q.all<any>('SELECT kind, reason, status, result, outcome, created_at FROM agent_tasks ORDER BY id DESC LIMIT 10'),
          standing_instructions: q.all<any>('SELECT id, agent, text, until FROM agent_instructions WHERE active=1 ORDER BY id DESC LIMIT 30') } });
      plan = { reply: String(r.data.reply || '').slice(0, 2000), tasks: Array.isArray(r.data.tasks) ? r.data.tasks : [], instructions: Array.isArray(r.data.instructions) ? r.data.instructions : [], end_instructions: Array.isArray(r.data.end_instructions) ? r.data.end_instructions : [] };
    } catch (e) {
      if (!(e instanceof AiUnavailable)) audit(admin.id, 'chief.chat_error', undefined, String((e as Error).message));
      plan = await rulesReply(admin, text);
    }
  } else plan = await rulesReply(admin, text);
  const done = await act(admin, plan);
  const reply = plan.reply || 'Done.';
  q.insert('chief_chat', { admin_id: admin.id, role: 'chief', text: reply, actions: done.length ? JSON.stringify(done) : null, created_at: now() });
  if (done.length) audit(admin.id, 'chief.chat_actions', undefined, done);
  return { reply, done };
}
