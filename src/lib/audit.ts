import { q, now } from './db';

export function audit(actorId: number | null | undefined, action: string, target?: string, detail?: unknown, ip?: string) {
  q.insert('audit_log', {
    actor_id: actorId ?? null, action, target: target ?? null,
    detail: detail === undefined ? null : typeof detail === 'string' ? detail : JSON.stringify(detail),
    ip: ip ?? null, created_at: now(),
  });
}

/** Records a real platform event for the activity feed. Never invented. */
export function activity(kind: 'signup' | 'trade' | 'circle_filled' | 'payout', userId: number | null, data: Record<string, unknown> = {}) {
  q.insert('activity', { kind, user_id: userId, data: JSON.stringify(data), created_at: now() });
}
