// Test mode on a real server: simulated payments and sample Trade Lots while no live Paystack key is set,
// then one action that removes all test data and keeps the set-up (settings, commodities, prices, FAQs, blog, admins).
import fs from 'node:fs';
import path from 'node:path';
import { q, now, rawDb } from './db';
import { config } from './config';
import { settings } from './settings';
import { recordPrice } from './prices';
import { nextLotCode, lotDescription } from './lotgen';
import { rateFor } from './trading';
import { addTrailEvent } from './trading';
import { createCircle } from './circles';

/** Simulated checkout and payouts are allowed only while Paystack has no secret key (never alongside real money). */
export const testModeAvailable = () => config.paystackDemo;
export const simulatedPayments = () => config.paystackDemo && (config.demoMode || !!settings().test_mode);

const SAMPLE = [
  { commodity: 'soybean', region: 'Benue & Nasarawa', buyer_type: 'Animal feed mill, Kaduna', tonnage: 120, farmers: 85, target: 90_000_000, days: 21, circles: 1 },
  { commodity: 'paddy_rice', region: 'Kebbi & Niger', buyer_type: 'Integrated rice miller', tonnage: 200, farmers: 140, target: 130_000_000, days: 30, circles: 0 },
  { commodity: 'sesame', region: 'Nasarawa & Jigawa', buyer_type: 'Sesame exporter, Lagos', tonnage: 40, farmers: 60, target: 60_000_000, days: 14, circles: 1 },
  { commodity: 'maize', region: 'Oyo', buyer_type: 'Poultry feed producer', tonnage: 80, farmers: 50, target: 40_000_000, days: 10, circles: 0 },
];
/** Adds open sample lots (titles start with "TEST ·") and sample prices if there are none. */
export function addSampleLots(by: number) {
  let n = 0;
  for (const x of SAMPLE) {
    const c = q.get<any>('SELECT code, name FROM commodities WHERE code=?', x.commodity);
    if (!c) continue;
    const closes = new Date(Date.now() + x.days * 864e5).toISOString();
    const id = q.insert('lots', {
      code: nextLotCode(c.code, closes), commodity: c.code, title: `TEST · ${c.name} from ${x.region}`, region: x.region, buyer_type: x.buyer_type, buyer_name: '[Test buyer]',
      contract_ref: 'TEST-CONTRACT', tonnage: x.tonnage, farmers: x.farmers, target_amount: x.target * 100, min_commit: settings().min_commit_default,
      periods: '4,6,9,12', period_months: 12, rate_bps: rateFor(12), closes_at: closes, status: 'open', circles_enabled: 1,
      description: `Sample lot for testing. ${lotDescription({ commodityName: c.name, region: x.region, buyerType: x.buyer_type, tonnage: x.tonnage, farmers: x.farmers })}`,
      buyer_amount: Math.round(x.target * 1.25) * 100, buyer_due_at: new Date(Date.now() + (x.days + 120) * 864e5).toISOString(),
      created_by: by, created_at: now(), opened_at: now(),
    }).id;
    addTrailEvent(id, 'funded', 'Sample update: Champions are funding this lot.', null, by);
    // Two open sample circles per lot: small slots for groups, one larger.
    if (x.circles) for (const [name, slots, price] of [[`TEST · ${c.name} Teachers' Circle`, 20, 25_000], [`TEST · ${c.name} Family Circle`, 10, 50_000]] as const) {
      try { createCircle({ lotId: id, name, slots, slotPrice: price * 100, creatorId: null, isPrivate: false }); } catch { /* lot too small */ }
    }
    n++;
  }
  if (!q.val("SELECT COUNT(*) FROM prices WHERE status='published'")) {
    for (const [code, naira] of [['maize', 610], ['rice', 1125], ['paddy_rice', 692], ['soybean', 767], ['sesame', 1520]] as const) {
      try { recordPrice({ commodity: code, pricePerKg: naira * 100, sourceName: 'Sample', by, force: true }); } catch { /* commodity removed */ }
    }
  }
  return n;
}

/** Tables kept by a clear-out (set-up and content). Everything else is test activity and is emptied. */
const KEEP = new Set(['settings', 'commodities', 'prices', 'price_sources', 'fx_rates', 'faqs', 'page_text', 'posts', 'job_runs', 'audit_log', 'users', 'sessions']);
export function testTables() {
  return q.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map((r) => r.name).filter((t) => !KEEP.has(t));
}
/** Removes every Champion, lot, payment, trade and agent/marketing record; keeps admins, settings and content. Backs up first. */
export function clearTestData(by: number | null) {
  const dir = path.resolve(path.dirname(config.dbFile), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const backup = path.join(dir, `before-clear-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  if (config.dbFile !== ':memory:') rawDb().exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  const db = rawDb();
  const counts: Record<string, number> = {};
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    for (const t of testTables()) { counts[t] = Number(q.val(`SELECT COUNT(*) FROM "${t}"`) ?? 0); db.exec(`DELETE FROM "${t}"`); }
    counts.champions = Number(q.val("SELECT COUNT(*) FROM users WHERE role!='admin'") ?? 0);
    db.exec("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE role!='admin')");
    db.exec("DELETE FROM users WHERE role!='admin'");
    db.exec("UPDATE users SET referred_by=NULL, acq_source=NULL, acq_campaign=NULL");
    db.exec("DELETE FROM prices WHERE source_name='Sample'");
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; } finally { db.exec('PRAGMA foreign_keys = ON'); }
  // Generated social images go too (uploaded Trail photos and blog images are kept).
  try { fs.rmSync(path.resolve(config.uploadsDir, 'public', 'social'), { recursive: true, force: true }); } catch { /* none */ }
  q.insert('audit_log', { actor_id: by, action: 'testdata.clear', detail: JSON.stringify({ backup: path.basename(backup), ...Object.fromEntries(Object.entries(counts).filter(([, v]) => v)) }), created_at: now() });
  return { backup, counts };
}
