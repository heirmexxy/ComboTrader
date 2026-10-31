// How the agents get better. Every lesson is a row in agent_lessons, visible in Admin → AI agents → What the agents learned.
// Lessons come from three places:
//  1. AI output a person approved (or that went out automatically): answers, message templates, advice, post patterns.
//  2. Human edits and decisions: an edited reply replaces the AI version; rejected risk flags lower a signal's weight.
//  3. Outcomes: a week after a nudge or invitation we check whether the person took the step, and score the template.
// In rules mode the agents use the best active lessons, so they keep improving without a model.
import { q, now } from './db';

export type LessonKind = 'answer' | 'template' | 'signal' | 'advice' | 'post' | 'stage_words';
export interface Lesson { id: number; agent: string; kind: LessonKind; key: string; lang: string; content: string; source: string; active: number; uses: number; wins: number; losses: number; last_used_at: string | null; created_at: string }

export const parseLesson = <T = any>(l: Lesson | null | undefined): T | null => { if (!l) return null; try { return JSON.parse(l.content); } catch { return null; } };

/** Adds a lesson, or updates the same agent/kind/key/lang/content instead of duplicating it. */
export function learn(o: { agent: string; kind: LessonKind; key: string; lang?: string; content: unknown; source: 'ai' | 'human' | 'rules'; active?: boolean }) {
  const content = JSON.stringify(o.content);
  const lang = o.lang || 'en';
  const same = q.get<Lesson>('SELECT * FROM agent_lessons WHERE agent=? AND kind=? AND key=? AND lang=? AND content=?', o.agent, o.kind, o.key.slice(0, 300), lang, content);
  if (same) {
    q.run('UPDATE agent_lessons SET active=MAX(active, ?), source=CASE WHEN ?=\'human\' THEN \'human\' ELSE source END, updated_at=? WHERE id=?', o.active === false ? 0 : 1, o.source, now(), same.id);
    return same.id;
  }
  return q.insert('agent_lessons', { agent: o.agent, kind: o.kind, key: o.key.slice(0, 300), lang, content: content.slice(0, 20000), source: o.source, active: o.active === false ? 0 : 1, created_at: now(), updated_at: now() }).id;
}

/** Score used to rank lessons: smoothed success rate, human-written lessons get a head start. */
export const lessonScore = (l: Pick<Lesson, 'wins' | 'losses' | 'source'>) => (l.wins + 1 + (l.source === 'human' ? 1 : 0)) / (l.wins + l.losses + 2);

/** Best active lesson for a situation, preferring the visitor's language and then English. Ties go to the least recently used, so templates rotate. */
export function bestLesson(agent: string, kind: LessonKind, key: string, lang = 'en') {
  const rows = q.all<Lesson>("SELECT * FROM agent_lessons WHERE agent=? AND kind=? AND key=? AND active=1 AND lang IN (?, 'en')", agent, kind, key, lang);
  if (!rows.length) return null;
  rows.sort((a, b) => (Number(b.lang === lang) - Number(a.lang === lang)) || (lessonScore(b) - lessonScore(a)) || String(a.last_used_at || '').localeCompare(String(b.last_used_at || '')));
  return rows[0];
}
export function lessonsFor(agent: string, kind: LessonKind, opts: { lang?: string; key?: string; activeOnly?: boolean } = {}) {
  return q.all<Lesson>(`SELECT * FROM agent_lessons WHERE agent=? AND kind=? ${opts.lang ? 'AND lang=?' : ''} ${opts.key ? 'AND key=?' : ''} ${opts.activeOnly === false ? '' : 'AND active=1'} ORDER BY id DESC LIMIT 500`,
    ...[agent, kind, ...(opts.lang ? [opts.lang] : []), ...(opts.key ? [opts.key] : [])]);
}
export function used(id: number | null | undefined) { if (id) q.run('UPDATE agent_lessons SET uses=uses+1, last_used_at=? WHERE id=?', now(), id); }
export function scoreLesson(id: number, won: boolean) { q.run(`UPDATE agent_lessons SET ${won ? 'wins=wins+1' : 'losses=losses+1'}, updated_at=? WHERE id=?`, now(), id); }

/** Remembers to check, a week later, whether a message worked. */
export function trackOutcome(lessonId: number | null | undefined, situation: string, who: { userId?: number; leadId?: number; prospectId?: number }) {
  if (!lessonId) return;
  q.insert('lesson_outcomes', { lesson_id: lessonId, user_id: who.userId ?? null, lead_id: who.leadId ?? null, prospect_id: who.prospectId ?? null, situation, sent_at: now() });
}

/** Did the person take the step the message asked for? */
function succeeded(o: any): boolean {
  const since = o.sent_at;
  const u = o.user_id ? q.get<any>('SELECT * FROM users WHERE id=?', o.user_id) : null;
  switch (o.situation) {
    case 'phone': return !!u?.phone_verified_at;
    case 'kyc': return !!u && u.kyc_status !== 'rejected';
    case 'payment': case 'fund': return !!q.get("SELECT 1 FROM payments WHERE user_id=? AND status='success' AND paid_at>=?", o.user_id, since);
    case 'first_lot': return !!q.get("SELECT 1 FROM trades WHERE user_id=? AND created_at>=?", o.user_id, since);
    case 'plan': return !!q.get("SELECT 1 FROM plans WHERE user_id=? AND status='active'", o.user_id);
    case 'gift': return !q.get("SELECT 1 FROM gifts WHERE giver_id=? AND status='sent' AND created_at<=?", o.user_id, since);
    case 'refer': return !!q.get('SELECT 1 FROM users WHERE referred_by=? AND created_at>=?', o.user_id, since);
    default:
      if (String(o.situation).startsWith('email:')) return !!q.get('SELECT 1 FROM link_clicks c JOIN links l ON l.id=c.link_id WHERE l.lesson_id=? AND c.user_id=? AND c.created_at>=?', o.lesson_id, o.user_id, since)
        || !!q.get('SELECT 1 FROM trades WHERE user_id=? AND created_at>=?', o.user_id, since);
      if (o.lead_id) return !!q.get("SELECT 1 FROM leads WHERE id=? AND (status='signed_up' OR user_id IS NOT NULL)", o.lead_id);
      if (o.prospect_id) return !!q.get("SELECT 1 FROM prospects WHERE id=? AND status IN ('replied','meeting','won')", o.prospect_id);
      return false;
  }
}
/** Daily: score messages sent 7+ days ago (or earlier, as soon as they succeed). */
export function scoreOutcomes() {
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  let wins = 0, losses = 0;
  for (const o of q.all<any>('SELECT * FROM lesson_outcomes WHERE scored_at IS NULL ORDER BY id LIMIT 2000')) {
    const ok = succeeded(o);
    if (!ok && o.sent_at > weekAgo) continue; // give it a week
    q.run('UPDATE lesson_outcomes SET scored_at=?, won=? WHERE id=?', now(), ok ? 1 : 0, o.id);
    scoreLesson(o.lesson_id, ok); ok ? wins++ : losses++;
  }
  // Retire templates that clearly don't work (10+ tries, under 10% success) when a better one exists.
  for (const l of q.all<Lesson>("SELECT * FROM agent_lessons WHERE kind='template' AND active=1 AND wins+losses>=10")) {
    if (l.wins / (l.wins + l.losses) >= 0.1) continue;
    const better = q.get('SELECT 1 FROM agent_lessons WHERE agent=? AND kind=? AND key=? AND lang=? AND active=1 AND id!=?', l.agent, l.kind, l.key, l.lang, l.id);
    if (better) q.run('UPDATE agent_lessons SET active=0, updated_at=? WHERE id=?', now(), l.id);
  }
  return `${wins} worked, ${losses} did not`;
}

// ---------- Text helpers shared by the rules ----------
export const words = (s: string) => new Set(s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 2));
export const keyOf = (s: string) => [...words(s)].sort().slice(0, 40).join(' ');
/** Word-overlap similarity between a question and a stored question. */
export function similarity(question: string, stored: string) {
  const a = words(question), b = words(stored);
  if (!a.size || !b.size) return 0;
  let hit = 0; for (const w of a) if (b.has(w)) hit++;
  return hit / Math.sqrt(a.size * Math.max(4, b.size));
}
/** Fills {name}, {link}… in a learned template. */
export const fill = (t: string, v: Record<string, string | number>) => t.replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? String(v[k]) : m));
