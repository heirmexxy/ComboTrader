import { q, now } from './db';
import type { Lang } from './i18n';
import type { Post } from '../views/public/blog';
import { marked } from 'marked';

export function faqsFor(lang: Lang) {
  const rows = q.all<{ q: string; a: string }>('SELECT q, a FROM faqs WHERE lang=? ORDER BY sort, id', lang);
  return rows.length ? rows : q.all<{ q: string; a: string }>("SELECT q, a FROM faqs WHERE lang='en' ORDER BY sort, id");
}

/** Published posts in the reader's language; English posts fill in where no translation exists. */
export function postsFor(lang: Lang, o: { cat?: string; search?: string; limit?: number } = {}) {
  const params: any[] = [lang, lang, now()];
  let where = `(p.lang=? OR (p.lang='en' AND NOT EXISTS (SELECT 1 FROM posts x WHERE x.slug=p.slug AND x.lang=? AND x.status='published')))
    AND p.status='published' AND COALESCE(p.publish_at, p.created_at) <= ?`;
  if (o.cat) { where += ' AND p.category=?'; params.push(o.cat); }
  if (o.search) { where += ' AND (p.title LIKE ? OR p.body LIKE ?)'; params.push(`%${o.search}%`, `%${o.search}%`); }
  params.push(o.limit || 30);
  return q.all<Post>(`SELECT p.* FROM posts p WHERE ${where} ORDER BY COALESCE(p.publish_at, p.created_at) DESC LIMIT ?`, ...params);
}

export function postBySlug(slug: string, lang: Lang) {
  const base = "SELECT * FROM posts WHERE slug=? AND lang=? AND status='published' AND COALESCE(publish_at, created_at) <= ?";
  const p = q.get<Post>(base, slug, lang, now());
  if (p) return { post: p, fallback: false };
  const e = q.get<Post>(base, slug, 'en', now());
  return e ? { post: e, fallback: lang !== 'en' } : null;
}

export const md = (s: string) => marked.parse(s, { async: false }) as string;
