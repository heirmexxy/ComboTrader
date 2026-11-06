// Branded cover images (1200×675) for articles and newsletters: the title on ComboTrader green, with a picture for
// each kind of content. Made once and saved under uploads/public/covers; an uploaded photo on a post always wins.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { q, now } from './db';
import { config } from './config';
import { BRAND as B, MARK_SVG, useBrandFonts } from './brand';

const W = 1200, H = 675;
const xml = (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
function wrap(text: string, max: number, lines: number) {
  const out: string[] = [];
  let cur = '';
  for (const w of String(text).split(/\s+/)) {
    if ((cur + ' ' + w).trim().length > max && cur) { out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
  }
  if (cur) out.push(cur);
  if (out.length > lines) { const keep = out.slice(0, lines); keep[lines - 1] = keep[lines - 1].replace(/[\s,.;:]*$/, '') + '…'; return keep; }
  return out;
}

export const CATEGORY_LABEL: Record<string, string> = { guides: 'Guide', 'from-the-farm': 'From the farm', 'market-watch': 'Market watch', 'champion-stories': 'Champion story', newsletter: 'Newsletter' };

/** The picture on the right of the cover, one per kind of content. */
function motif(kind: string, issue?: number) {
  const g = B.gold, c = B.cream, l = B.green2;
  switch (kind) {
    case 'guides': // three numbered steps joined by a path
      return `<path d="M860,210 C990,230 990,330 900,350 C800,372 810,470 960,480" fill="none" stroke="${g}" stroke-width="6" stroke-dasharray="2 16" stroke-linecap="round"/>
        ${[[860, 210, '1'], [900, 350, '2'], [960, 480, '3']].map(([x, y, n]) => `<circle cx="${x}" cy="${y}" r="46" fill="${l}" stroke="${g}" stroke-width="5"/><text x="${x}" y="${Number(y) + 17}" text-anchor="middle" font-family="${B.headingFont}, Georgia, serif" font-size="50" fill="${c}">${n}</text>`).join('')}`;
    case 'market-watch': { // price bars with a rising line
      const bars = [140, 190, 170, 240, 290, 330];
      return `${bars.map((h, i) => `<rect x="${800 + i * 58}" y="${560 - h}" width="38" height="${h}" rx="6" fill="${l}"/>`).join('')}
        <polyline points="${bars.map((h, i) => `${819 + i * 58},${540 - h}`).join(' ')}" fill="none" stroke="${g}" stroke-width="7" stroke-linejoin="round" stroke-linecap="round"/>
        ${bars.map((h, i) => `<circle cx="${819 + i * 58}" cy="${540 - h}" r="9" fill="${g}"/>`).join('')}
        <line x1="780" y1="566" x2="1150" y2="566" stroke="${c}" stroke-width="3" opacity=".5"/>`;
    }
    case 'champion-stories': // a person with a leaf
      return `<circle cx="980" cy="260" r="70" fill="${l}" stroke="${g}" stroke-width="5"/><path d="M860,520 C860,420 920,370 980,370 C1040,370 1100,420 1100,520Z" fill="${l}" stroke="${g}" stroke-width="5"/><g transform="translate(1080,180) scale(.6)">${MARK_SVG}</g>`;
    case 'newsletter': // an envelope with the issue number
      return `<rect x="820" y="230" width="320" height="220" rx="18" fill="${l}" stroke="${g}" stroke-width="5"/><path d="M826,240 L980,360 L1134,240" fill="none" stroke="${g}" stroke-width="5" stroke-linejoin="round"/>
        ${issue ? `<circle cx="1120" cy="230" r="54" fill="${g}"/><text x="1120" y="248" text-anchor="middle" font-family="${B.bodyFont}, Arial, sans-serif" font-weight="700" font-size="${issue > 9 ? 40 : 48}" fill="${B.green}">${issue}</text>` : ''}`;
    default: // from-the-farm and anything else: field rows under a rising sun
      return `<circle cx="1010" cy="250" r="78" fill="${g}" opacity=".9"/>
        ${Array.from({ length: 7 }, (_, i) => `<path d="M${770 + i * 6},${430 + i * 32} C${900},${380 + i * 30} ${1040},${400 + i * 26} ${1200},${350 + i * 30}" fill="none" stroke="${i % 2 ? l : '#3E7F4E'}" stroke-width="14" stroke-linecap="round"/>`).join('')}
        <path d="M900,410 C900,370 930,340 960,330 C950,365 930,392 900,410Z" fill="${B.goldLight}"/><line x1="900" y1="410" x2="900" y2="450" stroke="${B.goldLight}" stroke-width="5"/>`;
  }
}

export async function coverImage(o: { title: string; kind: string; issue?: number }) {
  useBrandFonts();
  const host = config.baseUrl.replace(/^https?:\/\//, '').replace(/^www\./, '');
  const lines = wrap(o.title, 20, 3);
  const fs0 = lines.length > 2 ? 50 : 56, lh = fs0 + 12;
  const heading = `font-family="${B.headingFont}, Fraunces, Georgia, serif"`, body = `font-family="${B.bodyFont}, Inter, Arial, sans-serif"`;
  const eyebrow = (CATEGORY_LABEL[o.kind] || 'ComboTrader') + (o.issue ? ` · Issue ${o.issue}` : '');
  const top = 330 - ((lines.length - 1) * lh) / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${B.green}"/>
  <rect x="740" width="${W - 740}" height="${H}" fill="#24573A"/>
  ${motif(o.kind, o.issue)}
  <g transform="translate(72,64)"><g transform="translate(26,26) scale(.26)">${MARK_SVG}</g><text x="70" y="38" ${heading} font-size="38" fill="${B.cream}">Combo<tspan fill="${B.gold}">Trader</tspan></text></g>
  <text x="72" y="${top - 64}" ${body} font-size="24" font-weight="700" fill="${B.gold}" letter-spacing="4">${xml(eyebrow.toUpperCase())}</text>
  ${lines.map((l, i) => `<text x="72" y="${top + i * lh}" ${heading} font-size="${fs0}" fill="${B.cream}">${xml(l)}</text>`).join('')}
  <rect x="72" y="${H - 104}" width="96" height="6" rx="3" fill="${B.gold}"/>
  <text x="72" y="${H - 56}" ${body} font-size="26" fill="#DCE7DA">${xml(host)}</text>
</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 86 }).toBuffer();
}

const coversDir = () => path.resolve(config.uploadsDir, 'public', 'covers');
const coverFile = (name: string) => ({ rel: `covers/${name}.jpg`, abs: path.join(coversDir(), `${name}.jpg`) });
/** Public URL of a newsletter's cover (made on first use). */
export const newsletterCoverUrl = (n: number) => `${config.baseUrl}/uploads/${coverFile(`newsletter-${n}`).rel}`;

export async function ensureNewsletterCover(n: number, subject: string) {
  const f = coverFile(`newsletter-${n}`);
  if (!fs.existsSync(f.abs)) { fs.mkdirSync(coversDir(), { recursive: true }); fs.writeFileSync(f.abs, await coverImage({ title: subject, kind: 'newsletter', issue: n })); }
  return f.rel;
}
/** Gives a post a branded cover if it has none (an uploaded photo is never replaced). */
export async function ensurePostCover(id: number) {
  const p = q.get<any>('SELECT id, slug, lang, title, category, cover_path FROM posts WHERE id=?', id);
  if (!p || p.cover_path) return p?.cover_path || null;
  const f = coverFile(`post-${p.slug}-${p.lang}`);
  fs.mkdirSync(coversDir(), { recursive: true });
  fs.writeFileSync(f.abs, await coverImage({ title: p.title, kind: p.category }));
  q.run('UPDATE posts SET cover_path=?, updated_at=? WHERE id=? AND cover_path IS NULL', f.rel, now(), id);
  return f.rel;
}
/** Covers for posts that have none, and for every library newsletter (a few at a time). */
export async function backfillCovers(limit = 25) {
  let n = 0;
  for (const p of q.all<any>('SELECT id FROM posts WHERE cover_path IS NULL ORDER BY id LIMIT ?', limit)) { await ensurePostCover(p.id); n++; }
  const { NEWSLETTERS } = await import('../content/library');
  for (const x of NEWSLETTERS) { if (n >= limit) break; if (!fs.existsSync(coverFile(`newsletter-${x.n}`).abs)) { await ensureNewsletterCover(x.n, x.subject); n++; } }
  return n;
}
