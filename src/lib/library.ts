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
import { queueEmail, emailShell, escapeHtml, marketingDailyCap, marketingQueued, emailSuppressed, dropAddress } from './notify';
import { emailKey, dedupeContacts, PUBLIC_DOMAINS, isGeneralAddress } from './emailcheck';
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
const EMAIL_FIND = /[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const EMAIL_ONE = new RegExp(EMAIL_FIND.source, 'i');
const PHONE_RE = /^\+?[\d\s()-]{7,}$/;
/** Splits CSV text into rows of cells: handles quotes (with commas or line breaks inside), "" escapes, a byte-order
 * mark, and comma, semicolon or tab as the separator (whichever the first line uses most). */
export function csvRows(text: string): string[][] {
  const t = String(text || '').replace(/^﻿/, '');
  const first = t.split(/\r?\n/, 1)[0] || '';
  const sep = [',', ';', '\t'].map((c) => [c, first.split(c).length] as const).sort((x, y) => y[1] - x[1])[0][0];
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (quoted) { if (ch === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += ch; continue; }
    if (ch === '"' && cell.trim() === '') { quoted = true; cell = ''; }
    else if (ch === sep) { row.push(cell.trim()); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; row.push(cell.trim()); if (row.some((c) => c)) rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  row.push(cell.trim()); if (row.some((c) => c)) rows.push(row);
  return rows;
}
export interface ParsedContacts { rows: (ImportRow & { line: number })[]; invalid: { line: number; text: string }[]; dataRows: number; header: string[] | null }
/** Reads a pasted list or CSV. Finds the email column from the header (Email, E-mail, Email Address…) or, without a
 * header, from where the addresses are. Rows with no valid email are reported, never added. A cell like
 * "Ada Obi <ada@coop.ng>" gives ada@coop.ng; a cell with two addresses gives two contacts. */
export function parseContactsDetailed(input: string | string[][]): ParsedContacts {
  const all = typeof input === 'string' ? csvRows(input) : input.map((r) => r.map((c) => String(c ?? '').trim())).filter((r) => r.some(Boolean));
  const res: ParsedContacts = { rows: [], invalid: [], dataRows: 0, header: null };
  if (!all.length) return res;
  const h = all[0].map((c) => c.toLowerCase().replace(/[^a-z ]/g, '').trim());
  const isHeader = !all[0].some((c) => c.includes('@')) && h.some((c) => /e ?mail/.test(c));
  const col = (re: RegExp, avoid?: RegExp) => { const i = h.findIndex((c) => re.test(c) && !(avoid && avoid.test(c))); return i >= 0 ? i : h.findIndex((c) => re.test(c)); };
  const ix = isHeader ? {
    email: col(/^e ?mail( address)?$|e ?mail/, /org|company|business|office|secondary|alt/),
    name: col(/^(full )?name$|^contact( name)?$/), first: col(/first ?name|given/), last: col(/last ?name|surname|family/),
    phone: col(/phone|mobile|tel|whatsapp/), lang: col(/^lang(uage)?$/),
  } : null;
  if (isHeader) res.header = all[0];
  const body = isHeader ? all.slice(1) : all;
  body.forEach((cells, k) => {
    const line = k + (isHeader ? 2 : 1);
    res.dataRows++;
    const pick = (i: number | undefined) => (i !== undefined && i >= 0 ? cells[i] || '' : '');
    // With a header, only its email column counts (another column may hold a shared office address); without one, any cell.
    const src = ix && ix.email >= 0 ? pick(ix.email) : (cells.find((c) => EMAIL_ONE.test(c)) || '');
    const emails = [...new Set((src.match(EMAIL_FIND) || []).map((e) => e.toLowerCase().replace(/^[.'-]+|[.'-]+$/g, '')))].filter((e) => EMAIL_RE.test(e));
    if (!emails.length) { res.invalid.push({ line, text: cells.join(', ').slice(0, 120) }); return; }
    let name = ix ? (pick(ix.name) || [pick(ix.first), pick(ix.last)].filter(Boolean).join(' ')) : '';
    if (!name) { const nm = /^\s*"?([^"<@]+?)"?\s*</.exec(src); name = nm ? nm[1].trim() : (ix ? '' : cells.find((c) => c && !c.includes('@') && !PHONE_RE.test(c)) || ''); }
    let phone = ix ? pick(ix.phone) : cells.find((c) => PHONE_RE.test(c)) || '';
    if (/^[789]\d{9}$/.test(phone)) phone = `0${phone}`; // Excel drops the leading 0 of Nigerian numbers
    for (const email of emails) res.rows.push({ email, name: name.slice(0, 120), phone: phone.slice(0, 40), lang: ix ? pick(ix.lang) : '', line });
  });
  return res;
}
export function parseContacts(text: string): ImportRow[] { return parseContactsDetailed(text).rows; }

/** Adds opted-in contacts to lists. Returns counts. Requires the person importing to confirm consent. */
export function importContacts(rows: (ImportRow & { line?: number })[], o: { lists: ListName[]; sequence?: string; source: string; consent: boolean; by: number; fileRows?: number; invalid?: { line: number; text: string }[] }) {
  if (!o.consent) throw new Error('Confirm that these people asked to hear from Kitovu or ComboTrader.');
  const seq = o.lists.includes('sequence') ? o.sequence || 'nurture' : null;
  if (seq && !SEQUENCES[seq]) throw new Error('Unknown sequence');
  const res = { added: 0, updated: 0, champions: 0, skipped: 0, newsletter: 0, general: 0, dupFile: 0, removedBefore: 0, optedOut: 0, publicAdded: 0, toCheck: 0, importId: 0 };
  dedupeContacts(); // so every existing contact has its mailbox key before we compare
  const importId = q.insert('contact_imports', { created_by: o.by, source: o.source.slice(0, 200) || null, file_rows: o.fileRows ?? rows.length, status: 'checking', created_at: now() }).id;
  res.importId = importId;
  // What happened to each row, so the import can be checked line by line (downloadable from Contacts).
  const note = (line: number | undefined, email: string, outcome: string) => q.insert('contact_import_rows', { import_id: importId, line: line ?? null, email, outcome });
  for (const b of o.invalid || []) note(b.line, b.text, 'no valid email address in this row');
  const seen = new Map<string, number | undefined>();
  rows.forEach((r, i) => {
    if (!EMAIL_RE.test(r.email)) { note(r.line, r.email, 'no valid email address in this row'); return; }
    const key = emailKey(r.email);
    if (seen.has(key)) { res.skipped++; res.dupFile++; note(r.line, r.email, `duplicate of line ${seen.get(key) ?? '?'} in this file`); return; }
    seen.set(key, r.line);
    const lang = ['en', 'fr', 'sw', 'pt', 'ar'].includes(String(r.lang)) ? String(r.lang) : 'en';
    const user = q.get<any>('SELECT id FROM users WHERE lower(email)=?', r.email);
    if (isGeneralAddress(r.email)) { res.skipped++; res.general++; note(r.line, r.email, 'removed: general company address (not a person)'); dropAddress(r.email, 'general company address'); return; }
    if (emailSuppressed(r.email)) { res.skipped++; res.removedBefore++; note(r.line, r.email, 'not added: removed before (bounced, failed or domain gone)'); return; } // failed or bounced before: never re-added
    const ex = q.get<any>('SELECT * FROM leads WHERE email_key=? OR lower(email)=? ORDER BY id LIMIT 1', key, r.email); // already a contact: update, never add twice
    if (ex && ['unsubscribed', 'bounced'].includes(ex.status)) { res.skipped++; res.optedOut++; note(r.line, r.email, `not added: ${ex.status} before`); return; } // never re-add someone who opted out
    // Stagger first emails so a big import doesn't go out in one burst.
    const first = new Date(Date.now() + Math.floor(i / 50) * 3600e3).toISOString();
    const lists = [...new Set([...(String(ex?.lists || '').split(',').filter(Boolean)), ...o.lists])].join(',');
    const startSeq = seq && !user && (!ex || !ex.seq);
    if (ex) {
      q.run(`UPDATE leads SET consent=1, name=COALESCE(NULLIF(?, ''), name), phone=COALESCE(NULLIF(?, ''), phone), lists=?${startSeq ? ', seq=?, seq_step=0, seq_next_at=?' : ''} WHERE id=?`,
        r.name || '', r.phone || '', lists, ...(startSeq ? [seq, first] : []), ex.id);
      res.updated++; note(r.line, r.email, 'already in your contacts: updated, not added twice');
    } else {
      const pub = PUBLIC_DOMAINS.has(r.email.split('@')[1] || '');
      if (pub) res.publicAdded++; else res.toCheck++;
      note(r.line, r.email, pub ? 'imported: public email, added straight away' : 'imported: company email, Chidi is checking the domain');
      q.insert('leads', { email: r.email, email_key: key, import_id: importId, email_check: pub ? 'public' : null, email_checked_at: pub ? now() : null, name: r.name || null, phone: r.phone || null, lang, source: 'import', consent: 1, status: user ? 'signed_up' : 'new', user_id: user?.id ?? null, note: o.source.slice(0, 200) || null, token: randomToken(18), lists, seq: startSeq ? seq : null, seq_step: 0, seq_next_at: startSeq ? first : null, created_at: now() });
      res.added++;
    }
    if (user) res.champions++;
    if (o.lists.includes('newsletter')) {
      const s = q.get<any>('SELECT * FROM subscribers WHERE lower(email)=?', r.email);
      if (!s) { q.insert('subscribers', { email: r.email, lang, user_id: user?.id ?? null, status: 'confirmed', token: randomToken(18), created_at: now(), confirmed_at: now() }); res.newsletter++; }
      else if (s.status === 'pending') { q.run("UPDATE subscribers SET status='confirmed', confirmed_at=? WHERE id=?", now(), s.id); res.newsletter++; }
    }
  });
  q.run(`UPDATE contact_imports SET removed_general=?, imported=?, already_contacts=?, dup_in_file=?, removed_before=?, opted_out=?, champions=?, public_added=?, to_check=?, status=? WHERE id=?`,
    res.general, res.added, res.updated, res.dupFile, res.removedBefore, res.optedOut, res.champions, res.publicAdded, res.toCheck, res.toCheck ? 'checking' : 'done', importId);
  if (!res.toCheck) q.run('UPDATE contact_imports SET finished_at=? WHERE id=?', now(), importId);
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
  const due = q.all<any>("SELECT * FROM leads WHERE seq IS NOT NULL AND seq_next_at<=? AND consent=1 AND email IS NOT NULL AND email_check IN ('ok','public') AND status NOT IN ('unsubscribed','bounced','signed_up') ORDER BY (email_check='public') DESC, seq_next_at LIMIT ?", now(), cap);
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
    queueEmail(l.email, subject, emailShell(escapeHtml(subject), `<div data-seq="${l.seq}-${step.key}">${html}</div><p style="font-size:12px;color:#777;margin-top:24px">You’re receiving this because you asked to hear from ComboTrader. <a href="${leadStop(l.token)}">Stop these emails</a>.</p>`, { label: step.cta.label, url: cta }), { marketing: true, campaign: `seq-${l.seq}-${step.key}` });
    const next = s.steps[l.seq_step + 1];
    q.run("UPDATE leads SET seq_step=seq_step+1, seq_next_at=?, seq=CASE WHEN ? THEN seq ELSE NULL END, touches=touches+1, last_touch_at=?, status=CASE WHEN status='new' THEN 'contacted' ELSE status END WHERE id=?", next ? at9(next.day - step.day) : null, next ? 1 : 0, now(), l.id);
    sent++;
  }
  return `${sent} sequence emails sent${stopped ? `, ${stopped} stopped (signed up)` : ''}`;
}

/** Emails a new article to contacts on the blog list (within the daily cap). */
function notifyBlogList(post: any) {
  const cap = Math.max(0, marketingDailyCap() - marketingQueued());
  const people = q.all<any>("SELECT * FROM leads WHERE lists LIKE '%blog%' AND consent=1 AND email IS NOT NULL AND email_check IN ('ok','public') AND status NOT IN ('unsubscribed','bounced') ORDER BY (email_check='public') DESC, id LIMIT ?", cap);
  const link = trackedLink(`/chronicles/${post.slug}`, { channel: 'email', campaign: `blog-${post.slug}` }).url;
  for (const l of people) {
    const subject = `New on ComboTrader: ${post.title}`;
    queueEmail(l.email, subject, emailShell(escapeHtml(post.title), `<div data-seq="blog">${post.cover_path ? `<p><a href="${link}"><img src="${config.baseUrl}/uploads/${post.cover_path}" alt="" width="560" style="width:100%;max-width:560px;height:auto;border-radius:8px"></a></p>` : ''}${post.excerpt ? `<p>${escapeHtml(post.excerpt)}</p>` : ''}</div><p style="font-size:12px;color:#777;margin-top:24px"><a href="${leadStop(l.token)}">Stop these emails</a>.</p>`, { label: 'Read the article', url: link }), { marketing: true, campaign: 'blog' });
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
