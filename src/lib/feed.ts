// Live activity feed — built only from real events in the last 48 hours.
// Names appear only for Champions who opted in; amounts are never shown.
import { q } from './db';
import { settings } from './settings';
import { translate, fmtNum, type Lang } from './i18n';
import { siteStats } from './trading';
import { plusFormat } from './util';

export function feedItems(lang: Lang) {
  if (!settings().feed_enabled) return { items: [], totals: null };
  const since = new Date(Date.now() - 48 * 3600e3).toISOString();
  const rows = q.all<any>(`SELECT a.id, a.kind, a.data, a.created_at, u.first_name, u.last_name, u.city, u.feed_opt_in
    FROM activity a LEFT JOIN users u ON u.id=a.user_id
    WHERE a.hidden=0 AND a.created_at>=? ORDER BY a.id DESC LIMIT 30`, since);
  const t = (k: string, v?: Record<string, string | number>) => translate(lang, k, v);
  const items = rows.map((r) => {
    const data = JSON.parse(r.data || '{}');
    let who: string;
    if (r.first_name && r.feed_opt_in) {
      const name = `${r.first_name} ${String(r.last_name || '').slice(0, 1)}.`;
      who = r.city ? t('feed.who', { name, city: r.city }) : t('feed.who_nocity', { name });
    } else who = r.city ? t('feed.anon_city', { city: r.city }) : t('feed.anon');
    const commodity = data.commodity ? String(q.val('SELECT name FROM commodities WHERE code=?', data.commodity) || data.commodity).toLowerCase() : '';
    const text = t(`feed.${r.kind}`, { who, commodity });
    const mins = Math.max(0, Math.round((Date.now() - new Date(r.created_at).getTime()) / 60000));
    const ago = mins < 2 ? t('feed.just_now') : mins < 60 ? t('feed.mins_ago', { n: mins }) : t('feed.hours_ago', { n: Math.round(mins / 60) });
    return { id: r.id, text, ago };
  });
  const s = siteStats();
  return { items, totals: t('feed.totals', { champions: plusFormat(s.champions), tons: plusFormat(s.tons) }) };
}
