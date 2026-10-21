// Daily commodity price crawler and the price index behind the ticker.
// Sources are managed in Admin → Prices. The crawler honours robots.txt, never invents
// a price, and holds unusually large moves for an admin to approve.
import { q, now } from './db';
import { settings } from './settings';
import { audit } from './audit';

const UA = 'ComboTraderBot/1.0 (+https://combotrader.com.ng/prices)';

export interface PriceRow { commodity: string; name: string; bag_kg: number; price_per_kg: number; change_pct: number | null; observed_on: string; source_name: string | null; market: string | null }

/** Latest published price for each active commodity. */
export function latestPrices(): PriceRow[] {
  return q.all<PriceRow>(`SELECT c.code AS commodity, c.name, c.bag_kg, p.price_per_kg, p.change_pct, p.observed_on, p.source_name, p.market
    FROM commodities c JOIN prices p ON p.id = (SELECT id FROM prices WHERE commodity=c.code AND status='published' ORDER BY observed_on DESC, CASE source_name WHEN 'Kitovu' THEN 0 WHEN 'Kitovu eProcure' THEN 1 ELSE 2 END, id DESC LIMIT 1)
    WHERE c.active=1 ORDER BY c.sort, c.name`);
}
export function priceHistory(commodity: string, days = 90) {
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  return q.all<{ observed_on: string; price_per_kg: number }>(
    `SELECT observed_on, CAST(AVG(price_per_kg) AS INTEGER) AS price_per_kg FROM prices WHERE commodity=? AND status='published' AND observed_on>=? GROUP BY observed_on ORDER BY observed_on`, commodity, since);
}

/** Last published price from the same source (sources quote different markets, so moves are judged per source). */
function lastPublished(commodity: string, sourceName: string) {
  return q.get<{ price_per_kg: number }>("SELECT price_per_kg FROM prices WHERE commodity=? AND source_name=? AND status='published' ORDER BY observed_on DESC, id DESC LIMIT 1", commodity, sourceName)
    || q.get<{ price_per_kg: number }>("SELECT price_per_kg FROM prices WHERE commodity=? AND status='published' ORDER BY observed_on DESC, id DESC LIMIT 1", commodity);
}

/** Records a price observation. Large moves are held for review. */
export function recordPrice(o: { commodity: string; pricePerKg: number; market?: string | null; sourceId?: number | null; sourceName: string; observedOn?: string; by?: number; force?: boolean }) {
  if (!q.get('SELECT 1 FROM commodities WHERE code=?', o.commodity)) return null;
  if (!Number.isFinite(o.pricePerKg) || o.pricePerKg <= 0) return null;
  const prev = lastPublished(o.commodity, o.sourceName);
  const change = prev ? ((o.pricePerKg - prev.price_per_kg) / prev.price_per_kg) * 100 : null;
  const held = !o.force && change !== null && Math.abs(change) > settings().price_hold_threshold_pct;
  const observed = (o.observedOn || new Date().toISOString()).slice(0, 10);
  // One observation per commodity, source and day.
  q.run("DELETE FROM prices WHERE commodity=? AND source_name=? AND observed_on=? AND status!='rejected'", o.commodity, o.sourceName, observed);
  const r = q.insert('prices', {
    commodity: o.commodity, price_per_kg: Math.round(o.pricePerKg), market: o.market ?? null, source_id: o.sourceId ?? null,
    source_name: o.sourceName, observed_on: observed, change_pct: change === null ? null : Math.round(change * 10) / 10,
    status: held ? 'held' : 'published', reviewed_by: o.by ?? null, created_at: now(),
  });
  return { id: r.id, held, change };
}

// ---------- robots.txt ----------
const robotsCache = new Map<string, { at: number; rules: { allow: boolean; path: string }[] }>();
export function parseRobots(txt: string, agent = 'combotraderbot') {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let cur: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase()); lastWasAgent = true;
    } else if (cur && (key === 'allow' || key === 'disallow')) {
      if (val) cur.rules.push({ allow: key === 'allow', path: val });
      lastWasAgent = false;
    }
  }
  const mine = groups.find((g) => g.agents.some((a) => a !== '*' && agent.includes(a))) || groups.find((g) => g.agents.includes('*'));
  return mine?.rules || [];
}
export function robotsAllows(rules: { allow: boolean; path: string }[], path: string) {
  let best: { allow: boolean; path: string } | null = null;
  for (const r of rules) {
    const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(path) && (!best || r.path.length > best.path.length)) best = r;
  }
  return !best || best.allow;
}
async function allowedByRobots(url: URL) {
  let entry = robotsCache.get(url.origin);
  if (!entry || Date.now() - entry.at > 86400e3) {
    let rules: { allow: boolean; path: string }[] = [];
    try {
      const r = await fetch(`${url.origin}/robots.txt`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
      if (r.ok) rules = parseRobots(await r.text());
      else if (r.status === 401 || r.status === 403) rules = [{ allow: false, path: '/' }];
    } catch { /* unreachable robots.txt: treat as allowed, per the robots standard */ }
    entry = { at: Date.now(), rules };
    robotsCache.set(url.origin, entry);
  }
  return robotsAllows(entry.rules, url.pathname + url.search);
}

// ---------- Parsers ----------
interface SourceConfig {
  aliases?: Record<string, string>;          // label in the source -> commodity code
  unit_kg?: number;                         // the source quotes per this many kg (e.g. 100 for a bag)
  path?: string;                            // json: dot path to the array of items
  fields?: { commodity: string; price: string; market?: string; date?: string };
  patterns?: { commodity: string; regex: string; unit_kg?: number; market?: string }[]; // html
  delimiter?: string;                       // csv
  label_col?: number; price_col?: number;   // table: which cells hold the name and the price
  market?: string;                          // table: market label to record
  regex?: string;                           // pattern_all: global regex with named groups name, code, price
  markets?: Record<string, string>;         // pattern_all: code suffix -> market name
}
const dig = (o: any, p?: string) => (p ? p.split('.').reduce((a, k) => (a == null ? a : a[k]), o) : o);
const num = (v: unknown) => Number(String(v ?? '').replace(/[^\d.]/g, ''));

export function parseSource(kind: string, body: string, cfg: SourceConfig) {
  const out: { commodity: string; perKgNaira: number; market?: string; date?: string }[] = [];
  const unit = cfg.unit_kg || 1;
  const code = (label: string) => {
    const l = String(label || '').trim();
    return cfg.aliases?.[l] || cfg.aliases?.[l.toLowerCase()] || l.toLowerCase().replace(/\s+/g, '_');
  };
  if (kind === 'json') {
    const items = dig(JSON.parse(body), cfg.path);
    for (const it of Array.isArray(items) ? items : []) {
      const f = cfg.fields || { commodity: 'commodity', price: 'price' };
      const price = num(dig(it, f.price));
      if (price > 0) out.push({ commodity: code(dig(it, f.commodity)), perKgNaira: price / unit, market: f.market ? dig(it, f.market) : undefined, date: f.date ? dig(it, f.date) : undefined });
    }
  } else if (kind === 'csv') {
    const d = cfg.delimiter || ',';
    const lines = body.trim().split(/\r?\n/);
    const head = lines.shift()!.split(d).map((h) => h.trim().replace(/^"|"$/g, ''));
    const f = cfg.fields || { commodity: 'commodity', price: 'price' };
    for (const ln of lines) {
      const cells = ln.split(d).map((c) => c.trim().replace(/^"|"$/g, ''));
      const row = Object.fromEntries(head.map((h, i) => [h, cells[i]]));
      const price = num(row[f.price]);
      if (price > 0) out.push({ commodity: code(row[f.commodity]), perKgNaira: price / unit, market: f.market ? row[f.market] : undefined, date: f.date ? row[f.date] : undefined });
    }
  } else if (kind === 'table') {
    // Every <tr> becomes a row of cell texts; pick the label and price columns.
    const rows = body.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    for (const tr of rows) {
      const cells = (tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map((td) => td.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ').trim());
      const label = cells[cfg.label_col ?? 0], raw = cells[cfg.price_col ?? 1];
      if (!label || !raw || !/\d/.test(raw)) continue;
      const commodity = cfg.aliases?.[label] || cfg.aliases?.[label.toLowerCase()];
      if (!commodity) continue; // only commodities we map explicitly
      const price = num(raw.split('/')[0]);
      if (price > 0) out.push({ commodity, perKgNaira: price / unit, market: cfg.market });
    }
  } else if (kind === 'pattern_all') {
    // Many markets per commodity (e.g. NCX "Maize White (MZWKAN) ₦305.00"): averaged per commodity.
    const text = body.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&#8358;|&#x20a6;/gi, '₦').replace(/\*/g, '').replace(/\s+/g, ' ');
    const agg = new Map<string, { sum: number; n: number; markets: string[] }>();
    for (const m of text.matchAll(new RegExp(cfg.regex || '', 'g'))) {
      const g = m.groups || {};
      const commodity = cfg.aliases?.[String(g.name).trim()] || cfg.aliases?.[String(g.name).trim().toLowerCase()];
      const price = num(g.price);
      if (!commodity || !(price > 0)) continue;
      const a = agg.get(commodity) || { sum: 0, n: 0, markets: [] };
      a.sum += price; a.n++;
      const suffix = String(g.code || '').slice(-3);
      a.markets.push(cfg.markets?.[suffix] || suffix);
      agg.set(commodity, a);
    }
    for (const [commodity, a] of agg) out.push({ commodity, perKgNaira: a.sum / a.n / unit, market: a.n > 1 ? `Average of ${a.n} markets (${a.markets.join(', ')})` : a.markets[0] });
  } else if (kind === 'html') {
    const text = body.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&#8358;|&#x20a6;/gi, '₦').replace(/\s+/g, ' ');
    for (const p of cfg.patterns || []) {
      const m = new RegExp(p.regex, 'i').exec(text);
      if (m) { const price = num(m[1]); if (price > 0) out.push({ commodity: p.commodity, perKgNaira: price / (p.unit_kg || unit), market: p.market }); }
    }
  }
  return out;
}

/** Runs every enabled source once. Returns a summary per source. */
export async function crawlPrices(by?: number) {
  const summary: { source: string; status: string; recorded: number; held: number }[] = [];
  for (const s of q.all<any>("SELECT * FROM price_sources WHERE enabled=1 AND kind IN ('json','csv','html','table','pattern_all')")) {
    let status = 'ok', recorded = 0, held = 0;
    try {
      const url = new URL(s.url);
      if (!(await allowedByRobots(url))) throw new Error('Blocked by robots.txt — not crawled');
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json,text/csv,text/html;q=0.9' }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = parseSource(s.kind, await res.text(), JSON.parse(s.config || '{}'));
      if (!rows.length) throw new Error('No prices found — check the source settings');
      for (const r of rows) {
        const rec = recordPrice({ commodity: r.commodity, pricePerKg: Math.round(r.perKgNaira * 100), market: r.market, sourceId: s.id, sourceName: s.name, observedOn: r.date });
        if (rec) { recorded++; if (rec.held) held++; }
      }
      status = `ok: ${recorded} prices${held ? `, ${held} held for review` : ''}`;
    } catch (e: any) {
      status = `error: ${String(e?.message || e).slice(0, 200)}`;
    }
    q.run('UPDATE price_sources SET last_run_at=?, last_status=? WHERE id=?', now(), status, s.id);
    summary.push({ source: s.name, status, recorded, held });
  }
  audit(by ?? null, 'prices.crawl', undefined, summary);
  return summary;
}
