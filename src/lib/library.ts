// Content library engine. Loads the library into the agents (support answers, outreach and lifecycle email
// variants), sends the email sequences to opted-in contacts one step at a time, and proposes the next blog
// post (weekly) and newsletter (fortnightly) for approval. Works the same with or without AI.
import { marked } from 'marked';
import { q, now } from './db';
import { config } from './config';
import { settings, setSetting } from './settings';
import { learn, keyOf } from './learning';
import { propose, registerExecutors, agentOn } from './agents';
import { ensurePostCover, ensureNewsletterCover, newsletterCoverUrl } from './covers';
import { queueEmail, emailShell, escapeHtml, marketingDailyCap, marketingQueued, emailSuppressed } from './notify';
import { trackedLink, trackHtmlLinks } from './tracking';
import { lotPeriods, rateFor } from './trading';
import { latestPrices } from './prices';
import { audit } from './audit';
import { randomToken, fmtNGN, lagosNow } from './util';
import { BLOG, NEWSLETTERS, SEQUENCES, CHAMPION_EMAILS, ORG_OUTREACH, RESPONSES } from '../content/library';
import { PROSPECT_SEGMENTS } from '../content/playbook';

const fillName = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? v[k] : m));

/** Puts the library into the agents' memory (idempotent: unchanged items are not duplicated). */
export function seedLibrary() {
  let n = 0;
  for (const r of RESPONSES) { learn({ agent: 'support', kind: 'answer', key: keyOf(r.q), lang: 'en', content: { q: r.q, a: r.a }, source: 'human' }); n++; }
  for (const seg of PROSPECT_SEGMENTS) { const t = ORG_OUTREACH[seg]; if (t) { learn({ agent: 'prospector', kind: 'template', key: `org:${seg}`, content: { title: t.subject, body: t.body }, source: 'human' }); n++; } }
  learn({ agent: 'prospector', kind: 'template', key: 'org:followup', content: { title: ORG_OUTREACH.followup.subject, body: ORG_OUTREACH.followup.body }, source: 'human' }); n++;
  for (const [c, t] of Object.entries(CHAMPION_EMAILS)) { learn({ agent: 'email', kind: 'template', key: `email:${c}`, lang: 'en', content: { title: t.subject, body: t.body }, source: 'human' }); n++; }
  return n;
}

// ---------- Live sections for newsletters ----------
function liveSections() {
  const lots = q.all<any>("SELECT l.*, c.name AS commodity_name FROM lots l JOIN commodities c ON c.code=l.commodity WHERE l.status='open' AND l.closes_at>? ORDER BY l.closes_at LIMIT 4", now());
  const lotsMd = lots.length ? lots.map((l) => { const p = lotPeriods(l); const r = p.map((m) => rateFor(m) / 100); return `- **[${l.title}](${config.baseUrl}/lots/${l.code})**: ${p.length > 1 ? `${p[0]}–${p[p.length - 1]} months, ${r[0]}%–${r[r.length - 1]}% a year` : `${p[0]} months, ${r[0]}% a year`}; closes ${new Date(l.closes_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}.`; }).join('\n')
    : `No lots are open right now. We’ll email you when the next one opens. [See past lots](${config.baseUrl}/lots).`;
  const trail = q.get<any>("SELECT e.*, l.title, l.code FROM trail_events e JOIN lots l ON l.id=e.lot_id ORDER BY e.happened_at DESC, e.id DESC LIMIT 1");
  const trailMd = trail ? `**${trail.title}:** ${String(trail.stage).replace(/_/g, ' ')}${trail.note ? `. ${trail.note}` : ''} ([follow the trail](${config.baseUrl}/lots/${trail.code}))` : 'The first Harvest Trail updates will appear here as soon as the first lot is funded.';
  const post = q.get<any>("SELECT * FROM posts WHERE status='published' AND lang='en' ORDER BY COALESCE(publish_at, created_at) DESC LIMIT 1");
  const postMd = post ? `**[${post.title}](${config.baseUrl}/chronicles/${post.slug})**${post.excerpt ? `: ${post.excerpt}` : ''}` : '';
  const prices = latestPrices().slice(0, 4);
  const priceMd = prices.length ? prices.map((p) => `${p.name} ₦${Math.round(p.price_per_kg / 100).toLocaleString('en')}/kg${p.change_pct ? ` (${p.change_pct > 0 ? '+' : ''}${p.change_pct}%)` : ''}`).join(' · ') : '';
  return { lotsMd, trailMd, postMd, priceMd };
}
/** An issue's own story plus today's live sections. */
export function renderNewsletter(n: number) {
  const issue = NEWSLETTERS.find((x) => x.n === n);
  if (!issue) return null;
  const s = liveSections();
  const body = [`![ComboTrader newsletter, issue ${n}](${newsletterCoverUrl(n)})`, fillName(issue.body, { name: 'there' }), '## Open Trade Lots', s.lotsMd, '## From the Harvest Trail', s.trailMd,
    s.postMd && '## Worth reading', s.postMd, s.priceMd && '## Market prices', s.priceMd,
    `---\nComboTrader is a platform of Kitovu Technology Company Limited. Trades are not bank deposits and are not NDIC-insured. [Read the risks](${config.baseUrl}/legal/risk).\n\nWarm regards,\nThe ComboTrader team`].filter(Boolean).join('\n\n');
  return { subject: issue.subject, subject_b: issue.subject_b, body };
}

// ---------- Schedulers (propose for approval) ----------
const lastLibraryPost = () => q.get<any>("SELECT * FROM posts WHERE author='ComboTrader team' AND slug IN (" + BLOG.map(() => '?').join(',') + ") ORDER BY created_at DESC LIMIT 1", ...BLOG.map((b) => b.slug));
export function nextLibraryPost() { return BLOG.find((b) => !q.get('SELECT 1 FROM posts WHERE slug=? AND lang=?', b.slug, 'en')) || null; }
export function nextNewsletterNumber() { return Number(settings().library_newsletter_next || 1); }

/** Weekly: the next library article as a draft + an approval to publish. Fortnightly: the next newsletter. */
export function runLibrary() {
  const out: string[] = [];
  const st = settings();
  if (st.library_blog && agentOn('growth')) {
    const last = lastLibraryPost();
    const due = !last || Date.now() - new Date(last.created_at).getTime() > 6.5 * 864e5;
    const pending = q.get("SELECT 1 FROM agent_actions WHERE kind='publish_post' AND status='proposed'");
    const next = nextLibraryPost();
    if (due && !pending && next) {
      const id = q.insert('posts', { slug: next.slug, lang: 'en', title: next.title, excerpt: next.excerpt, body: next.body, category: next.category, author: 'ComboTrader team', status: 'draft', created_at: now(), updated_at: now() }).id;
      void ensurePostCover(id).catch(() => undefined);
      propose({ agent: 'growth', kind: 'publish_post', risk: 'low', title: `Publish article: ${next.title}`, summary: next.excerpt, payload: { post_id: id } });
      out.push(`article drafted: ${next.slug}`);
    }
  }
  if (st.library_newsletter && agentOn('email')) {
    const n = nextNewsletterNumber();
    const lastAt = String(st.library_newsletter_at || '');
    const due = !lastAt || Date.now() - new Date(lastAt).getTime() > 13.5 * 864e5;
    const pending = q.get("SELECT 1 FROM agent_actions WHERE kind='send_newsletter' AND status='proposed'");
    const r = renderNewsletter(n);
    if (due && !pending && r) {
      const id = q.insert('newsletters', { subject: r.subject, subject_b: r.subject_b, body: r.body, segment: 'all', status: 'draft', created_by: null, created_at: now() }).id;
      setSetting('library_newsletter_next', n + 1); setSetting('library_newsletter_at', now());
      void ensureNewsletterCover(n, r.subject).catch(() => undefined);
      propose({ agent: 'email', kind: 'send_newsletter', risk: 'low', title: `Send newsletter #${n}: ${r.subject}`, summary: `${r.subject} / B: ${r.subject_b}. Live sections filled from today’s lots, Trail and prices.`, payload: { newsletter_id: id } });
      out.push(`newsletter #${n} drafted`);
    }
  }
  return out.join('; ') || 'nothing due';
}

registerExecutors({
  publish_post(p) {
    const post = q.get<any>('SELECT * FROM posts WHERE id=?', Number(p.post_id));
    if (!post) throw new Error('Article not found');
    if (post.status === 'published') return 'already published';
    q.run("UPDATE posts SET status='published', publish_at=?, updated_at=? WHERE id=?", now(), now(), post.id);
    const n = notifyBlogList(post);
    return `published /chronicles/${post.slug}${n ? `; emailed ${n} readers` : ''}`;
  },
  send_newsletter(p) {
    const n = q.get<any>('SELECT * FROM newsletters WHERE id=?', Number(p.newsletter_id));
    if (!n) throw new Error('Newsletter not found');
    if (n.status === 'sent') return 'already sent';
    q.run("UPDATE newsletters SET status='scheduled', send_at=? WHERE id=?", now(), n.id);
    return `newsletter #${n.id} scheduled to send now`;
  },
});

// ---------- Contacts and sequences ----------
export type ListName = 'sequence' | 'newsletter' | 'blog';
export interface ImportRow { email: string; name?: string; phone?: string; lang?: string }
const EMAIL_RE = /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/;

/** Reads pasted lines or CSV: "email" or "email, name" or a header row with email,name,phone,lang. */
export function parseContacts(text: string): ImportRow[] {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const head = lines[0].toLowerCase().split(/[,;\t]/).map((x) => x.trim().replace(/"/g, ''));
  const hasHeader = head.includes('email');
  const idx = (k: string) => (hasHeader ? head.indexOf(k) : ({ email: 0, name: 1, phone: 2, lang: 3 } as any)[k]);
  const out: ImportRow[] = [];
  for (const l of hasHeader ? lines.slice(1) : lines) {
    const cells = l.split(/[,;\t]/).map((x) => x.trim().replace(/^"|"$/g, ''));
    const at = String(cells[idx('email')] || '').toLowerCase();
    const email = EMAIL_RE.test(at) ? at : String(cells.find((c) => EMAIL_RE.test(c.toLowerCase())) || '').toLowerCase();
    if (!hasHeader && email !== at) { const other = cells.find((c) => c && c.toLowerCase() !== email && !EMAIL_RE.test(c.toLowerCase()) && !/^[+\d\s()-]{7,}$/.test(c)); if (other) { out.push({ email, name: other, phone: cells.find((c) => /^[+\d\s()-]{7,}$/.test(c)) || '', lang: '' }); continue; } }
    if (!EMAIL_RE.test(email)) continue;
    out.push({ email, name: idx('name') >= 0 ? cells[idx('name')] || '' : '', phone: idx('phone') >= 0 ? cells[idx('phone')] || '' : '', lang: idx('lang') >= 0 ? cells[idx('lang')] || '' : '' });
  }
  return out;
}

/** Adds opted-in contacts to lists. Returns counts. Requires the person importing to confirm consent. */
export function importContacts(rows: ImportRow[], o: { lists: ListName[]; sequence?: string; source: string; consent: boolean; by: number }) {
  if (!o.consent) throw new Error('Confirm that these people asked to hear from Kitovu or ComboTrader.');
  const seq = o.lists.includes('sequence') ? o.sequence || 'nurture' : null;
  if (seq && !SEQUENCES[seq]) throw new Error('Unknown sequence');
  const res = { added: 0, updated: 0, champions: 0, skipped: 0, newsletter: 0 };
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    if (seen.has(r.email)) { res.skipped++; return; } seen.add(r.email);
    const lang = ['en', 'fr', 'sw', 'pt', 'ar'].includes(String(r.lang)) ? String(r.lang) : 'en';
    const user = q.get<any>('SELECT id FROM users WHERE lower(email)=?', r.email);
    if (emailSuppressed(r.email)) { res.skipped++; return; } // failed or bounced before: never re-added
    const ex = q.get<any>('SELECT * FROM leads WHERE email=?', r.email);
    if (ex && ['unsubscribed', 'bounced'].includes(ex.status)) { res.skipped++; return; } // never re-add someone who opted out
    // Stagger first emails so a big import doesn't go out in one burst.
    const first = new Date(Date.now() + Math.floor(i / 50) * 3600e3).toISOString();
    const lists = [...new Set([...(String(ex?.lists || '').split(',').filter(Boolean)), ...o.lists])].join(',');
    const startSeq = seq && !user && (!ex || !ex.seq);
    if (ex) {
      q.run(`UPDATE leads SET consent=1, name=COALESCE(NULLIF(?, ''), name), phone=COALESCE(NULLIF(?, ''), phone), lists=?${startSeq ? ', seq=?, seq_step=0, seq_next_at=?' : ''} WHERE id=?`,
        r.name || '', r.phone || '', lists, ...(startSeq ? [seq, first] : []), ex.id);
      res.updated++;
    } else {
      q.insert('leads', { email: r.email, name: r.name || null, phone: r.phone || null, lang, source: 'import', consent: 1, status: user ? 'signed_up' : 'new', user_id: user?.id ?? null, note: o.source.slice(0, 200) || null, token: randomToken(18), lists, seq: startSeq ? seq : null, seq_step: 0, seq_next_at: startSeq ? first : null, created_at: now() });
      res.added++;
    }
    if (user) res.champions++;
    if (o.lists.includes('newsletter')) {
      const s = q.get<any>('SELECT * FROM subscribers WHERE email=?', r.email);
      if (!s) { q.insert('subscribers', { email: r.email, lang, user_id: user?.id ?? null, status: 'confirmed', token: randomToken(18), created_at: now(), confirmed_at: now() }); res.newsletter++; }
      else if (s.status === 'pending') { q.run("UPDATE subscribers SET status='confirmed', confirmed_at=? WHERE id=?", now(), s.id); res.newsletter++; }
    }
  });
  audit(o.by, 'contacts.import', o.source, { ...res, lists: o.lists, sequence: seq });
  return res;
}

const sentToday = () => Number(q.val("SELECT COUNT(*) FROM outbox WHERE channel='email' AND subject NOT LIKE 'ComboTrader health%' AND created_at>=? AND body LIKE '%data-seq%'", new Date(Date.now() - 864e5).toISOString()) ?? 0);
/** Next 9:00 Lagos time at least `days` days from now. */
function at9(days: number) {
  const l = lagosNow(); const d = new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate() + Math.max(1, Math.round(days)), 8)); // 09:00 Lagos = 08:00 UTC
  return d.toISOString();
}
const leadStop = (token: string) => `${config.baseUrl}/u/${token}`;

/** Sends the sequence emails that are due (within the daily cap). */
export function runSequences() {
  if (!settings().sequences_enabled) return 'sequences off';
  const cap = Math.max(0, marketingDailyCap() - marketingQueued());
  if (!cap) return 'a day of emails is already waiting to send';
  const due = q.all<any>("SELECT * FROM leads WHERE seq IS NOT NULL AND seq_next_at<=? AND consent=1 AND email IS NOT NULL AND email_check IN ('ok','public') AND status NOT IN ('unsubscribed','bounced','signed_up') ORDER BY seq_next_at LIMIT ?", now(), cap);
  let sent = 0, stopped = 0;
  const cache = new Map<string, { html: string; cta: string }>();
  for (const l of due) {
    if (q.get('SELECT 1 FROM users WHERE lower(email)=?', l.email)) { q.run("UPDATE leads SET status='signed_up', seq=NULL, seq_next_at=NULL WHERE id=?", l.id); stopped++; continue; }
    const s = SEQUENCES[l.seq]; const step = s?.steps[l.seq_step];
    if (!step) { q.run('UPDATE leads SET seq=NULL, seq_next_at=NULL WHERE id=?', l.id); continue; }
    const v = { name: (String(l.name || '').trim().split(/\s+/)[0]) || 'there', site: config.baseUrl };
    const subject = fillName(step.subject, v);
    const ck = `${l.seq}-${step.key}-${v.name}`;
    if (!cache.has(ck)) cache.set(ck, { html: trackHtmlLinks(marked.parse(fillName(step.body, v), { async: false }) as string, { channel: 'email', campaign: `seq-${l.seq}-${step.key}` }), cta: trackedLink(step.cta.path, { channel: 'email', campaign: `seq-${l.seq}-${step.key}` }).url });
    const { html, cta } = cache.get(ck)!;
    queueEmail(l.email, subject, emailShell(escapeHtml(subject), `<div data-seq="${l.seq}-${step.key}">${html}</div><p style="font-size:12px;color:#777;margin-top:24px">You’re receiving this because you asked to hear from ComboTrader. <a href="${leadStop(l.token)}">Stop these emails</a>.</p>`, { label: step.cta.label, url: cta }), { marketing: true });
    const next = s.steps[l.seq_step + 1];
    q.run("UPDATE leads SET seq_step=seq_step+1, seq_next_at=?, seq=CASE WHEN ? THEN seq ELSE NULL END, touches=touches+1, last_touch_at=?, status=CASE WHEN status='new' THEN 'contacted' ELSE status END WHERE id=?", next ? at9(next.day - step.day) : null, next ? 1 : 0, now(), l.id);
    sent++;
  }
  return `${sent} sequence emails sent${stopped ? `, ${stopped} stopped (signed up)` : ''}`;
}

/** Emails a new article to contacts on the blog list (within the daily cap). */
function notifyBlogList(post: any) {
  const cap = Math.max(0, marketingDailyCap() - marketingQueued());
  const people = q.all<any>("SELECT * FROM leads WHERE lists LIKE '%blog%' AND consent=1 AND email IS NOT NULL AND email_check IN ('ok','public') AND status NOT IN ('unsubscribed','bounced') LIMIT ?", cap);
  const link = trackedLink(`/chronicles/${post.slug}`, { channel: 'email', campaign: `blog-${post.slug}` }).url;
  for (const l of people) {
    const subject = `New on ComboTrader: ${post.title}`;
    queueEmail(l.email, subject, emailShell(escapeHtml(post.title), `<div data-seq="blog">${post.cover_path ? `<p><a href="${link}"><img src="${config.baseUrl}/uploads/${post.cover_path}" alt="" width="560" style="width:100%;max-width:560px;height:auto;border-radius:8px"></a></p>` : ''}${post.excerpt ? `<p>${escapeHtml(post.excerpt)}</p>` : ''}</div><p style="font-size:12px;color:#777;margin-top:24px"><a href="${leadStop(l.token)}">Stop these emails</a>.</p>`, { label: 'Read the article', url: link }), { marketing: true });
  }
  return people.length;
}

/** Numbers for the admin page. */
export function libraryStats() {
  const seq = Object.entries(SEQUENCES).map(([k, s]) => ({ key: k, name: s.name, steps: s.steps.length,
    active: Number(q.val('SELECT COUNT(*) FROM leads WHERE seq=?', k) ?? 0),
    finished: Number(q.val("SELECT COUNT(*) FROM leads WHERE seq IS NULL AND seq_step>0 AND lists LIKE '%sequence%' AND status NOT IN ('unsubscribed')") ?? 0) }));
  return {
    blogTotal: BLOG.length, blogUsed: BLOG.filter((b) => q.get('SELECT 1 FROM posts WHERE slug=? AND lang=?', b.slug, 'en')).length,
    newsletterTotal: NEWSLETTERS.length, newsletterNext: nextNewsletterNumber(),
    contacts: Number(q.val("SELECT COUNT(*) FROM leads WHERE lists IS NOT NULL AND lists!=''") ?? 0),
    blogList: Number(q.val("SELECT COUNT(*) FROM leads WHERE lists LIKE '%blog%' AND status NOT IN ('unsubscribed','bounced')") ?? 0),
    seq, sentToday: sentToday(),
  };
}
export const _ = fmtNGN;
