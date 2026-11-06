// Standing instructions from the team to an agent ("Temi: no posts about soybean this week"), usually passed on by
// Adaeze from a chat with an admin. Every agent reads its active instructions with its own brief. They sit under the
// policy: an instruction can change emphasis, tone, topics or timing, never the rules on money, promises or consent.
import { q, now } from './db';

export function activeInstructions(agent: string) {
  return q.all<any>("SELECT * FROM agent_instructions WHERE agent=? AND active=1 AND (until IS NULL OR until>?) ORDER BY id", agent, now());
}
/** Lines added to an agent's prompt (empty when there are none). */
export function instructionsLine(agent: string) {
  const rows = activeInstructions(agent);
  return rows.length ? `Standing instructions from the ComboTrader team (follow them unless they conflict with the policy above, which always wins):\n${rows.map((r) => `- ${r.text}${r.until ? ` (until ${String(r.until).slice(0, 10)})` : ''}`).join('\n')}` : '';
}
export function addInstruction(o: { agent: string; text: string; by: number; until?: string | null; via?: string }) {
  return q.insert('agent_instructions', { agent: o.agent, text: o.text.slice(0, 500), created_by: o.by, via: o.via || 'admin', until: o.until || null, active: 1, created_at: now() }).id;
}
export function endInstruction(id: number) { q.run('UPDATE agent_instructions SET active=0, ended_at=? WHERE id=?', now(), id); }
