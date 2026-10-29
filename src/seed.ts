// DEMO DATA for local testing and screenshots. Never run against the live database.
import { q, now } from './lib/db';
import { createUser } from './lib/auth';
import { hashPassword, addDays, randomToken } from './lib/util';
import { createTrade, getLot, addTrailEvent, payTrade } from './lib/trading';
import { confirmPayment } from './lib/wallet';
import { recordPrice } from './lib/prices';
import { createCircle } from './lib/circles';
import { setSetting } from './lib/settings';

export function seedDemo() {
  const admin = { email: 'admin@combotrader.local', password: 'Harvest2026!' };
  const champion = { email: 'ada@example.com', password: 'Harvest2026!' };

  let adminId = q.val<number>('SELECT id FROM users WHERE email=?', admin.email);
  if (!adminId) {
    adminId = createUser({ email: admin.email, password: admin.password, first_name: 'Kitovu', last_name: 'Admin', country: 'NG', city: 'Iseyin', lang: 'en', feedOptIn: false });
    q.run("UPDATE users SET role='admin', admin_roles='super', email_verified_at=?, phone='+2348000000000', phone_verified_at=?, onboarded=1, kyc_status='verified' WHERE id=?", now(), now(), adminId);
  }
  let champId = q.val<number>('SELECT id FROM users WHERE email=?', champion.email);
  if (!champId) {
    champId = createUser({ email: champion.email, password: champion.password, first_name: 'Ada', last_name: 'Okafor', country: 'NG', city: 'Lagos', lang: 'en', phone: '+2348030000001' });
    q.run("UPDATE users SET email_verified_at=?, phone_verified_at=?, onboarded=1, kyc_status='verified', kyc_method='bvn', circle_pilot=1 WHERE id=?", now(), now(), champId);
    q.insert('bank_accounts', { user_id: champId, country: 'NG', bank_code: '058', bank_name: 'Guaranty Trust Bank', account_number: '0123456789', account_name: 'ADA OKAFOR', recipient_code: 'RCP_demo_0123456789', name_match: 1, created_at: now() });
  }

  if (!q.val('SELECT COUNT(*) FROM lots')) {
    const lot = (o: any) => q.insert('lots', { status: 'open', farmers: 0, circles_enabled: 0, created_by: adminId, created_at: now(), ...o }).id;
    const sb = lot({ code: 'SB-2611', commodity: 'soybean', title: 'Soybean for a feed mill, Kaduna', region: 'Benue & Nasarawa', buyer_type: 'Animal feed mill, Kaduna', buyer_name: '[Demo buyer]', contract_ref: 'DEMO-SB-001', tonnage: 120, farmers: 85, target_amount: 9000000000, min_commit: 25000000, period_months: 12, rate_bps: 3000, periods: "4,6,9,12", closes_at: addDays(now(), 21), description: 'Soybean bought from cooperatives in Benue and Nasarawa for a signed feed-mill order.', circles_enabled: 1 });
    lot({ code: 'PR-2612', commodity: 'paddy_rice', title: 'Paddy rice for a rice miller', region: 'Kebbi & Niger', buyer_type: 'Integrated rice miller', buyer_name: '[Demo buyer]', contract_ref: 'DEMO-PR-002', tonnage: 200, farmers: 140, target_amount: 13000000000, min_commit: 25000000, period_months: 12, rate_bps: 3000, periods: "4,6,9,12", closes_at: addDays(now(), 30), description: 'Dry-season paddy for a miller with a standing offtake agreement.' });
    lot({ code: 'SS-2610', commodity: 'sesame', title: 'Export-grade sesame', region: 'Nasarawa & Jigawa', buyer_type: 'Sesame exporter, Lagos', buyer_name: '[Demo buyer]', contract_ref: 'DEMO-SS-003', tonnage: 40, farmers: 60, target_amount: 6000000000, min_commit: 25000000, period_months: 12, rate_bps: 3000, periods: "4,6,9,12", closes_at: addDays(now(), 12) });
    const mz = lot({ code: 'MZ-2604', commodity: 'maize', title: 'Maize for a poultry feed producer', region: 'Oyo', buyer_type: 'Poultry feed producer', buyer_name: '[Demo buyer]', contract_ref: 'DEMO-MZ-004', tonnage: 80, farmers: 50, target_amount: 4000000000, min_commit: 25000000, period_months: 4, rate_bps: 2000, periods: "4", closes_at: addDays(now(), -130), status: 'active' });

    // Ada funds her wallet (demo Paystack) and joins two lots.
    for (const [ref, amount] of [['CTF-DEMO-1', 300000000], ['CTF-DEMO-2', 150000000]] as const) {
      q.insert('payments', { user_id: champId, reference: ref, amount, fee: 0, status: 'pending', demo: 1, created_at: now() });
      confirmPayment(ref, { demoSuccess: true });
    }
    createTrade(champId, getLot(sb)!, 150000000, addDays(now(), -20), { months: 6 });
    const old = createTrade(champId, getLot(mz)!, 100000000, addDays(now(), -125), { months: 4 });
    for (const [st, d, note] of [['funded', -125, 'Lot fully funded by Harvest Champions.'], ['sourcing', -110, 'Bought from 50 farmers in Oyo North at the agreed price.'], ['warehoused', -95, 'Stored in Kitovu’s Iseyin warehouse, moisture checked.'], ['delivered', -60, 'Delivered to the buyer in three trucks.'], ['buyer_paid', -10, 'Buyer paid in full.']] as const) {
      addTrailEvent(mz, st, note, null, adminId, addDays(now(), d));
    }
    addTrailEvent(sb, 'funded', 'Champions are funding this lot.', null, adminId, addDays(now(), -20));
    addTrailEvent(sb, 'sourcing', 'Buying from four cooperatives in Benue.', null, adminId, addDays(now(), -8));
    // Mature and pay the old maize trade.
    q.run('UPDATE trades SET matures_at=? WHERE id=?', addDays(now(), -1), old.id);
    payTrade(old.id, adminId);

    // A circle filling on the soybean lot (Circles are in pilot mode by default).
    createCircle({ lotId: sb, name: 'Soybean Community Circle', slots: 25, slotPrice: 1000000, creatorId: null, isPrivate: false });
  }

  // Demo price history (90 days), labelled "Demo data" so it is never mistaken for a real source.
  if (!q.val('SELECT COUNT(*) FROM prices')) {
    const base: Record<string, number> = { maize: 650, rice: 1160, paddy_rice: 720, soybean: 800, sesame: 1500, sorghum: 700, millet: 690, cashew: 1300, cocoa: 9500 };
    for (const [code, b] of Object.entries(base)) {
      let p = b * 0.9;
      for (let d = 90; d >= 0; d -= 3) {
        p = p * (1 + (Math.sin(d / 9 + b) * 0.012 + 0.0035));
        recordPrice({ commodity: code, pricePerKg: Math.round(p * 100), sourceName: 'Demo data', observedOn: addDays(now(), -d), force: true, market: 'Demo' });
      }
    }
  }

  if (!q.val('SELECT COUNT(*) FROM posts')) {
    const p = (slug: string, title: string, category: string, excerpt: string, body: string, daysAgo: number) =>
      q.insert('posts', { slug, lang: 'en', title, excerpt, body, category, author: 'ComboTrader team', status: 'published', publish_at: addDays(now(), -daysAgo), created_at: now(), updated_at: now() });
    p('how-a-combotrader-trade-works', 'How a ComboTrader trade works, step by step', 'guides', 'From your wallet to the farm gate to the buyer’s warehouse — and back to you with earnings.',
      '## 1. A buyer signs first\n\nEvery Trade Lot starts with a signed order from an established buyer: a feed mill, a rice miller or an exporter. No contract, no lot.\n\n## 2. Champions fund the lot\n\nHarvest Champions commit money from their wallets. When the lot is full, it closes to new money.\n\n## 3. Kitovu buys from verified farmers\n\nKitovu’s field team buys from farmers and cooperatives it works with directly, checks quality, and stores the produce.\n\n## 4. Delivery and payment\n\nThe produce is delivered to the buyer. The buyer pays Kitovu, and on your payout date your principal and earnings land in your wallet.\n\nYou can follow every stage on your trade’s **Harvest Trail**.', 2);
    p('reading-the-price-ticker', 'Reading the ComboTrader price ticker', 'market-watch', 'What the prices at the bottom of every page mean, and where they come from.',
      'The ticker shows the latest price **per kilogram** for each commodity, with the change since the previous price.\n\n- Prices entered by Kitovu’s team come first.\n- Where there is no Kitovu price for the day, we show public market data, with its source named on the Prices page.\n- Unusually large moves are checked by a person before they appear.\n\nPrices are a guide to the market. They do not change the terms of a trade you have already joined.', 6);
    p('why-buyer-backed-trades', 'Why every lot is backed by a buyer', 'from-the-farm', 'Buying only against signed orders is how we keep your money moving food that is already sold.',
      'Farm produce loses value when it sits without a buyer. That’s why ComboTrader only opens a lot once a buyer has signed.\n\nIt means the trade has a destination before it starts: your money buys produce that is already sold, and the margin is known in advance.\n\nRisks remain — quality, transport and buyer payment can all slip — and we explain them plainly in our [risk statement](/legal/risk).', 12);
  }
  setSetting('circles_mode', 'pilot');
  return { admin, champion };
}

export const _ = { hashPassword, randomToken };
