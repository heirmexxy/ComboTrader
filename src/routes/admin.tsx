// Admin back office. Every money action is logged; large ones need two admins.
import fs from 'node:fs';
import { get, post } from '../lib/router';
import { render } from '../views/render';
import { AdminLayout } from '../views/layout';
import { Box, Kpis, Table, Act, F, Form, N, D, S, naira } from '../views/admin/ui';
import { Csrf } from '../views/components';
import { q, tx, now } from '../lib/db';
import { post as postJournal, move, walletAcct, reservedAcct, lotAcct, account, balance, trialBalance, walletBalance, reservedBalance } from '../lib/ledger';
import { lotPeriods, rateFor, PERIODS, delayLotPayouts, lateEarnings, allLots, getLot, duePayouts, upcomingPayouts, payTrade, addTrailEvent, trailFor, STAGES, siteStats, creditReferral, markMatured, lotRemaining } from '../lib/trading';
import { approveWithdrawal, completeWithdrawal } from '../lib/wallet';
import { allCircles, createCircle, expireCircles, getCircle } from '../lib/circles';
import { recordPrice, crawlPrices, latestPrices } from '../lib/prices';
import { notifyWaitlist, runJob, JOBS, sendNewsletter } from '../lib/jobs';
import { settings, setSetting, DEFAULTS, type SettingKey } from '../lib/settings';
import { notify, queueEmail, emailShell, escapeHtml } from '../lib/notify';
import { audit } from '../lib/audit';
import { userById, userByEmail } from '../lib/auth';
import { savePublicImage, savePrivateFile, privatePath } from '../lib/uploads';
import { parseNaira, slugify, fmtNGN, earningsFor } from '../lib/util';
import { lotPrefixes, nextLotCode, lotTitle, lotDescription } from '../lib/lotgen';
import { runChecks } from '../lib/watchdog';
import { LANGS, allKeys, fileValue, clearOverrides, isLang, type Lang } from '../lib/i18n';
import { CATEGORIES } from '../views/public/blog';
import { LEGAL } from '../content/legal';
import { config } from '../lib/config';
import { HttpError, type Ctx } from '../lib/http';

const page = (c: Ctx, title: string, body: React.ReactNode, actions?: React.ReactNode) => render(c, <AdminLayout title={title} actions={actions}>{body}</AdminLayout>);
const commodities = () => q.all<any>('SELECT * FROM commodities ORDER BY active DESC, sort, name');
const csv = (c: Ctx, name: string, rows: Record<string, unknown>[]) => {
  const keys = rows.length ? Object.keys(rows[0]) : ['empty'];
  const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  c.send(200, [keys.join(','), ...rows.map((r) => keys.map((k) => esc(r[k])).join(','))].join('\n'), 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="${name}-${now().slice(0, 10)}.csv"` });
};
const who = (id: number | null) => (id ? q.val<string>("SELECT first_name || ' ' || last_name FROM users WHERE id=?", id) || `#${id}` : '—');

// ============ Overview ============
get('/admin', 'admin:any', async (c) => {
  const health = c.can('super') ? await runChecks() : [];
  const since7 = new Date(Date.now() - 7 * 864e5).toISOString(), since30 = new Date(Date.now() - 30 * 864e5).toISOString();
  const committed = Number(q.val("SELECT COALESCE(SUM(amount),0) FROM trades WHERE status IN ('active','matured')"));
  const float = Number(q.val("SELECT COALESCE(SUM(e.amount),0) FROM entries e JOIN ledger_accounts a ON a.id=e.account_id WHERE a.kind='wallet'"));
  const signups30 = Number(q.val("SELECT COUNT(*) FROM users WHERE role='champion' AND created_at>=?", since30));
  const champions = Number(q.val("SELECT COUNT(*) FROM users WHERE role='champion'"));
  const traders = Number(q.val("SELECT COUNT(DISTINCT user_id) FROM trades"));
  const dueWeek = Number(q.val("SELECT COALESCE(SUM(amount),0) FROM trades WHERE status IN ('active','matured') AND matures_at<=?", new Date(Date.now() + 7 * 864e5).toISOString()));
  const dueMonth = Number(q.val("SELECT COALESCE(SUM(amount),0) FROM trades WHERE status IN ('active','matured') AND matures_at<=?", new Date(Date.now() + 30 * 864e5).toISOString()));
  const pendingW = q.get<any>("SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM withdrawals WHERE status IN ('requested','approved','manual')");
  const jobs = q.all<any>('SELECT * FROM job_runs ORDER BY name');
  const todo: [string, number, string][] = [
    ['Payouts due', duePayouts().length, '/admin/payouts'], ['Withdrawals waiting', pendingW.n, '/admin/withdrawals'],
    ['Identity checks', Number(q.val("SELECT COUNT(*) FROM users WHERE kyc_status='pending' AND kyc_method='document'")), '/admin/verification'],
    ['Prices held for review', Number(q.val("SELECT COUNT(*) FROM prices WHERE status='held'")), '/admin/prices'],
    ['Open support tickets', Number(q.val("SELECT COUNT(*) FROM tickets WHERE status='open'")), '/admin/messages'],
    ['Referral rewards held', Number(q.val("SELECT COUNT(*) FROM referral_rewards WHERE status='held'")), '/admin/referrals'],
    ['Adjustments to approve', Number(q.val("SELECT COUNT(*) FROM adjustments WHERE status='pending'")), '/admin/ledger'],
  ];
  page(c, 'Overview', <>
    <Kpis items={[
      ['Funds working in trades', <N k={committed} />], ['Wallet float', <N k={float} />, 'Champion money not in a trade'],
      ['Open lots', q.val("SELECT COUNT(*) FROM lots WHERE status='open'")], ['Principal due in 7 days', <N k={dueWeek} />, `30 days: ${fmtNGN(dueMonth)}`],
      ['New Champions (30 days)', signups30, `${q.val("SELECT COUNT(*) FROM users WHERE role='champion' AND created_at>=?", since7)} in the last 7 days`],
      ['Sign-up → first trade', champions ? `${Math.round((traders / champions) * 100)}%` : '—', `${traders} of ${champions} Champions`],
      ['Withdrawals waiting', pendingW.n, fmtNGN(pendingW.s)], ['Ledger check', trialBalance() === 0 ? '✓ balanced' : `✗ off by ${trialBalance()}`],
    ]} />
    <div className="grid-2 top">
      <Box title="Needs attention"><ul className="list">{todo.map(([l, n, href]) => <li key={href}><a href={href}>{l}</a><span className={`tag ${n ? 'tag-terra' : 'tag-grey'}`}>{n}</span></li>)}</ul></Box>
      <Box title="Scheduled jobs" actions={c.can('super') ? <span className="small muted">Run now:</span> : undefined}>
        <Table rows={Object.keys(JOBS).map((name) => ({ name, ...(jobs.find((j) => j.name === name) || {}) }))} cols={[
          ['Job', (r: any) => r.name], ['Last run', (r: any) => <D v={r.last_run} time />], ['Result', (r: any) => <span className="small">{String(r.last_status || '—').slice(0, 140)}</span>],
          ['', (r: any) => c.can('super') ? <Act action={`/admin/jobs/${r.name}`} label="Run" /> : null],
        ]} />
      </Box>
    </div>
    {health.length > 0 && <Box title="System health" actions={<span className="small muted">Checked every 10 minutes; problems are emailed to super admins. Outages are watched from outside by GitHub.</span>}>
      <Table rows={health} cols={[['Check', (h) => <b>{h.name}</b>], ['Status', (h) => <span className={`tag ${h.ok ? 'tag-green' : 'tag-terra'}`}>{h.ok ? 'OK' : 'Needs attention'}</span>], ['Detail', (h) => <span className="small">{h.detail}</span>]]} />
    </Box>}
  </>);
});
post('/admin/jobs/:name', 'admin:super', async (c) => {
  if (!JOBS[c.params.name]) throw new HttpError(404, 'Unknown job');
  const r = await runJob(c.params.name);
  audit(c.user!.id, 'job.run', c.params.name, r, c.ip);
  c.back('/admin', ['ok', `${c.params.name}: ${r}`.slice(0, 300)]);
});

// ============ Trade Lots ============
get('/admin/lots', 'admin:operations', (c) => page(c, 'Trade Lots', (
  <Box><Table rows={allLots()} cols={[
    ['Lot', (l) => <><a href={`/admin/lots/${l.id}`}><b>{l.title}</b></a><br /><span className="muted small">{l.code} · {l.commodity_name}</span></>],
    ['Status', (l) => <S s={l.status} />], ['Funded', (l) => <><N k={l.funded} /> <span className="muted small">of {fmtNGN(l.target_amount)}</span></>],
    ['Periods', (l) => `${lotPeriods(l).join(', ')} mo`], ['Closes', (l) => <D v={l.closes_at} />],
    ['', (l) => <a className="btn btn-ghost btn-sm" href={`/lots/${l.code}`} target="_blank">Public page</a>],
  ]} /></Box>
), <a className="btn btn-primary" href="/admin/lots/new">New lot</a>));

function LotForm({ l }: { l?: any }) {
  const auto = 'Leave blank and it is written for you from the commodity, region and buyer.';
  return (
    <div data-lot-form data-prefixes={JSON.stringify(lotPrefixes())}>
    <Form action={l ? `/admin/lots/${l.id}` : '/admin/lots/new'} multipart submit={l ? 'Save lot' : 'Create lot (as draft)'}>
      <F label="Commodity" name="commodity" value={l?.commodity} options={commodities().filter((x) => x.active).map((x) => [x.code, x.name])}
        hint={<>Not listed? <a href={`/admin/commodities/new?back=${encodeURIComponent(l ? `/admin/lots/${l.id}` : '/admin/lots/new')}`}>Add a commodity</a></>} />
      <F label="Sourcing region" name="region" value={l?.region} required hint="e.g. Benue & Nasarawa" />
      <F label="Buyer type (public)" name="buyer_type" value={l?.buyer_type} required hint="e.g. Rice miller, Lagos" />
      <F label="Title (shown to Champions)" name="title" value={l?.title} placeholder="Generated automatically" hint={auto} />
      <F label="Lot code" name="code" value={l?.code} placeholder="Generated automatically" hint="Commodity + year and month it closes, e.g. SB-2611. Leave blank to generate." />
      <F label="Buyer name (private, admins only)" name="buyer_name" value={l?.buyer_name} />
      <F label="Contract reference" name="contract_ref" value={l?.contract_ref} hint="A lot can only open with a contract on file." />
      <F label="Buyer contract value (₦, private)" name="buyer_amount" value={naira(l?.buyer_amount)} hint="What the buyer owes Kitovu. Used by Treasury to check coverage." />
      <F label="Buyer payment due (private)" name="buyer_due_at" type="date" value={l?.buyer_due_at?.slice(0, 10)} />
      <div className="field"><label htmlFor="a-contract">Contract file (PDF/JPG, private)</label><input id="a-contract" type="file" name="contract" accept="application/pdf,image/*" />{l?.contract_path && <p className="hint"><a href={`/admin/files/${l.contract_path}`}>View current contract</a></p>}</div>
      <F label="Tonnage" name="tonnage" type="number" step="0.1" value={l?.tonnage} required />
      <F label="Farmers paid (estimate)" name="farmers" type="number" value={l?.farmers ?? 0} />
      <F label="Lot size (₦)" name="target_amount" value={naira(l?.target_amount)} required />
      <F label="Minimum commitment (₦)" name="min_commit" value={naira(l?.min_commit ?? settings().min_commit_default)} required />
      <fieldset className="field"><legend>Periods Champions can choose</legend>
        {PERIODS.map((m) => <label key={m} className="check"><input type="checkbox" name="periods[]" value={m} defaultChecked={l ? lotPeriods(l).includes(m) : true} /> <span>{m} months — {rateFor(m) / 100}% per annum</span></label>)}
        <p className="hint">Rates come from <a href="/admin/settings#rates">Settings → Earnings rates</a>. Untick periods the buyer cycle can't support.</p>
      </fieldset>
      <F label="Closes on" name="closes_at" type="date" value={(l?.closes_at || new Date(Date.now() + 30 * 864e5).toISOString()).slice(0, 10)} required />
      <F label="Allow Harvest Circles on this lot" name="circles_enabled" type="checkbox" value={l?.circles_enabled} />
      <F label="Description (public)" name="description" type="textarea" value={l?.description} rows={3} placeholder="Generated automatically" hint={auto} />
    </Form>
    </div>
  );
}
get('/admin/lots/new', 'admin:operations', (c) => page(c, 'New Trade Lot', <Box><LotForm /></Box>));
function lotFields(c: Ctx, existingId?: number) {
  const target = parseNaira(c.body.target_amount), min = parseNaira(c.body.min_commit);
  const chosen = (Array.isArray(c.body.periods) ? c.body.periods : [c.body.periods]).map(Number).filter((m: number) => (PERIODS as readonly number[]).includes(m)).sort((a: number, b: number) => a - b);
  if (!target || !min || min > target) throw new HttpError(400, 'Check the lot size and minimum.');
  if (!chosen.length) throw new HttpError(400, 'Choose at least one period Champions can pick.');
  const longest = chosen[chosen.length - 1];
  const com = q.get<{ code: string; name: string }>('SELECT code, name FROM commodities WHERE code=?', c.str('commodity'));
  if (!com) throw new HttpError(400, 'Choose a commodity.');
  const region = c.str('region', 80), buyerType = c.str('buyer_type', 80), tonnage = Number(c.body.tonnage) || 0, farmers = c.int('farmers');
  const closes = new Date(`${c.str('closes_at', 10)}T22:59:00Z`);
  if (isNaN(closes.getTime())) throw new HttpError(400, 'Choose a closing date.');
  let code = c.str('code', 20).toUpperCase().replace(/[^A-Z0-9-]/g, '');
  if (!code || q.get('SELECT 1 FROM lots WHERE code=? AND id IS NOT ?', code, existingId ?? null)) code = nextLotCode(com.code, closes.toISOString(), existingId);
  return {
    code, title: c.str('title', 120) || lotTitle(com.name, region, buyerType), commodity: com.code, region, buyer_type: buyerType, buyer_name: c.str('buyer_name', 120),
    contract_ref: c.str('contract_ref', 80) || null, tonnage, farmers, target_amount: target, min_commit: min,
    periods: chosen.join(','), period_months: longest, rate_bps: rateFor(longest),
    closes_at: closes.toISOString(), circles_enabled: c.bool('circles_enabled') ? 1 : 0,
    description: c.str('description', 1000) || lotDescription({ commodityName: com.name, region, buyerType, tonnage, farmers }),
    buyer_amount: parseNaira(c.body.buyer_amount) || null, buyer_due_at: c.str('buyer_due_at', 10) ? new Date(`${c.str('buyer_due_at', 10)}T12:00:00Z`).toISOString() : null,
  };
}
post('/admin/lots/new', 'admin:operations', (c) => {
  const f = lotFields(c);
  const contract = savePrivateFile(c.files.contract);
  const id = q.insert('lots', { ...f, contract_path: contract, status: 'draft', created_by: c.user!.id, created_at: now() }).id;
  audit(c.user!.id, 'lot.create', `lot:${id}`, f, c.ip);
  c.redirect(`/admin/lots/${id}`, ['ok', 'Lot created as a draft. Open it when the contract is on file.']);
});
get('/admin/lots/:id', 'admin:operations', (c) => {
  const l = getLot(Number(c.params.id));
  if (!l) throw new HttpError(404, 'Not found');
  const trades = q.all<any>("SELECT t.*, u.first_name, u.last_name, u.email FROM trades t JOIN users u ON u.id=t.user_id WHERE t.lot_id=? ORDER BY t.id DESC", l.id);
  page(c, `${l.title} (${l.code})`, <>
    <Kpis items={[['Status', <S s={l.status} />], ['Funded', <N k={l.funded} />, `${Math.round(((l.funded || 0) / l.target_amount) * 100)}% of ${fmtNGN(l.target_amount)}`], ['Remaining', <N k={lotRemaining(l)} />], ['Champions', new Set(trades.map((t) => t.user_id)).size], ['Ledger balance', <N k={balance(`lot:${l.id}`)} />]]} />
    <Box title="Actions">
      <div className="btn-row">
        {l.status === 'draft' && <Act action={`/admin/lots/${l.id}/status`} fields={{ to: 'open' }} label="Open lot to Champions" tone="primary" confirm="Open this lot? Waitlisted Champions will be alerted." />}
        {['open', 'filled'].includes(l.status) && <Act action={`/admin/lots/${l.id}/status`} fields={{ to: 'active' }} label="Close to new money (trade running)" confirm="Stop accepting new money for this lot?" />}
        {['draft', 'open', 'filled', 'active'].includes(l.status) && <Act action={`/admin/lots/${l.id}/cancel`} label="Cancel lot & refund everyone" tone="danger" confirm="Cancel the lot and return every Champion's money to their wallet? This cannot be undone." />}
        <a className="btn btn-ghost btn-sm" href={`/admin/trail?lot=${l.id}`}>Post Harvest Trail update</a>
      </div>
    </Box>
    {['filled', 'active', 'completed', 'open'].includes(l.status) && trades.some((t) => ['active', 'matured'].includes(t.status)) && (
      <Box title="Exceptional delay: move the payout date">
        <p className="muted small">Do not use this because a buyer is late or has not paid: Kitovu pays Champions on the payout date from its own balance sheet (Terms 7.1). Use it only for causes outside Kitovu&apos;s control, such as a payment-system outage or a court order (Terms 7.4). Tell Champions before the payout date; earnings keep accruing at the same rate for the extra days. Every Champion in this lot is notified by app, email and SMS.</p>
        <Form action={`/admin/lots/${l.id}/delay`} submit="Move payout date and notify Champions">
          <F label="New payout date" name="date" type="date" required value={new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10)} />
          <F label="Reason (shown to Champions)" name="reason" required value="The buyer has asked for more time to pay" />
        </Form>
      </Box>
    )}
    <Box title={`Champions in this lot (${trades.length})`} actions={<a className="btn btn-ghost btn-sm" href={`/admin/reports/lot-${l.id}.csv`}>Export CSV</a>}>
      <Table rows={trades} cols={[['Champion', (t) => <a href={`/admin/champions/${t.user_id}`}>{t.first_name} {t.last_name}</a>], ['Amount', (t) => <N k={t.amount} />], ['Earnings', (t) => <N k={t.earnings ?? earningsFor(t.amount, t.rate_bps, t.period_months)} />], ['Matures', (t) => <D v={t.matures_at} />], ['Status', (t) => <S s={t.status} />], ['Via', (t) => t.circle_id ? `Circle #${t.circle_id}` : 'Direct']]} />
    </Box>
    <Box title="Edit lot"><LotForm l={l} /></Box>
  </>);
});
post('/admin/lots/:id', 'admin:operations', (c) => {
  const l = getLot(Number(c.params.id));
  if (!l) throw new HttpError(404, 'Not found');
  const f: any = lotFields(c, l.id);
  // Terms are fixed once Champions have joined; the code is on certificates, so it never changes after that.
  if ((l.funded || 0) > 0) { delete f.commodity; delete f.code; if (f.target_amount < (l.funded || 0)) f.target_amount = l.funded; }
  const contract = savePrivateFile(c.files.contract);
  if (contract) f.contract_path = contract;
  q.update('lots', l.id, f);
  audit(c.user!.id, 'lot.update', `lot:${l.id}`, f, c.ip);
  c.redirect(`/admin/lots/${l.id}`, ['ok', 'Saved.']);
});
post('/admin/lots/:id/status', 'admin:operations', (c) => {
  const l = getLot(Number(c.params.id))!;
  const to = c.str('to');
  if (to === 'open') {
    if (!l.contract_ref && !l.contract_path) return c.redirect(`/admin/lots/${l.id}`, ['error', 'Add the buyer contract before opening the lot.']);
    q.run("UPDATE lots SET status='open', opened_at=COALESCE(opened_at, ?) WHERE id=? AND status='draft'", now(), l.id);
    const n = notifyWaitlist(l.id);
    audit(c.user!.id, 'lot.open', `lot:${l.id}`, undefined, c.ip);
    return c.redirect(`/admin/lots/${l.id}`, ['ok', `Lot is open. ${n} waitlisted people alerted.`]);
  }
  if (to === 'active') { q.run("UPDATE lots SET status='active', started_at=COALESCE(started_at, ?) WHERE id=?", now(), l.id); audit(c.user!.id, 'lot.close', `lot:${l.id}`, undefined, c.ip); }
  c.redirect(`/admin/lots/${l.id}`, ['ok', 'Updated.']);
});
post('/admin/lots/:id/delay', 'admin:operations', (c) => {
  const l = getLot(Number(c.params.id));
  if (!l) throw new HttpError(404, 'Not found');
  const d = c.str('date', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d <= now().slice(0, 10)) return c.redirect(`/admin/lots/${l.id}`, ['error', 'Choose a future date.']);
  const n = delayLotPayouts(l.id, new Date(`${d}T12:00:00Z`).toISOString(), c.str('reason', 200), c.user!.id);
  c.redirect(`/admin/lots/${l.id}`, ['ok', `${n} trades moved to ${d}. Champions notified.`]);
});
post('/admin/lots/:id/cancel', 'admin:operations', (c) => {
  const l = getLot(Number(c.params.id))!;
  let n = 0;
  tx(() => {
    for (const t of q.all<any>("SELECT * FROM trades WHERE lot_id=? AND status IN ('active','matured')", l.id)) {
      move('lot_refund', lotAcct(l.id), walletAcct(t.user_id), t.amount, { ref: `refund:${t.id}`, memo: l.code, userId: t.user_id, by: c.user!.id });
      q.run("UPDATE trades SET status='cancelled' WHERE id=?", t.id);
      const u = userById(t.user_id); if (u) notify(u, 'lot_cancelled', { lot: l.title, amount: fmtNGN(t.amount) }, { link: '/app/wallet', sms: true });
      n++;
    }
    for (const ci of q.all<any>("SELECT id FROM circles WHERE lot_id=? AND status='filling'", l.id)) {
      for (const s of q.all<any>("SELECT * FROM circle_slots WHERE circle_id=? AND status='reserved'", ci.id)) {
        move('circle_release', reservedAcct(s.user_id), walletAcct(s.user_id), s.amount, { ref: `slot:${s.id}`, memo: 'Lot cancelled', userId: s.user_id, by: c.user!.id });
        q.run("UPDATE circle_slots SET status='released' WHERE id=?", s.id);
      }
      q.run("UPDATE circles SET status='cancelled' WHERE id=?", ci.id);
    }
    q.run("UPDATE lots SET status='cancelled' WHERE id=?", l.id);
  });
  audit(c.user!.id, 'lot.cancel', `lot:${l.id}`, { refunded: n }, c.ip);
  c.redirect(`/admin/lots/${l.id}`, ['ok', `Lot cancelled. ${n} trades refunded to wallets.`]);
});
get('/admin/files/:y/:m/:f', 'admin:any', (c) => {
  const abs = privatePath(`${c.params.y}/${c.params.m}/${c.params.f}`);
  if (!abs) throw new HttpError(404, 'Not found');
  audit(c.user!.id, 'file.view', `${c.params.y}/${c.params.m}/${c.params.f}`, undefined, c.ip);
  const type = abs.endsWith('.pdf') ? 'application/pdf' : abs.endsWith('.png') ? 'image/png' : 'image/jpeg';
  c.send(200, fs.readFileSync(abs), type, { 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline' });
});

// ============ Harvest Trail ============
get('/admin/trail', 'admin:operations', (c) => {
  const lots = allLots().filter((l) => ['open', 'filled', 'active', 'completed'].includes(l.status));
  const sel = Number(c.query.lot) || lots[0]?.id;
  const recent = q.all<any>('SELECT e.*, l.title, l.code FROM trail_events e JOIN lots l ON l.id=e.lot_id ORDER BY e.id DESC LIMIT 30');
  page(c, 'Harvest Trail', <div className="grid-2 top">
    <Box title="Post an update">
      <p className="muted small">Works from a phone in the field. Every Champion in the lot is notified.</p>
      <Form action="/admin/trail" multipart submit="Post update" className="stack">
        <F label="Lot" name="lot_id" value={sel} options={lots.map((l) => [String(l.id), `${l.code} · ${l.title}`])} />
        <F label="Stage" name="stage" options={STAGES.map((s) => [s, s.replace('_', ' ')])} />
        <F label="Date" name="happened_at" type="date" value={now().slice(0, 10)} />
        <F label="Note (what happened, quantities, location)" name="note" type="textarea" rows={3} />
        <div className="field"><label htmlFor="a-photo">Photo</label><input id="a-photo" type="file" name="photo" accept="image/*" capture="environment" /></div>
      </Form>
    </Box>
    <Box title="Recent updates"><Table rows={recent} cols={[['Lot', (e) => e.code], ['Stage', (e) => e.stage], ['Date', (e) => <D v={e.happened_at} />], ['Note', (e) => <span className="small">{e.note}</span>], ['Photo', (e) => e.photo_path ? <a href={`/uploads/${e.photo_path}`} target="_blank">view</a> : '—']]} /></Box>
  </div>);
});
post('/admin/trail', 'admin:operations', async (c) => {
  const lot = getLot(c.int('lot_id'));
  if (!lot || !STAGES.includes(c.str('stage') as any)) throw new HttpError(400, 'Choose a lot and stage.');
  const photo = await savePublicImage(c.files.photo);
  const n = addTrailEvent(lot.id, c.str('stage'), c.str('note', 1000), photo, c.user!.id, new Date(`${c.str('happened_at', 10) || now().slice(0, 10)}T12:00:00Z`).toISOString());
  audit(c.user!.id, 'trail.add', `lot:${lot.id}`, c.str('stage'), c.ip);
  c.redirect(`/admin/trail?lot=${lot.id}`, ['ok', `Update posted. ${n} Champions notified.`]);
});

// ============ Payouts ============
get('/admin/payouts', 'admin:finance', (c) => {
  markMatured();
  const due = duePayouts();
  const upcoming = upcomingPayouts(30);
  const total = due.reduce((s, t) => s + t.amount + earningsFor(t.amount, t.rate_bps, t.period_months), 0);
  page(c, 'Payouts', <>
    <p className="muted">{settings().auto_payouts ? 'Automatic payouts are on: matured trades are credited every 10 minutes on the payout date, whether or not the buyer has paid. Anything listed below will be picked up on the next run, or you can credit it now.' : 'Automatic payouts are off (Settings → Payouts). Credit each matured trade here.'} <a href="/admin/treasury">Check coverage in Treasury</a>.</p>
    <Kpis items={[['Due now', due.length, fmtNGN(total)], ['Next 30 days', upcoming.length, fmtNGN(upcoming.reduce((s: number, t: any) => s + t.amount, 0)) + ' principal'], ['Kitovu earnings paid to date', <N k={-balance('kitovu:earnings')} />]]} />
    <Box title="Due now — credit to Champions' wallets" actions={<a className="btn btn-ghost btn-sm" href="/admin/reports/payouts-due.csv">Export CSV</a>}>
      {due.length === 0 ? <p className="muted">No payouts are due.</p> : (
        <form method="post" action="/admin/payouts" data-confirm="Credit principal and earnings to the selected Champions' wallets?">
          <Csrf />
          <Table rows={due} cols={[
            [<input type="checkbox" data-check-all aria-label="Select all" />, (t) => <input type="checkbox" name="ids[]" value={t.id} defaultChecked aria-label={`Select ${t.certificate_no}`} />],
            ['Champion', (t) => `${t.first_name} ${t.last_name}`], ['Lot', (t) => t.lot_code], ['Principal', (t) => <N k={t.amount} />],
            ['Earnings', (t) => <N k={earningsFor(t.amount, t.rate_bps, t.period_months) + lateEarnings(t as any)} />], ['Matured', (t) => <D v={t.matures_at} />],
          ]} />
          <button className="btn btn-primary" type="submit">Credit selected payouts</button>
        </form>
      )}
    </Box>
    <Box title="Payout calendar — next 30 days"><Table rows={upcoming} cols={[['Date', (t: any) => <D v={t.matures_at} />], ['Champion', (t: any) => `${t.first_name} ${t.last_name}`], ['Lot', (t: any) => t.lot_title], ['Principal', (t: any) => <N k={t.amount} />], ['Earnings', (t: any) => <N k={earningsFor(t.amount, t.rate_bps, t.period_months)} />]]} /></Box>
  </>);
});
post('/admin/payouts', 'admin:finance', (c) => {
  const ids = ([] as string[]).concat(c.body.ids || []).map(Number).filter(Boolean);
  let ok = 0; const errs: string[] = [];
  for (const id of ids) { try { payTrade(id, c.user!.id); ok++; } catch (e: any) { errs.push(e.message); } }
  c.redirect('/admin/payouts', [errs.length ? 'error' : 'ok', `${ok} payouts credited.${errs.length ? ' Problems: ' + errs.slice(0, 3).join('; ') : ''}`]);
});

// ============ Withdrawals ============
get('/admin/withdrawals', 'admin:finance', (c) => {
  const queue = q.all<any>(`SELECT w.*, u.first_name, u.last_name, u.email, b.bank_name, b.account_number, b.account_name, b.details FROM withdrawals w JOIN users u ON u.id=w.user_id LEFT JOIN bank_accounts b ON b.id=w.bank_account_id
    WHERE w.status IN ('requested','approved','manual','processing') ORDER BY w.id`);
  const intlDetails = (uid: number) => q.val<string>("SELECT details FROM bank_accounts WHERE user_id=? AND country!='NG' AND active=1 ORDER BY id DESC", uid);
  const done = q.all<any>("SELECT w.*, u.first_name, u.last_name FROM withdrawals w JOIN users u ON u.id=w.user_id WHERE w.status IN ('paid','failed','rejected') ORDER BY w.id DESC LIMIT 50");
  const th = settings().dual_approval_threshold;
  page(c, 'Withdrawals', <>
    <p className="muted">Withdrawals above {fmtNGN(th)} need two different admins. Automatic sending below {fmtNGN(settings().auto_withdraw_limit)} {settings().auto_withdraw_limit ? 'is on' : 'is off'} (Settings).{config.paystackDemo && ' Paystack demo mode: transfers are simulated.'}</p>
    <Box title={`Queue (${queue.length})`}>
      <Table rows={queue} cols={[
        ['Requested', (w) => <D v={w.created_at} time />], ['Champion', (w) => <a href={`/admin/champions/${w.user_id}`}>{w.first_name} {w.last_name}</a>], ['Amount', (w) => <N k={w.amount} />],
        ['To', (w) => w.route === 'manual' ? <span className="small"><b>International</b><br />{intlDetails(w.user_id) || 'No details on file'}</span> : <span className="small">{w.bank_name}<br />{w.account_number} · {w.account_name}</span>],
        ['Status', (w) => <><S s={w.status} />{w.approved_by && w.status === 'approved' ? <span className="small muted"><br />1st: {who(w.approved_by)}</span> : null}</>],
        ['', (w) => <div className="btn-row">
          {w.route === 'paystack' && ['requested', 'approved'].includes(w.status) && <Act action={`/admin/withdrawals/${w.id}/approve`} label={w.amount > th && !w.approved_by ? 'First approval' : 'Approve & send'} tone="green" confirm={`Send ${fmtNGN(w.amount)} to ${w.account_name}?`} />}
          {w.route === 'manual' && w.status === 'manual' && <Act action={`/admin/withdrawals/${w.id}/paid`} label="Mark paid (sent offline)" tone="green" confirm="Confirm this international payout was sent?" />}
          {['requested', 'approved', 'manual'].includes(w.status) && <Act action={`/admin/withdrawals/${w.id}/reject`} label="Decline & refund" tone="danger" confirm="Decline and return the money to the Champion's wallet?" />}
        </div>],
      ]} empty="No withdrawals waiting." />
    </Box>
    <Box title="Recent"><Table rows={done} cols={[['Date', (w) => <D v={w.updated_at} time />], ['Champion', (w) => `${w.first_name} ${w.last_name}`], ['Amount', (w) => <N k={w.amount} />], ['Status', (w) => <S s={w.status} />], ['Reference', (w) => <span className="small">{w.reference}</span>], ['Note', (w) => <span className="small">{w.note}</span>]]} /></Box>
  </>);
});
post('/admin/withdrawals/:id/approve', 'admin:finance', async (c) => {
  try {
    const r = await approveWithdrawal(Number(c.params.id), c.user!.id);
    c.redirect('/admin/withdrawals', ['ok', r === 'awaiting_second' ? 'First approval recorded. A second admin must approve.' : `Withdrawal ${r}.`]);
  } catch (e: any) { c.redirect('/admin/withdrawals', ['error', e.message]); }
});
post('/admin/withdrawals/:id/paid', 'admin:finance', (c) => {
  const w = q.get<any>('SELECT * FROM withdrawals WHERE id=?', Number(c.params.id));
  if (!w || w.route !== 'manual') throw new HttpError(404, 'Not found');
  completeWithdrawal(w.reference, true, `Paid offline, confirmed by ${c.user!.first_name}`, c.user!.id);
  q.run('UPDATE withdrawals SET approved_by=?, approved_at=? WHERE id=?', c.user!.id, now(), w.id);
  audit(c.user!.id, 'withdrawal.manual_paid', `withdrawal:${w.id}`, { amount: w.amount }, c.ip);
  c.redirect('/admin/withdrawals', ['ok', 'Marked as paid.']);
});
post('/admin/withdrawals/:id/reject', 'admin:finance', (c) => {
  const w = q.get<any>('SELECT * FROM withdrawals WHERE id=?', Number(c.params.id));
  if (!w) throw new HttpError(404, 'Not found');
  completeWithdrawal(w.reference, false, `Declined by ${c.user!.first_name}`, c.user!.id);
  audit(c.user!.id, 'withdrawal.reject', `withdrawal:${w.id}`, { amount: w.amount }, c.ip);
  c.redirect('/admin/withdrawals', ['ok', 'Declined and refunded.']);
});

// ============ Wallets & ledger ============
get('/admin/ledger', 'admin:finance', (c) => {
  const kinds = q.all<any>("SELECT a.kind, COALESCE(SUM(e.amount),0) AS total FROM ledger_accounts a LEFT JOIN entries e ON e.account_id=a.id GROUP BY a.kind ORDER BY a.kind");
  const top = q.all<any>(`SELECT u.id, u.first_name, u.last_name, SUM(e.amount) AS bal FROM entries e JOIN ledger_accounts a ON a.id=e.account_id JOIN users u ON u.id=a.user_id
    WHERE a.kind='wallet' GROUP BY u.id HAVING bal<>0 ORDER BY bal DESC LIMIT 20`);
  const journals = q.all<any>(`SELECT j.*, (SELECT SUM(amount) FROM entries WHERE journal_id=j.id AND amount>0) AS size FROM journals j ORDER BY j.id DESC LIMIT 40`);
  const payments = q.all<any>('SELECT p.*, u.first_name, u.last_name FROM payments p JOIN users u ON u.id=p.user_id ORDER BY p.id DESC LIMIT 30');
  const adj = q.all<any>("SELECT a.*, u.first_name, u.last_name FROM adjustments a JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 20");
  const rec = q.get<any>("SELECT * FROM job_runs WHERE name='reconcile'");
  page(c, 'Wallets & ledger', <>
    <Kpis items={[['Ledger', trialBalance() === 0 ? '✓ balanced' : `✗ off by ${trialBalance()} kobo`], ['Last reconciliation', <D v={rec?.last_run} time />, String(rec?.last_status || 'not run yet').slice(0, 120)]]} />
    <div className="btn-row"><Act action="/admin/jobs/reconcile" label="Run reconciliation now" /></div>
    <div className="grid-2 top">
      <Box title="Balances by account type"><Table rows={kinds} cols={[['Account type', (k) => k.kind], ['Total', (k) => <N k={k.total} />, 'num']]} />
        <p className="muted small">external = net money in through Paystack (negative means money held on the platform). kitovu:* are Kitovu's costs and income.</p></Box>
      <Box title="Largest wallets"><Table rows={top} cols={[['Champion', (r) => <a href={`/admin/champions/${r.id}`}>{r.first_name} {r.last_name}</a>], ['Balance', (r) => <N k={r.bal} />, 'num']]} /></Box>
    </div>
    <Box title="Manual adjustment (needs a second admin to approve)">
      <Form action="/admin/ledger/adjust" submit="Request adjustment">
        <F label="Champion email" name="email" type="email" required />
        <F label="Amount (₦, negative to debit)" name="amount" required />
        <F label="Reason (shown to the Champion)" name="reason" required />
      </Form>
      <Table rows={adj} cols={[['Date', (a) => <D v={a.created_at} />], ['Champion', (a) => `${a.first_name} ${a.last_name}`], ['Amount', (a) => <N k={a.amount} />], ['Reason', (a) => a.reason], ['By', (a) => who(a.created_by)], ['Status', (a) => <S s={a.status} />],
        ['', (a) => a.status === 'pending' && a.created_by !== c.user!.id ? <div className="btn-row"><Act action={`/admin/ledger/adjust/${a.id}/approve`} label="Approve" tone="green" /><Act action={`/admin/ledger/adjust/${a.id}/reject`} label="Reject" tone="danger" /></div> : a.status === 'pending' ? <span className="muted small">Awaiting another admin</span> : null]]} />
    </Box>
    <Box title="Recent payments (Paystack)"><Table rows={payments} cols={[['Date', (p) => <D v={p.created_at} time />], ['Champion', (p) => `${p.first_name} ${p.last_name}`], ['Amount', (p) => <N k={p.amount} />], ['Fee', (p) => <N k={p.fee} />], ['Status', (p) => <S s={p.status} />], ['Channel', (p) => p.channel || '—'], ['Reference', (p) => <span className="small">{p.reference}{p.demo ? ' (demo)' : ''}</span>]]} /></Box>
    <Box title="Recent journals"><Table rows={journals} cols={[['#', (j) => j.id], ['Date', (j) => <D v={j.created_at} time />], ['Type', (j) => j.kind], ['Size', (j) => <N k={j.size} />], ['Memo', (j) => <span className="small">{j.memo} {j.ref && <span className="muted">({j.ref})</span>}</span>]]} /></Box>
  </>);
});
post('/admin/ledger/adjust', 'admin:finance', (c) => {
  const u = userByEmail(c.str('email'));
  const amt = Math.round(Number(String(c.body.amount).replace(/[₦,\s]/g, '')) * 100);
  if (!u || !amt || !c.str('reason')) return c.redirect('/admin/ledger', ['error', 'Enter a valid Champion email, amount and reason.']);
  q.insert('adjustments', { user_id: u.id, amount: amt, reason: c.str('reason', 200), created_by: c.user!.id, created_at: now() });
  audit(c.user!.id, 'adjustment.request', `user:${u.id}`, { amount: amt }, c.ip);
  c.redirect('/admin/ledger', ['ok', 'Adjustment requested. Another admin must approve it.']);
});
post('/admin/ledger/adjust/:id/:action', 'admin:finance', (c) => {
  const a = q.get<any>("SELECT * FROM adjustments WHERE id=? AND status='pending'", Number(c.params.id));
  if (!a) throw new HttpError(404, 'Not found');
  if (a.created_by === c.user!.id) return c.redirect('/admin/ledger', ['error', 'A different admin must approve this.']);
  if (c.params.action === 'approve') {
    try {
      tx(() => {
        postJournal('adjust', [{ account: account('kitovu:adjustments'), amount: -a.amount }, { account: walletAcct(a.user_id), amount: a.amount }], { ref: `adj:${a.id}`, memo: a.reason, userId: a.user_id, by: a.created_by, approvedBy: c.user!.id });
        q.run("UPDATE adjustments SET status='approved', approved_by=? WHERE id=?", c.user!.id, a.id);
      });
    } catch (e: any) { return c.redirect('/admin/ledger', ['error', e.message]); }
    const u = userById(a.user_id); if (u) notify(u, 'adjustment', { amount: fmtNGN(a.amount), reason: a.reason }, { link: '/app/wallet' });
  } else q.run("UPDATE adjustments SET status='rejected', approved_by=? WHERE id=?", c.user!.id, a.id);
  audit(c.user!.id, `adjustment.${c.params.action}`, `adjustment:${a.id}`, { amount: a.amount }, c.ip);
  c.redirect('/admin/ledger', ['ok', 'Done.']);
});

// ============ Champions ============
get('/admin/champions', 'admin:support', (c) => {
  const s = String(c.query.q || '').trim();
  const pageNo = Math.max(1, Number(c.query.page) || 1);
  const like = `%${s}%`;
  const rows = q.all<any>(`SELECT u.*, (SELECT COALESCE(SUM(amount),0) FROM trades WHERE user_id=u.id AND status IN ('active','matured')) AS working FROM users u
    WHERE (? = '' OR u.email LIKE ? OR u.first_name || ' ' || u.last_name LIKE ? OR u.phone LIKE ? OR u.referral_code = ?) ORDER BY u.id DESC LIMIT 50 OFFSET ?`, s, like, like, like, s.toUpperCase(), (pageNo - 1) * 50);
  page(c, 'Champions', <Box actions={<form method="get" className="inline-form">{c.can('super') && <a className="btn btn-ghost btn-sm" href="/admin/champions/import">Import users (CSV)</a>}<input type="search" name="q" defaultValue={s} placeholder="Name, email, phone or referral code" aria-label="Search" /><button className="btn btn-ghost btn-sm">Search</button></form>}>
    <Table rows={rows} cols={[
      ['Name', (u) => <><a href={`/admin/champions/${u.id}`}><b>{u.first_name} {u.last_name}</b></a>{u.role === 'admin' && <> <S s="admin" /></>}<br /><span className="muted small">{u.email}</span></>],
      ['Country', (u) => `${u.country}${u.city ? ' · ' + u.city : ''}`], ['Verified', (u) => <><S s={u.kyc_status} /> {u.email_verified_at ? '✉' : ''}{u.phone_verified_at ? ' ☎' : ''}</>],
      ['Wallet', (u) => <N k={walletBalance(u.id)} />, 'num'], ['In trades', (u) => <N k={u.working} />, 'num'], ['Joined', (u) => <D v={u.created_at} />], ['Status', (u) => <S s={u.status} />],
    ]} />
    <div className="btn-row">{pageNo > 1 && <a className="btn btn-ghost btn-sm" href={`?q=${encodeURIComponent(s)}&page=${pageNo - 1}`}>← Newer</a>}{rows.length === 50 && <a className="btn btn-ghost btn-sm" href={`?q=${encodeURIComponent(s)}&page=${pageNo + 1}`}>Older →</a>}</div>
  </Box>, <a className="btn btn-ghost" href="/admin/reports/champions.csv">Export CSV</a>);
});
get('/admin/champions/:id', 'admin:support', (c) => {
  const u = userById(Number(c.params.id));
  if (!u) throw new HttpError(404, 'Not found');
  const trades = q.all<any>('SELECT t.*, l.code FROM trades t JOIN lots l ON l.id=t.lot_id WHERE t.user_id=? ORDER BY t.id DESC', u.id);
  const banks = q.all<any>('SELECT * FROM bank_accounts WHERE user_id=? ORDER BY id DESC', u.id);
  const refs = q.all<any>('SELECT first_name, last_name, created_at FROM users WHERE referred_by=?', u.id);
  const notes = q.val<string>('SELECT notes FROM users WHERE id=?', u.id);
  const logins = q.all<any>('SELECT * FROM login_events WHERE user_id=? ORDER BY id DESC LIMIT 8', u.id);
  page(c, `${u.first_name} ${u.last_name}`, <>
    <Kpis items={[['Wallet', <N k={walletBalance(u.id)} />], ['Reserved', <N k={reservedBalance(u.id)} />], ['In trades', <N k={trades.filter((t) => ['active', 'matured'].includes(t.status)).reduce((s, t) => s + t.amount, 0)} />], ['Identity', <S s={u.kyc_status} />, u.kyc_method || ''], ['Referred', refs.length]]} />
    <div className="grid-2 top">
      <Box title="Profile"><dl className="kv">
        <dt>Email</dt><dd>{u.email} {u.email_verified_at ? '✓' : '(unconfirmed)'}</dd><dt>Phone</dt><dd>{u.phone || '—'} {u.phone_verified_at ? '✓' : ''}</dd>
        <dt>Country / city</dt><dd>{u.country} {u.city}</dd><dt>Language</dt><dd>{u.lang}</dd><dt>Next of kin</dt><dd>{u.next_of_kin_name} {u.next_of_kin_phone}</dd>
        <dt>Referral code</dt><dd>{u.referral_code}{u.referred_by ? ` · referred by ${who(u.referred_by)}` : ''}</dd><dt>2FA</dt><dd>{u.totp_enabled ? 'On' : 'Off'}</dd>
        <dt>Joined</dt><dd><D v={u.created_at} /></dd><dt>Circles pilot</dt><dd>{u.circle_pilot ? 'Yes' : 'No'}</dd>
        {u.id_doc_path && <><dt>ID document</dt><dd><a href={`/admin/files/${u.id_doc_path}`}>View</a></dd></>}
      </dl>
        <div className="btn-row">
          {u.status === 'active' ? <Act action={`/admin/champions/${u.id}/status`} fields={{ to: 'suspended' }} label="Suspend" tone="danger" confirm="Suspend this account? They will be signed out." /> : <Act action={`/admin/champions/${u.id}/status`} fields={{ to: 'active' }} label="Reactivate" tone="green" />}
          <Act action={`/admin/champions/${u.id}/pilot`} label={u.circle_pilot ? 'Remove from Circles pilot' : 'Add to Circles pilot'} />
          {u.totp_enabled ? <Act action={`/admin/champions/${u.id}/reset-2fa`} label="Reset 2FA" confirm="Turn off two-step verification for this Champion (after verifying their identity by phone)?" /> : null}
        </div>
      </Box>
      <Box title="Internal notes"><Form action={`/admin/champions/${u.id}/notes`} className="stack"><F label="Notes (staff only)" name="notes" type="textarea" value={notes} rows={4} /></Form></Box>
    </div>
    <Box title="Trades"><Table rows={trades} cols={[['Certificate', (t) => t.certificate_no], ['Lot', (t) => t.code], ['Amount', (t) => <N k={t.amount} />], ['Matures', (t) => <D v={t.matures_at} />], ['Status', (t) => <S s={t.status} />]]} /></Box>
    <div className="grid-2 top">
      <Box title="Bank accounts"><Table rows={banks} cols={[['Bank', (b) => b.bank_name || b.country], ['Account', (b) => b.account_number === 'INTL' ? <span className="small">{b.details}</span> : `${b.account_number} · ${b.account_name}`], ['Name match', (b) => b.name_match ? '✓' : '—'], ['Active', (b) => b.active ? '✓' : '—']]} /></Box>
      <Box title="Recent log-ins"><Table rows={logins} cols={[['When', (l) => <D v={l.created_at} time />], ['IP', (l) => l.ip], ['Result', (l) => l.success ? '✓' : '✗']]} /></Box>
    </div>
    <Box title="Wallet statement"><Table rows={q.all<any>(`SELECT j.kind, j.memo, e.amount, e.created_at FROM entries e JOIN journals j ON j.id=e.journal_id JOIN ledger_accounts a ON a.id=e.account_id WHERE a.code=? ORDER BY e.id DESC LIMIT 50`, `wallet:${u.id}`)} cols={[['Date', (r) => <D v={r.created_at} time />], ['Type', (r) => r.kind], ['Memo', (r) => r.memo], ['Amount', (r) => <N k={r.amount} />, 'num']]} /></Box>
  </>);
});
post('/admin/champions/:id/status', 'admin:support', (c) => {
  const id = Number(c.params.id), to = c.str('to') === 'suspended' ? 'suspended' : 'active';
  if (id === c.user!.id) return c.back('/admin/champions', ['error', 'You cannot suspend yourself.']);
  q.run('UPDATE users SET status=? WHERE id=?', to, id);
  if (to === 'suspended') q.run('DELETE FROM sessions WHERE user_id=?', id);
  audit(c.user!.id, `user.${to}`, `user:${id}`, undefined, c.ip);
  c.redirect(`/admin/champions/${id}`, ['ok', `Account ${to}.`]);
});
post('/admin/champions/:id/pilot', 'admin:support', (c) => {
  q.run('UPDATE users SET circle_pilot=1-circle_pilot WHERE id=?', Number(c.params.id));
  audit(c.user!.id, 'user.circle_pilot', `user:${c.params.id}`, undefined, c.ip);
  c.redirect(`/admin/champions/${c.params.id}`, ['ok', 'Updated.']);
});
post('/admin/champions/:id/reset-2fa', 'admin:super', (c) => {
  q.run('UPDATE users SET totp_enabled=0, totp_secret=NULL WHERE id=?', Number(c.params.id));
  audit(c.user!.id, 'user.reset_2fa', `user:${c.params.id}`, undefined, c.ip);
  c.redirect(`/admin/champions/${c.params.id}`, ['ok', 'Two-step verification turned off.']);
});
post('/admin/champions/:id/notes', 'admin:support', (c) => {
  q.run('UPDATE users SET notes=? WHERE id=?', c.str('notes', 4000), Number(c.params.id));
  c.redirect(`/admin/champions/${c.params.id}`, ['ok', 'Notes saved.']);
});

// ============ Verification ============
get('/admin/verification', 'admin:support', (c) => {
  const rows = q.all<any>("SELECT * FROM users WHERE kyc_status='pending' ORDER BY id");
  page(c, 'Identity verification', <Box title={`Waiting (${rows.length})`}>
    <p className="muted small">Nigerian Champions are verified automatically through Paystack (BVN + bank account); they appear here only while Paystack is checking. Champions outside Nigeria upload an ID for manual review.</p>
    <Table rows={rows} cols={[
      ['Champion', (u) => <a href={`/admin/champions/${u.id}`}>{u.first_name} {u.last_name}</a>], ['Country', (u) => u.country], ['Method', (u) => u.kyc_method],
      ['Document', (u) => u.id_doc_path ? <a href={`/admin/files/${u.id_doc_path}`} target="_blank">Open</a> : '—'],
      ['', (u) => <div className="btn-row"><Act action={`/admin/verification/${u.id}`} fields={{ result: 'verified' }} label="Approve" tone="green" />
        <form method="post" action={`/admin/verification/${u.id}`} className="inline-form"><Csrf /><input type="hidden" name="result" value="rejected" /><input name="reason" placeholder="Reason for rejection" required aria-label="Reason" /><button className="btn btn-danger btn-sm">Reject</button></form></div>],
    ]} empty="No identity checks waiting." />
  </Box>);
});
post('/admin/verification/:id', 'admin:support', (c) => {
  const u = userById(Number(c.params.id));
  if (!u) throw new HttpError(404, 'Not found');
  const ok = c.str('result') === 'verified';
  q.run('UPDATE users SET kyc_status=?, kyc_note=? WHERE id=?', ok ? 'verified' : 'rejected', ok ? null : c.str('reason', 300), u.id);
  notify(u, ok ? 'kyc_verified' : 'kyc_rejected', { reason: c.str('reason', 300) }, { link: '/app/profile', sms: true });
  audit(c.user!.id, `kyc.${ok ? 'approve' : 'reject'}`, `user:${u.id}`, c.str('reason'), c.ip);
  c.redirect('/admin/verification', ['ok', ok ? 'Verified.' : 'Rejected.']);
});

// ============ Harvest Circles ============
get('/admin/circles', 'admin:operations', (c) => {
  const s = settings();
  const lots = allLots().filter((l) => l.status === 'open' && l.circles_enabled);
  page(c, 'Harvest Circles', <>
    <Box title="Feature switch">
      <p>Current setting: <b>{s.circles_mode === 'off' ? 'Off — hidden everywhere' : s.circles_mode === 'pilot' ? 'Invite-only pilot — only Champions you add to the pilot (and admins)' : 'On — visible to everyone'}</b>.
        {c.can('super') ? <> Change it in <a href="/admin/settings#features">Settings → Features</a>.</> : ' Only a super admin can change it.'}</p>
      <p className="muted small">Pilot members are managed on each Champion's page. Pilot members now: {q.val('SELECT COUNT(*) FROM users WHERE circle_pilot=1')}.</p>
    </Box>
    <Box title="Open a public circle">
      {lots.length === 0 ? <p className="muted">No open lots allow circles. Tick “Allow Harvest Circles” on a lot first.</p> : (
        <Form action="/admin/circles" submit="Open circle">
          <F label="Lot" name="lot_id" options={lots.map((l) => [String(l.id), `${l.code} · ${l.title} (${fmtNGN(lotRemaining(l))} left)`])} />
          <F label="Circle name" name="name" value="Community Circle" required />
          <F label="Slots" name="slots" type="number" value={25} required />
          <F label="Slot price (₦)" name="slot_price" value="10,000" required />
          <F label="Fill deadline (days)" name="days" type="number" value={s.circle_deadline_days} />
          <F label="Max share one Champion can hold (%)" name="share" type="number" value={s.circle_max_share_pct} />
        </Form>
      )}
    </Box>
    <Box title="All circles" actions={<Act action="/admin/circles/expire" label="Release expired circles now" />}>
      <Table rows={allCircles()} cols={[['Circle', (ci) => <a href={`/app/circles/${ci.id}`}>{ci.name}</a>], ['Lot', (ci) => ci.lot_title], ['Slots', (ci) => `${ci.taken}/${ci.slots}`], ['Slot price', (ci) => <N k={ci.slot_price} />], ['Deadline', (ci) => <D v={ci.deadline} />], ['Type', (ci) => ci.is_private ? `Private (${who(ci.creator_id)})` : 'Public'], ['Status', (ci) => <S s={ci.status} />],
        ['', (ci) => ci.status === 'filling' ? <Act action={`/admin/circles/${ci.id}/cancel`} label="Cancel & release" tone="danger" confirm="Release every reservation in this circle?" /> : null]]} />
    </Box>
  </>);
});
post('/admin/circles', 'admin:operations', (c) => {
  try {
    const ci = createCircle({ lotId: c.int('lot_id'), name: c.str('name', 60), slots: Math.max(2, c.int('slots')), slotPrice: parseNaira(c.body.slot_price), creatorId: null, isPrivate: false, deadlineDays: c.int('days') || undefined, maxSharePct: c.int('share') || undefined });
    audit(c.user!.id, 'circle.create', `circle:${ci.id}`, undefined, c.ip);
    c.redirect('/admin/circles', ['ok', `Circle opened: ${ci.name}.`]);
  } catch (e: any) { c.redirect('/admin/circles', ['error', e.key ? c.t(e.key, e.vars) : e.message]); }
});
post('/admin/circles/expire', 'admin:operations', (c) => c.redirect('/admin/circles', ['ok', `${expireCircles(c.user!.id)} circles released.`]));
post('/admin/circles/:id/cancel', 'admin:operations', (c) => {
  const ci = getCircle(Number(c.params.id));
  if (!ci || ci.status !== 'filling') throw new HttpError(404, 'Not found');
  q.run('UPDATE circles SET deadline=? WHERE id=?', now(), ci.id);
  expireCircles(c.user!.id);
  q.run("UPDATE circles SET status='cancelled' WHERE id=?", ci.id);
  c.redirect('/admin/circles', ['ok', 'Circle cancelled and reservations released.']);
});

// ============ Prices & commodities ============
get('/admin/prices', 'admin:operations', (c) => {
  const s = settings();
  const latest = new Map(latestPrices().map((p) => [p.commodity, p]));
  const comms = commodities();
  const held = q.all<any>("SELECT p.*, c.name FROM prices p JOIN commodities c ON c.code=p.commodity WHERE p.status='held' ORDER BY p.id DESC");
  const sources = q.all<any>('SELECT * FROM price_sources ORDER BY id');
  const pending = c.cookies.price_confirm ? JSON.parse(Buffer.from(c.cookies.price_confirm, 'base64url').toString() || '[]') : [];
  page(c, 'Prices', <>
    <Box title="Today's prices" id="today">
      <p className="muted small">All prices are in naira per kilogram. Type today's price for any commodity and publish. Your prices appear on the ticker straight away and take priority over crawled prices. Leave a row blank to keep its current price.</p>
      {pending.length > 0 && <div className="flash flash-info">Some prices moved more than {s.price_hold_threshold_pct}% — check them below and click Publish again to confirm: {pending.filter((p: any) => p.big).map((p: any) => `${p.name} ${p.pct > 0 ? '+' : ''}${p.pct}%`).join(', ')}</div>}
      <form method="post" action="/admin/prices/manual">
        <Csrf />
        {pending.length > 0 && <input type="hidden" name="confirm" value="1" />}
        <F label="Market / location (optional)" name="market" value={c.cookies.price_market || ''} />
        <Table rows={comms.filter((x) => x.active)} cols={[
          ['Commodity', (x) => <b>{x.name}</b>],
          ['Current (₦/kg)', (x) => { const p = latest.get(x.code); return p ? <span>{fmtNGN(p.price_per_kg)} <span className="muted small">{p.observed_on} · {p.source_name}</span></span> : <span className="muted">none</span>; }],
          ['New price (₦ per kg)', (x) => { const pv = pending.find((p: any) => p.code === x.code); return <input name={`p_${x.code}`} inputMode="decimal" defaultValue={pv ? pv.raw : ''} aria-label={`New price for ${x.name}`} className={pv?.big ? 'warn' : ''} />; }],
        ]} />
        <button className="btn btn-primary" type="submit">Publish prices</button>
      </form>
    </Box>
    {held.length > 0 && <Box title="Held for review (large moves from the crawler)"><Table rows={held} cols={[['Commodity', (p) => p.name], ['Price', (p) => <N k={p.price_per_kg} />], ['Change', (p) => `${p.change_pct}%`], ['Source', (p) => p.source_name], ['Date', (p) => p.observed_on],
      ['', (p) => <div className="btn-row"><Act action={`/admin/prices/${p.id}/approve`} label="Publish" tone="green" /><Act action={`/admin/prices/${p.id}/reject`} label="Reject" tone="danger" /></div>]]} /></Box>}
    <Box title="Commodities" id="commodities">
      <Table rows={comms} cols={[['Name', (x) => x.name], ['Code', (x) => <code>{x.code}</code>], ['Order', (x) => x.sort], ['On ticker', (x) => x.active ? 'Yes' : 'Hidden'],
        ['', (x) => <details className="menu inline-edit"><summary className="btn btn-ghost btn-sm">Edit</summary>
          <form method="post" action={`/admin/commodities/${x.code}`} className="stack"><Csrf />
            <F label="Name" name="name" value={x.name} required /><F label="Order" name="sort" type="number" value={x.sort} />
            <F label="Show on ticker and in forms" name="active" type="checkbox" value={x.active} />
            <button className="btn btn-primary btn-sm" type="submit">Save</button></form></details>]]} />
      <h3>Add a commodity</h3>
      <Form action="/admin/commodities" submit="Add commodity">
        <F label="Name" name="name" required hint="e.g. Cashew, Ginger, Shea nut" />
        <F label="First price (₦ per kg, optional)" name="price" />
      </Form>
    </Box>
    <Box title="Daily crawler" id="crawler" actions={<div className="btn-row">
      <Act action="/admin/prices/crawler" fields={{ on: s.price_crawler_enabled ? 0 : 1 }} label={s.price_crawler_enabled ? 'Turn crawler off (manual prices only)' : 'Turn crawler on'} tone={s.price_crawler_enabled ? 'ghost' : 'green'} />
      {s.price_crawler_enabled && <Act action="/admin/prices/crawl" label="Run crawler now" />}</div>}>
      <p>Status: <b>{s.price_crawler_enabled ? 'On — runs every morning at 06:00 Lagos time' : 'Off — prices come only from this page and Kitovu eProcure'}</b>. The crawler respects each site's robots.txt and holds moves over {s.price_hold_threshold_pct}% for review.</p>
      <Table rows={sources} cols={[['Source', (x) => <><b>{x.name}</b><br /><a className="small" href={x.url} target="_blank" rel="noopener">{x.url}</a></>], ['Type', (x) => x.kind], ['Enabled', (x) => x.enabled ? 'Yes' : 'No'],
        ['Last run', (x) => <><D v={x.last_run_at} time /><br /><span className="small muted">{x.last_status}</span></>],
        ['', (x) => <div className="btn-row"><Act action={`/admin/price-sources/${x.id}/toggle`} label={x.enabled ? 'Disable' : 'Enable'} />
          <details className="menu inline-edit"><summary className="btn btn-ghost btn-sm">Settings</summary><form method="post" action={`/admin/price-sources/${x.id}`} className="stack"><Csrf />
            <F label="URL" name="url" value={x.url} /><F label="Type" name="kind" value={x.kind} options={[['table', 'HTML table'], ['pattern_all', 'Text pattern, many markets'], ['html', 'Text pattern'], ['json', 'JSON feed'], ['csv', 'CSV feed']]} />
            <F label="Parser settings (JSON)" name="config" type="textarea" value={JSON.stringify(JSON.parse(x.config || '{}'), null, 2)} rows={10} />
            <button className="btn btn-primary btn-sm" type="submit">Save</button></form></details></div>]]} />
      <h3>Add a source</h3>
      <Form action="/admin/price-sources" submit="Add source">
        <F label="Name" name="name" required /><F label="URL" name="url" type="url" required />
        <F label="Type" name="kind" options={[['table', 'HTML table'], ['pattern_all', 'Text pattern, many markets'], ['html', 'Text pattern'], ['json', 'JSON feed'], ['csv', 'CSV feed']]} />
      </Form>
      <p className="muted small">Kitovu eProcure can push its own buying prices to <code>POST {config.baseUrl}/api/prices/ingest</code> with the CRON_SECRET bearer token.</p>
    </Box>
  </>);
});
post('/admin/prices/manual', 'admin:operations', (c) => {
  const market = c.str('market', 80) || null;
  c.setCookie('price_market', market || '', { maxAge: 86400 * 90 });
  const latest = new Map(latestPrices().map((p) => [p.commodity, p]));
  const entries: { code: string; name: string; perKg: number; raw: string; pct: number | null }[] = [];
  for (const x of commodities().filter((x) => x.active)) {
    const raw = c.str(`p_${x.code}`, 20);
    if (!raw) continue;
    const v = Number(raw.replace(/[₦,\s]/g, ''));
    if (!(v > 0)) return c.redirect('/admin/prices', ['error', `Invalid price for ${x.name}.`]);
    const perKg = Math.round(v * 100); // all prices are ₦ per kg
    const prev = latest.get(x.code)?.price_per_kg;
    entries.push({ code: x.code, name: x.name, perKg, raw, pct: prev ? Math.round(((perKg - prev) / prev) * 1000) / 10 : null });
  }
  if (!entries.length) return c.redirect('/admin/prices', ['error', 'Enter at least one price.']);
  const big = entries.filter((e) => e.pct !== null && Math.abs(e.pct) > settings().price_hold_threshold_pct);
  if (big.length && !c.bool('confirm')) {
    c.setCookie('price_confirm', Buffer.from(JSON.stringify(entries.map((e) => ({ code: e.code, name: e.name, raw: e.raw, pct: e.pct, big: big.some((b) => b.code === e.code) })))).toString('base64url'), { maxAge: 600 });
    return c.redirect('/admin/prices#today');
  }
  c.setCookie('price_confirm', '', { maxAge: 0 });
  for (const e of entries) recordPrice({ commodity: e.code, pricePerKg: e.perKg, market, sourceName: 'Kitovu', by: c.user!.id, force: true });
  audit(c.user!.id, 'prices.manual', undefined, entries.map((e) => `${e.code}=${e.perKg}`).join(', '), c.ip);
  c.redirect('/admin/prices', ['ok', `${entries.length} prices published.`]);
});
post('/admin/prices/:id/:action', 'admin:operations', (c) => {
  const st = c.params.action === 'approve' ? 'published' : 'rejected';
  q.run("UPDATE prices SET status=?, reviewed_by=? WHERE id=? AND status='held'", st, c.user!.id, Number(c.params.id));
  audit(c.user!.id, `price.${c.params.action}`, `price:${c.params.id}`, undefined, c.ip);
  c.redirect('/admin/prices', ['ok', 'Done.']);
});
post('/admin/prices/crawler', 'admin:operations', (c) => {
  setSetting('price_crawler_enabled', c.int('on') === 1);
  audit(c.user!.id, 'setting.price_crawler_enabled', undefined, c.int('on') === 1, c.ip);
  c.redirect('/admin/prices#crawler', ['ok', c.int('on') === 1 ? 'Crawler on.' : 'Crawler off. Prices now come only from manual entry and eProcure.']);
});
post('/admin/prices/crawl', 'admin:operations', async (c) => {
  const r = await crawlPrices(c.user!.id);
  c.redirect('/admin/prices#crawler', ['ok', r.map((x) => `${x.source}: ${x.status}`).join(' · ') || 'No sources enabled.']);
});
get('/admin/commodities/new', 'admin:operations', (c) => {
  const back = String(c.query.back || '');
  page(c, 'Add a commodity', <Box>
    <Form action="/admin/commodities" submit="Add commodity">
      <input type="hidden" name="back" value={back.startsWith('/admin/') ? back : ''} />
      <F label="Name" name="name" required hint="e.g. Ginger, Shea nut, Groundnut. It appears in lot forms, prices and the ticker straight away." />
      <F label="First price (₦ per kg, optional)" name="price" />
    </Form></Box>);
});
post('/admin/commodities', 'admin:operations', (c) => {
  const name = c.str('name', 60);
  const back = c.str('back', 200);
  const to = back.startsWith('/admin/') && !back.startsWith('//') ? back : '/admin/prices#commodities';
  if (!name) return c.redirect(to, ['error', 'Enter a name.']);
  const code = slugify(name).replace(/-/g, '_').slice(0, 30);
  if (q.get('SELECT 1 FROM commodities WHERE code=?', code)) return c.redirect(to, ['error', `${name} already exists.`]);
  q.insert('commodities', { code, name, bag_kg: 100, active: 1, sort: Number(q.val('SELECT COALESCE(MAX(sort),0)+1 FROM commodities')) });
  const price = Number(String(c.body.price || '').replace(/[₦,\s]/g, ''));
  if (price > 0) recordPrice({ commodity: code, pricePerKg: Math.round(price * 100), sourceName: 'Kitovu', by: c.user!.id, force: true });
  audit(c.user!.id, 'commodity.add', code, name, c.ip);
  c.redirect(to, ['ok', `${name} added.`]);
});
post('/admin/commodities/:code', 'admin:operations', (c) => {
  q.run('UPDATE commodities SET name=?, sort=?, active=? WHERE code=?', c.str('name', 60), c.int('sort'), c.bool('active') ? 1 : 0, c.params.code);
  audit(c.user!.id, 'commodity.update', c.params.code, undefined, c.ip);
  c.redirect('/admin/prices#commodities', ['ok', 'Saved.']);
});
post('/admin/price-sources', 'admin:operations', (c) => {
  q.insert('price_sources', { name: c.str('name', 80), url: c.str('url', 500), kind: c.str('kind', 20), config: '{"aliases":{}}', enabled: 0 });
  c.redirect('/admin/prices#crawler', ['ok', 'Source added (disabled). Fill in its parser settings, then enable it.']);
});
post('/admin/price-sources/:id/toggle', 'admin:operations', (c) => {
  q.run('UPDATE price_sources SET enabled=1-enabled WHERE id=?', Number(c.params.id));
  audit(c.user!.id, 'price_source.toggle', `source:${c.params.id}`, undefined, c.ip);
  c.redirect('/admin/prices#crawler', ['ok', 'Updated.']);
});
post('/admin/price-sources/:id', 'admin:operations', (c) => {
  let cfg: unknown;
  try { cfg = JSON.parse(c.str('config', 10000) || '{}'); } catch { return c.redirect('/admin/prices#crawler', ['error', 'Parser settings must be valid JSON.']); }
  q.run('UPDATE price_sources SET url=?, kind=?, config=? WHERE id=?', c.str('url', 500), c.str('kind', 20), JSON.stringify(cfg), Number(c.params.id));
  c.redirect('/admin/prices#crawler', ['ok', 'Saved.']);
});

// ============ Activity feed ============
get('/admin/feed', 'admin:content', (c) => {
  const rows = q.all<any>('SELECT a.*, u.first_name, u.last_name, u.city, u.feed_opt_in FROM activity a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 100');
  page(c, 'Activity feed', <>
    <Box title="How it works"><p>The feed shows only real events from the last 48 hours: sign-ups, trades, filled circles and payouts. Names appear only for Champions who opted in (first name, last initial, city). Amounts are never shown. When there's little activity, it shows true site totals instead.</p>
      <p>Feed is <b>{settings().feed_enabled ? 'on' : 'off'}</b>. <Act action="/admin/feed/toggle" label={settings().feed_enabled ? 'Turn feed off' : 'Turn feed on'} /></p></Box>
    <Box title="Recent events"><Table rows={rows} cols={[['When', (a) => <D v={a.created_at} time />], ['Event', (a) => a.kind], ['Champion', (a) => a.first_name ? `${a.first_name} ${String(a.last_name).slice(0, 1)}. ${a.feed_opt_in ? '' : '(anonymous)'}` : '—'], ['Data', (a) => <span className="small">{a.data}</span>], ['Shown', (a) => a.hidden ? 'Hidden' : 'Yes'],
      ['', (a) => <Act action={`/admin/feed/${a.id}/toggle`} label={a.hidden ? 'Show' : 'Hide'} />]]} /></Box>
  </>);
});
post('/admin/feed/toggle', 'admin:content', (c) => { setSetting('feed_enabled', !settings().feed_enabled); audit(c.user!.id, 'setting.feed_enabled', undefined, settings().feed_enabled, c.ip); c.redirect('/admin/feed', ['ok', 'Updated.']); });
post('/admin/feed/:id/toggle', 'admin:content', (c) => { q.run('UPDATE activity SET hidden=1-hidden WHERE id=?', Number(c.params.id)); c.redirect('/admin/feed', ['ok', 'Updated.']); });

// ============ Chronicles (blog) ============
get('/admin/posts', 'admin:content', (c) => {
  const rows = q.all<any>('SELECT * FROM posts ORDER BY COALESCE(publish_at, created_at) DESC');
  page(c, 'Harvest Champions Chronicles', <Box><Table rows={rows} cols={[
    ['Title', (p) => <><a href={`/admin/posts/${p.id}`}><b>{p.title}</b></a><br /><span className="muted small">/chronicles/{p.slug}</span></>], ['Language', (p) => p.lang], ['Category', (p) => p.category],
    ['Status', (p) => <S s={p.status} />], ['Publish', (p) => <D v={p.publish_at || p.created_at} time />], ['', (p) => p.status === 'published' ? <a href={`/chronicles/${p.slug}`} target="_blank">View</a> : null],
  ]} /></Box>, <a className="btn btn-primary" href="/admin/posts/new">New post</a>);
});
function PostForm({ p }: { p?: any }) {
  return (
    <Form action={p ? `/admin/posts/${p.id}` : '/admin/posts/new'} multipart submit="Save post">
      <F label="Title" name="title" value={p?.title} required />
      <F label="URL slug" name="slug" value={p?.slug} hint="Use the same slug for translations of the same post." />
      <F label="Language" name="lang" value={p?.lang || 'en'} options={LANGS.map((l) => [l.code, l.label])} />
      <F label="Category" name="category" value={p?.category} options={CATEGORIES.map((k) => [k, k.replace(/-/g, ' ')])} />
      <F label="Author" name="author" value={p?.author || 'ComboTrader team'} />
      <F label="Status" name="status" value={p?.status || 'draft'} options={[['draft', 'Draft'], ['scheduled', 'Scheduled'], ['published', 'Published']]} />
      <F label="Publish at (Lagos time)" name="publish_at" type="datetime-local" value={p?.publish_at ? new Date(new Date(p.publish_at).getTime() + 3600e3).toISOString().slice(0, 16) : ''} />
      <div className="field"><label htmlFor="a-cover">Cover image</label><input id="a-cover" type="file" name="cover" accept="image/*" />{p?.cover_path && <img src={`/uploads/${p.cover_path}`} alt="" className="thumb" />}</div>
      <F label="Excerpt (one or two sentences)" name="excerpt" type="textarea" value={p?.excerpt} rows={2} />
      <F label="Body (Markdown: ## headings, **bold**, - lists, [links](https://…))" name="body" type="textarea" value={p?.body} rows={18} required />
    </Form>
  );
}
get('/admin/posts/new', 'admin:content', (c) => page(c, 'New post', <Box><PostForm /></Box>));
get('/admin/posts/:id', 'admin:content', (c) => {
  const p = q.get<any>('SELECT * FROM posts WHERE id=?', Number(c.params.id));
  if (!p) throw new HttpError(404, 'Not found');
  page(c, 'Edit post', <><Box><PostForm p={p} /></Box><Box><Act action={`/admin/posts/${p.id}/delete`} label="Delete post" tone="danger" confirm="Delete this post permanently?" /></Box></>);
});
async function savePost(c: Ctx, id?: number) {
  const lang = isLang(c.body.lang) ? c.body.lang : 'en';
  const slug = slugify(c.str('slug', 100) || c.str('title', 200)) || `post-${Date.now()}`;
  const dup = q.get<{ id: number }>('SELECT id FROM posts WHERE slug=? AND lang=?', slug, lang);
  if (dup && dup.id !== id) throw new HttpError(400, 'A post with this slug already exists in that language.');
  const pa = c.str('publish_at', 20);
  const data: any = {
    title: c.str('title', 200), slug, lang, category: CATEGORIES.includes(c.str('category')) ? c.str('category') : 'guides', author: c.str('author', 80) || 'ComboTrader team',
    status: ['draft', 'scheduled', 'published'].includes(c.str('status')) ? c.str('status') : 'draft', publish_at: pa ? new Date(new Date(`${pa}:00Z`).getTime() - 3600e3).toISOString() : (c.str('status') === 'published' ? now() : null),
    excerpt: c.str('excerpt', 400), body: String(c.body.body || ''), updated_at: now(),
  };
  const cover = await savePublicImage(c.files.cover, 1600);
  if (cover) data.cover_path = cover;
  if (id) q.update('posts', id, data); else id = q.insert('posts', { ...data, created_at: now() }).id;
  audit(c.user!.id, 'post.save', `post:${id}`, data.title, c.ip);
  return id;
}
post('/admin/posts/new', 'admin:content', async (c) => { const id = await savePost(c); c.redirect(`/admin/posts/${id}`, ['ok', 'Post saved.']); });
post('/admin/posts/:id', 'admin:content', async (c) => { await savePost(c, Number(c.params.id)); c.redirect(`/admin/posts/${c.params.id}`, ['ok', 'Post saved.']); });
post('/admin/posts/:id/delete', 'admin:content', (c) => { q.run('DELETE FROM posts WHERE id=?', Number(c.params.id)); audit(c.user!.id, 'post.delete', `post:${c.params.id}`, undefined, c.ip); c.redirect('/admin/posts', ['ok', 'Deleted.']); });

// ============ FAQs & page text ============
get('/admin/faqs', 'admin:content', (c) => {
  const lang: Lang = isLang(c.query.lang) ? (c.query.lang as Lang) : 'en';
  const faqs = q.all<any>('SELECT * FROM faqs WHERE lang=? ORDER BY sort, id', lang);
  const search = String(c.query.q || '').toLowerCase();
  const keys = allKeys().filter((k) => !search || k.toLowerCase().includes(search) || fileValue('en', k).toLowerCase().includes(search) || fileValue(lang, k).toLowerCase().includes(search)).slice(0, search ? 60 : 25);
  const overrides = new Map(q.all<any>('SELECT key, value FROM page_text WHERE lang=?', lang).map((r) => [r.key, r.value]));
  page(c, 'FAQs & page text', <>
    <div className="chips">{LANGS.map((l) => <a key={l.code} href={`/admin/faqs?lang=${l.code}`} aria-current={l.code === lang ? 'page' : undefined}>{l.label}</a>)}</div>
    <Box title={`FAQs — ${lang}`}>
      {faqs.map((f) => <details key={f.id} className="faq"><summary>{f.q}</summary>
        <form method="post" action={`/admin/faqs/${f.id}`} className="stack"><Csrf /><F label="Question" name="q" value={f.q} /><F label="Answer" name="a" type="textarea" value={f.a} rows={4} /><F label="Order" name="sort" type="number" value={f.sort} />
          <div className="btn-row"><button className="btn btn-primary btn-sm" type="submit">Save</button><button className="btn btn-danger btn-sm" name="delete" value="1" type="submit">Delete</button></div></form></details>)}
      <h3>Add a question</h3>
      <Form action="/admin/faqs" className="stack"><input type="hidden" name="lang" value={lang} /><F label="Question" name="q" required /><F label="Answer" name="a" type="textarea" required rows={4} /><F label="Order" name="sort" type="number" value={faqs.length + 1} /></Form>
    </Box>
    <Box title={`Page text — ${lang}`}>
      <p className="muted small">Every word on the public site and dashboard can be edited here, per language. Your edits override the built-in text. Keep placeholders like {'{rate}'} or {'{name}'} as they are.</p>
      <form method="get" className="inline-form"><input type="hidden" name="lang" value={lang} /><input type="search" name="q" defaultValue={search} placeholder="Search text, e.g. “home.h1” or “buyer”" aria-label="Search" /><button className="btn btn-ghost btn-sm">Search</button></form>
      <Table rows={keys} cols={[['Key', (k) => <code className="small">{k}</code>], ['Text', (k) => (
        <form method="post" action="/admin/page-text" className="pt-form"><Csrf /><input type="hidden" name="lang" value={lang} /><input type="hidden" name="key" value={k} />
          <textarea name="value" rows={2} defaultValue={overrides.get(k) ?? fileValue(lang, k) ?? ''} placeholder={fileValue('en', k)} aria-label={k} dir={lang === 'ar' ? 'rtl' : 'ltr'} />
          <div className="btn-row"><button className="btn btn-primary btn-sm">Save</button>{overrides.has(k) && <button className="btn btn-ghost btn-sm" name="reset" value="1">Reset to default</button>}{!fileValue(lang, k) && lang !== 'en' && <span className="tag tag-terra">untranslated</span>}</div></form>)]]} />
    </Box>
    <Box title="Legal pages (English, binding)">
      {Object.keys(LEGAL).map((k) => { const ov = q.get<any>("SELECT value FROM page_text WHERE key=? AND lang='en'", `legal.${k}.body`); return (
        <details key={k} className="faq"><summary>{k}</summary><form method="post" action="/admin/page-text" className="stack"><Csrf /><input type="hidden" name="lang" value="en" /><input type="hidden" name="key" value={`legal.${k}.body`} />
          <textarea name="value" rows={16} defaultValue={ov?.value || LEGAL[k]} aria-label={k} /><div className="btn-row"><button className="btn btn-primary btn-sm">Save</button>{ov && <button className="btn btn-ghost btn-sm" name="reset" value="1">Reset to draft</button>}</div></form></details>); })}
    </Box>
  </>);
});
post('/admin/faqs', 'admin:content', (c) => { q.insert('faqs', { lang: isLang(c.body.lang) ? c.body.lang : 'en', q: c.str('q', 300), a: c.str('a', 3000), sort: c.int('sort') }); c.back('/admin/faqs', ['ok', 'Added.']); });
post('/admin/faqs/:id', 'admin:content', (c) => {
  if (c.body.delete) q.run('DELETE FROM faqs WHERE id=?', Number(c.params.id));
  else q.run('UPDATE faqs SET q=?, a=?, sort=? WHERE id=?', c.str('q', 300), c.str('a', 3000), c.int('sort'), Number(c.params.id));
  c.back('/admin/faqs', ['ok', 'Saved.']);
});
post('/admin/page-text', 'admin:content', (c) => {
  const lang = isLang(c.body.lang) ? c.body.lang : 'en', key = c.str('key', 120);
  if (c.body.reset) q.run('DELETE FROM page_text WHERE key=? AND lang=?', key, lang);
  else q.run('INSERT INTO page_text (key, lang, value) VALUES (?,?,?) ON CONFLICT(key, lang) DO UPDATE SET value=excluded.value', key, lang, String(c.body.value || '').slice(0, 20000));
  clearOverrides();
  audit(c.user!.id, 'page_text.save', `${lang}:${key}`, undefined, c.ip);
  c.back('/admin/faqs', ['ok', 'Saved.']);
});

// ============ Newsletter ============
get('/admin/newsletter', 'admin:content', (c) => {
  const counts = q.all<any>('SELECT status, COUNT(*) n FROM subscribers GROUP BY status');
  const issues = q.all<any>('SELECT * FROM newsletters ORDER BY id DESC');
  const subs = q.all<any>('SELECT * FROM subscribers ORDER BY id DESC LIMIT 50');
  page(c, 'Harvest Champions Newsletter', <>
    <Kpis items={counts.map((r) => [r.status, r.n]) as any} />
    <Box title="Write an issue">
      <Form action="/admin/newsletter" submit="Save issue">
        <F label="Subject" name="subject" required />
        <F label="Send to" name="segment" options={[['all', 'All confirmed subscribers'], ['champions', 'Champions only'], ['visitors', 'Visitors (not Champions)']]} />
        <F label="Language" name="lang" options={[['', 'All languages'], ...LANGS.map((l) => [l.code, l.label] as [string, string])]} />
        <F label="Send at (Lagos time, blank = save as draft)" name="send_at" type="datetime-local" />
        <F label="Body (Markdown)" name="body" type="textarea" required rows={14} />
      </Form>
    </Box>
    <Box title="Issues"><Table rows={issues} cols={[['Subject', (n) => n.subject], ['Segment', (n) => `${n.segment}${n.lang ? ' · ' + n.lang : ''}`], ['Status', (n) => <S s={n.status} />], ['Send at', (n) => <D v={n.send_at} time />], ['Sent to', (n) => n.sent_count],
      ['', (n) => n.status !== 'sent' ? <Act action={`/admin/newsletter/${n.id}/send`} label="Send now" tone="green" confirm="Send this issue now?" /> : null]]} /></Box>
    <Box title="Latest subscribers" actions={<a className="btn btn-ghost btn-sm" href="/admin/reports/subscribers.csv">Export CSV</a>}><Table rows={subs} cols={[['Email', (s) => s.email], ['Language', (s) => s.lang], ['Status', (s) => <S s={s.status} />], ['Joined', (s) => <D v={s.created_at} />]]} /></Box>
  </>);
});
post('/admin/newsletter', 'admin:content', (c) => {
  const sa = c.str('send_at', 20);
  q.insert('newsletters', { subject: c.str('subject', 200), body: String(c.body.body || ''), segment: c.str('segment') || 'all', lang: isLang(c.body.lang) ? c.body.lang : null,
    status: sa ? 'scheduled' : 'draft', send_at: sa ? new Date(new Date(`${sa}:00Z`).getTime() - 3600e3).toISOString() : null, created_by: c.user!.id, created_at: now() });
  c.redirect('/admin/newsletter', ['ok', sa ? 'Issue scheduled.' : 'Draft saved.']);
});
post('/admin/newsletter/:id/send', 'admin:content', (c) => {
  const n = sendNewsletter(Number(c.params.id));
  audit(c.user!.id, 'newsletter.send', `newsletter:${c.params.id}`, n, c.ip);
  c.redirect('/admin/newsletter', ['ok', `Queued for ${n} subscribers.`]);
});

// ============ Referrals ============
get('/admin/referrals', 'admin:finance', (c) => {
  const rows = q.all<any>(`SELECT r.*, a.first_name AS rf, a.last_name AS rl, b.first_name AS df, b.last_name AS dl FROM referral_rewards r JOIN users a ON a.id=r.referrer_id JOIN users b ON b.id=r.referred_id ORDER BY r.id DESC LIMIT 100`);
  page(c, 'Referrals', <>
    <Kpis items={[['Rewards paid', <N k={-balance('kitovu:referrals')} />], ['Held for review', rows.filter((r) => r.status === 'held').length], ['Reward per referral', <N k={settings().referral_reward} />, 'Change in Settings']]} />
    <Box title="Rewards"><p className="muted small">Rewards are paid when the referred friend funds their first trade. Same bank account or same sign-in IP as the referrer holds the reward for review.</p>
      <Table rows={rows} cols={[['Date', (r) => <D v={r.created_at} />], ['Referrer', (r) => <a href={`/admin/champions/${r.referrer_id}`}>{r.rf} {r.rl}</a>], ['Friend', (r) => <a href={`/admin/champions/${r.referred_id}`}>{r.df} {r.dl}</a>], ['Amount', (r) => <N k={r.amount} />], ['Status', (r) => <><S s={r.status} /> {r.flagged && <span className="small muted">{r.flagged}</span>}</>],
        ['', (r) => r.status === 'held' ? <div className="btn-row"><Act action={`/admin/referrals/${r.id}/approve`} label="Pay reward" tone="green" /><Act action={`/admin/referrals/${r.id}/reject`} label="Reject" tone="danger" /></div> : null]]} /></Box>
  </>);
});
post('/admin/referrals/:id/:action', 'admin:finance', (c) => {
  const r = q.get<any>("SELECT * FROM referral_rewards WHERE id=? AND status='held'", Number(c.params.id));
  if (!r) throw new HttpError(404, 'Not found');
  if (c.params.action === 'approve') { creditReferral(r.referrer_id, userById(r.referred_id)!, r.amount, c.user!.id); q.run("UPDATE referral_rewards SET status='credited' WHERE id=?", r.id); }
  else q.run("UPDATE referral_rewards SET status='rejected' WHERE id=?", r.id);
  audit(c.user!.id, `referral.${c.params.action}`, `referral:${r.id}`, undefined, c.ip);
  c.redirect('/admin/referrals', ['ok', 'Done.']);
});

// ============ Messages & tickets ============
get('/admin/messages', 'admin:support', (c) => {
  const tickets = q.all<any>("SELECT t.*, u.first_name, u.last_name, u.email FROM tickets t JOIN users u ON u.id=t.user_id ORDER BY t.status='open' DESC, t.id DESC LIMIT 50");
  const contacts = q.all<any>('SELECT * FROM contact_messages ORDER BY id DESC LIMIT 30');
  const outbox = q.all<any>('SELECT * FROM outbox ORDER BY id DESC LIMIT 40');
  page(c, 'Messages & tickets', <>
    <Box title="Support tickets"><Table rows={tickets} cols={[['From', (t) => <a href={`/admin/champions/${t.user_id}`}>{t.first_name} {t.last_name}</a>], ['Message', (t) => <><b>{t.subject}</b><p className="small">{t.body}</p>{t.reply && <p className="small reply">↳ {t.reply}</p>}</>], ['Status', (t) => <S s={t.status} />],
      ['', (t) => t.status === 'open' ? <form method="post" action={`/admin/tickets/${t.id}`} className="stack"><Csrf /><textarea name="reply" rows={3} required aria-label="Reply" /><button className="btn btn-primary btn-sm">Reply & close</button></form> : null]]} empty="No tickets." /></Box>
    <Box title="Contact form"><Table rows={contacts} cols={[['When', (m) => <D v={m.created_at} time />], ['From', (m) => <>{m.name}<br /><a href={`mailto:${m.email}`}>{m.email}</a></>], ['Message', (m) => <span className="small">{m.message}</span>]]} /></Box>
    <Box title="Outgoing messages (email, SMS, WhatsApp)">
      <p className="muted small">{config.emailProvider ? `Email via ${config.emailProvider}.` : 'No email provider set — messages are held here (demo mode).'} {config.termiiKey ? 'SMS/WhatsApp via Termii.' : 'No SMS provider set.'}</p>
      <Table rows={outbox} cols={[['When', (m) => <D v={m.created_at} time />], ['Channel', (m) => m.channel], ['To', (m) => m.recipient], ['Subject / text', (m) => <span className="small">{m.subject || m.body.slice(0, 120)}</span>], ['Status', (m) => <><S s={m.status} /> <span className="small muted">{m.error}</span></>]]} />
    </Box>
  </>);
});
post('/admin/tickets/:id', 'admin:support', (c) => {
  const t = q.get<any>('SELECT * FROM tickets WHERE id=?', Number(c.params.id));
  if (!t) throw new HttpError(404, 'Not found');
  q.run("UPDATE tickets SET reply=?, status='closed' WHERE id=?", c.str('reply', 3000), t.id);
  const u = userById(t.user_id); if (u) notify(u, 'ticket_reply', { reply: c.str('reply', 3000) }, { link: '/app/support' });
  c.redirect('/admin/messages', ['ok', 'Reply sent.']);
});

// ============ Reports ============
get('/admin/reports', 'admin:finance', (c) => page(c, 'Reports', <Box><ul className="list">{[
  ['champions.csv', 'Champions (profile, verification, balances)'], ['trades.csv', 'All trades'], ['payouts-due.csv', 'Payouts due now'], ['withdrawals.csv', 'Withdrawals'],
  ['ledger.csv', 'Full ledger (every entry)'], ['payments.csv', 'Paystack payments'], ['subscribers.csv', 'Newsletter subscribers'], ['referrals.csv', 'Referral rewards'],
].map(([f, l]) => <li key={f}><span>{l}</span><a className="btn btn-ghost btn-sm" href={`/admin/reports/${f}`}>Download CSV</a></li>)}</ul></Box>));
get('/admin/reports/:file', 'admin:finance', (c) => {
  const f = c.params.file;
  audit(c.user!.id, 'report.export', f, undefined, c.ip);
  const k = (n: number | null) => (n == null ? '' : (n / 100).toFixed(2));
  const lotM = f.match(/^lot-(\d+)\.csv$/);
  if (lotM) return csv(c, `lot-${lotM[1]}`, q.all<any>('SELECT t.certificate_no, u.first_name, u.last_name, u.email, t.amount, t.status, t.start_at, t.matures_at FROM trades t JOIN users u ON u.id=t.user_id WHERE t.lot_id=?', Number(lotM[1])).map((r) => ({ ...r, amount: k(r.amount) })));
  switch (f) {
    case 'champions.csv': return csv(c, 'champions', q.all<any>("SELECT id, first_name, last_name, email, phone, country, city, lang, kyc_status, referral_code, created_at, status FROM users WHERE role='champion' ORDER BY id").map((u) => ({ ...u, wallet_ngn: k(walletBalance(u.id)) })));
    case 'trades.csv': return csv(c, 'trades', q.all<any>('SELECT t.certificate_no, l.code AS lot, u.email, t.amount, t.rate_bps, t.period_months, t.status, t.start_at, t.matures_at, t.earnings, t.paid_at FROM trades t JOIN lots l ON l.id=t.lot_id JOIN users u ON u.id=t.user_id ORDER BY t.id').map((r) => ({ ...r, amount: k(r.amount), earnings: k(r.earnings) })));
    case 'payouts-due.csv': return csv(c, 'payouts-due', duePayouts().map((t) => ({ certificate: t.certificate_no, champion: `${t.first_name} ${t.last_name}`, lot: t.lot_code, principal: k(t.amount), earnings: k(earningsFor(t.amount, t.rate_bps, t.period_months)), matured: t.matures_at })));
    case 'withdrawals.csv': return csv(c, 'withdrawals', q.all<any>('SELECT w.reference, u.email, w.amount, w.route, w.status, w.created_at, w.updated_at, w.note FROM withdrawals w JOIN users u ON u.id=w.user_id ORDER BY w.id').map((r) => ({ ...r, amount: k(r.amount) })));
    case 'ledger.csv': return csv(c, 'ledger', q.all<any>('SELECT e.id, e.created_at, j.id AS journal, j.kind, j.ref, j.memo, a.code AS account, e.amount FROM entries e JOIN journals j ON j.id=e.journal_id JOIN ledger_accounts a ON a.id=e.account_id ORDER BY e.id').map((r) => ({ ...r, amount: k(r.amount) })));
    case 'payments.csv': return csv(c, 'payments', q.all<any>('SELECT p.reference, u.email, p.amount, p.fee, p.status, p.channel, p.demo, p.created_at, p.paid_at FROM payments p JOIN users u ON u.id=p.user_id ORDER BY p.id').map((r) => ({ ...r, amount: k(r.amount), fee: k(r.fee) })));
    case 'subscribers.csv': return csv(c, 'subscribers', q.all('SELECT email, lang, status, created_at, confirmed_at FROM subscribers ORDER BY id'));
    case 'referrals.csv': return csv(c, 'referrals', q.all<any>('SELECT r.id, a.email AS referrer, b.email AS friend, r.amount, r.status, r.flagged, r.created_at FROM referral_rewards r JOIN users a ON a.id=r.referrer_id JOIN users b ON b.id=r.referred_id').map((r) => ({ ...r, amount: k(r.amount) })));
  }
  throw new HttpError(404, 'Unknown report');
});

// ============ Team & roles ============
const ROLES: [string, string][] = [['super', 'Super admin — everything, settings, team'], ['finance', 'Finance — payouts, withdrawals, ledger, reports'], ['operations', 'Operations — lots, trail, prices, circles'], ['content', 'Content — blog, FAQs, newsletter, feed'], ['support', 'Support — Champions, verification, tickets']];
get('/admin/team', 'admin:super', (c) => {
  const admins = q.all<any>("SELECT * FROM users WHERE role='admin' ORDER BY id");
  page(c, 'Team & roles', <>
    <Box title="Admins"><Table rows={admins} cols={[['Name', (u) => <>{u.first_name} {u.last_name}<br /><span className="muted small">{u.email}</span></>], ['2FA', (u) => u.totp_enabled ? '✓' : <span className="tag tag-red">off</span>],
      ['Roles', (u) => <form method="post" action={`/admin/team/${u.id}`} className="inline-form"><Csrf />{ROLES.map(([r]) => <label key={r} className="check small"><input type="checkbox" name="roles[]" value={r} defaultChecked={u.admin_roles.split(',').includes(r)} /> {r}</label>)}<button className="btn btn-ghost btn-sm">Save</button></form>],
      ['', (u) => u.id !== c.user!.id ? <Act action={`/admin/team/${u.id}/remove`} label="Remove admin" tone="danger" confirm="Remove admin access?" /> : null]]} /></Box>
    <Box title="Add an admin"><p className="muted small">The person must already have a ComboTrader account. They'll be asked to turn on two-step verification before using the admin area.</p>
      <Form action="/admin/team" submit="Give admin access"><F label="Email" name="email" type="email" required />
        <div className="field"><span className="label">Roles</span>{ROLES.map(([r, l]) => <label key={r} className="check"><input type="checkbox" name="roles[]" value={r} /> {l}</label>)}</div></Form></Box>
  </>);
});
const rolesFrom = (c: Ctx) => ([] as string[]).concat(c.body.roles || []).filter((r) => ROLES.some(([x]) => x === r)).join(',');
post('/admin/team', 'admin:super', (c) => {
  const u = userByEmail(c.str('email'));
  if (!u) return c.redirect('/admin/team', ['error', 'No account with that email. Ask them to sign up first.']);
  q.run("UPDATE users SET role='admin', admin_roles=? WHERE id=?", rolesFrom(c) || 'support', u.id);
  audit(c.user!.id, 'team.add', `user:${u.id}`, rolesFrom(c), c.ip);
  c.redirect('/admin/team', ['ok', `${u.first_name} is now an admin.`]);
});
post('/admin/team/:id', 'admin:super', (c) => {
  const roles = rolesFrom(c);
  if (Number(c.params.id) === c.user!.id && !roles.includes('super')) return c.redirect('/admin/team', ['error', 'You cannot remove your own super admin role.']);
  q.run('UPDATE users SET admin_roles=? WHERE id=?', roles, Number(c.params.id));
  audit(c.user!.id, 'team.roles', `user:${c.params.id}`, roles, c.ip);
  c.redirect('/admin/team', ['ok', 'Roles saved.']);
});
post('/admin/team/:id/remove', 'admin:super', (c) => {
  q.run("UPDATE users SET role='champion', admin_roles='' WHERE id=? AND id!=?", Number(c.params.id), c.user!.id);
  audit(c.user!.id, 'team.remove', `user:${c.params.id}`, undefined, c.ip);
  c.redirect('/admin/team', ['ok', 'Admin access removed.']);
});

// ============ Audit log ============
get('/admin/audit', 'admin:super', (c) => {
  const s = String(c.query.q || '');
  const rows = q.all<any>("SELECT a.*, u.first_name, u.last_name FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id WHERE (?='' OR a.action LIKE ? OR a.target LIKE ?) ORDER BY a.id DESC LIMIT 200", s, `%${s}%`, `%${s}%`);
  page(c, 'Audit log', <Box actions={<form method="get" className="inline-form"><input type="search" name="q" defaultValue={s} placeholder="Filter by action or target" aria-label="Filter" /><button className="btn btn-ghost btn-sm">Filter</button></form>}>
    <Table rows={rows} cols={[['When', (a) => <D v={a.created_at} time />], ['Who', (a) => a.first_name ? `${a.first_name} ${a.last_name}` : 'system'], ['Action', (a) => <code className="small">{a.action}</code>], ['Target', (a) => a.target], ['Detail', (a) => <span className="small">{String(a.detail || '').slice(0, 200)}</span>], ['IP', (a) => <span className="small">{a.ip}</span>]]} />
  </Box>);
});

// ============ Settings ============
get('/admin/settings', 'admin:super', (c) => {
  const s = settings();
  const fx = q.all<any>('SELECT * FROM fx_rates ORDER BY currency');
  page(c, 'Settings', <>
    <Box title="Features" id="features">
      <Form action="/admin/settings" submit="Save features">
        <F label="Harvest Circles" name="circles_mode" value={s.circles_mode} options={[['off', 'Off — hidden everywhere'], ['pilot', 'Invite-only pilot — pilot members and admins'], ['on', 'On — everyone']]} hint="Recommended: pilot until a capital-markets lawyer confirms the route for pooled small-sum offerings." />
        <F label="Circle fill deadline (days)" name="circle_deadline_days" type="number" value={s.circle_deadline_days} />
        <F label="Max share of a circle one Champion can hold (%)" name="circle_max_share_pct" type="number" value={s.circle_max_share_pct} />
        <F label="Live activity feed" name="feed_enabled" type="checkbox" value={s.feed_enabled} />
        <F label="Daily price crawler" name="price_crawler_enabled" type="checkbox" value={s.price_crawler_enabled} />
        <F label="Hold price moves larger than (%)" name="price_hold_threshold_pct" type="number" value={s.price_hold_threshold_pct} />
        <input type="hidden" name="_group" value="features" />
      </Form>
    </Box>
    <Box title="Payouts, plans, gifts and WhatsApp" id="payouts">
      <Form action="/admin/settings" submit="Save">
        <F label="Credit matured trades automatically on the payout date" name="auto_payouts" type="checkbox" value={s.auto_payouts} hint="Kitovu pays Champions on the payout date from its balance sheet. Turn off only to pay each trade by hand in Payouts." />
        <F label="Warn when treasury coverage falls below (e.g. 1.2 = 120%)" name="coverage_warn_ratio" type="number" step="0.05" value={s.coverage_warn_ratio} />
        <F label="Harvest Plan (monthly saving toward a lot)" name="plans_enabled" type="checkbox" value={s.plans_enabled} />
        <F label="Smallest monthly plan amount (₦)" name="plan_min_monthly" value={naira(s.plan_min_monthly)} />
        <F label="Pause a plan after this many failed card charges" name="plan_max_failures" type="number" value={s.plan_max_failures} />
        <F label="Gift a Harvest" name="gifts_enabled" type="checkbox" value={s.gifts_enabled} />
        <F label="WhatsApp companion replies" name="whatsapp_enabled" type="checkbox" value={s.whatsapp_enabled} />
        <input type="hidden" name="_group" value="payouts" />
      </Form>
    </Box>
    <Box title="AI agents" id="agents">
      <form method="post" action="/admin/settings" className="form-grid"><Csrf />
        <fieldset className="field"><legend>Agents switched on</legend>{['support', 'onboarding', 'treasury', 'risk', 'growth', 'ops', 'prospector', 'social', 'email'].map((a) => <label key={a} className="check"><input type="checkbox" name="agents_enabled[]" value={a} defaultChecked={String(s.agents_enabled).split(',').includes(a)} /> <span>{a}</span></label>)}</fieldset>
        <F label="Autonomy" name="agent_autonomy" value={s.agent_autonomy} options={[['review', 'Review everything — a person approves every message (recommended to start)'], ['auto_low', 'Send low-risk messages automatically (FAQ answers, onboarding nudges)']]} hint="Agents can never move money, approve withdrawals or change balances, whatever this says." />
        <F label="Maximum model calls per 24 hours" name="agent_daily_limit" type="number" value={s.agent_daily_limit} />
        <input type="hidden" name="_group" value="agents" />
        <div className="form-actions"><button className="btn btn-primary" type="submit">Save agents</button></div>
      </form>
    </Box>
    <Box title="Money rules">
      <Form action="/admin/settings" submit="Save money rules">
        <F label="Referral reward (₦)" name="referral_reward" value={naira(s.referral_reward)} />
        <F label="Minimum withdrawal (₦)" name="min_withdrawal" value={naira(s.min_withdrawal)} />
        <F label="Send withdrawals automatically up to (₦, 0 = always review)" name="auto_withdraw_limit" value={naira(s.auto_withdraw_limit)} />
        <F label="Two-admin approval above (₦)" name="dual_approval_threshold" value={naira(s.dual_approval_threshold)} />
        <F label="Identity check required after total funding of (₦)" name="kyc_required_above" value={naira(s.kyc_required_above)} />
        <F label="Pass card fees on to Champions" name="pass_card_fees" type="checkbox" value={s.pass_card_fees} />
        <input type="hidden" name="_group" value="money" />
      </Form>
    </Box>
    <Box title="Earnings rates by period" id="rates">
      <p className="muted small">The longer a Champion stays, the more they earn. A new trade locks in the rate for its period at the moment it is joined; changing these does not change existing trades.</p>
      <Form action="/admin/settings" submit="Save rates">
        <F label="4 months (% per annum)" name="rate_4" type="number" step="0.01" value={s.rate_4} />
        <F label="6 months (% per annum)" name="rate_6" type="number" step="0.01" value={s.rate_6} />
        <F label="9 months (% per annum)" name="rate_9" type="number" step="0.01" value={s.rate_9} />
        <F label="12 months (% per annum)" name="rate_12" type="number" step="0.01" value={s.rate_12} />
        <F label="Default minimum commitment for new lots (₦)" name="min_commit_default" value={naira(s.min_commit_default)} />
        <input type="hidden" name="_group" value="rates" />
      </Form>
    </Box>
    <Box title="Champion ranks">
      <p className="muted small">The homepage numbers (Champions, tons, payouts, farmers) are edited in <a href="/admin/figures">Homepage numbers</a>.</p>
      <Form action="/admin/settings" submit="Save">
        <F label="Rank thresholds in tons (Sprout, Harvester, Granary Keeper)" name="rank_thresholds" value={s.rank_thresholds} />
        <input type="hidden" name="_group" value="ranks" />
      </Form>
    </Box>
    <Box title="Contact details and site banner">
      <Form action="/admin/settings" submit="Save">
        <F label="Support phone" name="support_phone" value={s.support_phone} /><F label="Support WhatsApp" name="support_whatsapp" value={s.support_whatsapp} />
        <F label="Support email" name="support_email" value={s.support_email} /><F label="Site banner (blank = none)" name="maintenance_banner" value={s.maintenance_banner} />
        <input type="hidden" name="_group" value="contact" />
      </Form>
    </Box>
    <Box title="Exchange rates for approximate local amounts">
      <p className="muted small">Shown to Champions outside Nigeria as “≈ amount”. Wallets always stay in naira.</p>
      <Table rows={fx} cols={[['Currency', (r) => r.currency], ['Per ₦1', (r) => r.per_ngn], ['1 unit in ₦', (r) => (1 / r.per_ngn).toFixed(2)], ['Updated', (r) => <D v={r.updated_at} />]]} />
      <Form action="/admin/fx" submit="Save rate"><F label="Currency (e.g. USD)" name="currency" required /><F label="Naira per 1 unit (e.g. 1450)" name="ngn_per_unit" required /></Form>
    </Box>
    <Box title="Integrations (set in the server environment)">
      <dl className="kv">
        <dt>Paystack</dt><dd>{config.paystackDemo ? <span className="tag tag-terra">Demo mode — set PAYSTACK_SECRET_KEY</span> : 'Live keys set'}</dd>
        <dt>Paystack webhook URL</dt><dd><code>{config.baseUrl}/webhooks/paystack</code></dd>
        <dt>Email</dt><dd>{config.emailProvider || 'Not set (EMAIL_PROVIDER, EMAIL_API_KEY)'}</dd>
        <dt>SMS / WhatsApp</dt><dd>{config.termiiKey ? 'Termii' : 'Not set (TERMII_API_KEY)'}</dd>
        <dt>tawk.to</dt><dd>{config.tawkPropertyId ? `Property ${config.tawkPropertyId}` : 'Not set (TAWK_PROPERTY_ID)'}</dd>
        <dt>Google sign-in</dt><dd>{config.googleClientId ? 'On' : 'Off (GOOGLE_CLIENT_ID)'}</dd>
        <dt>Push alerts</dt><dd>{config.vapidPublic ? 'On' : 'Off (run npm run job -- vapid… see README)'}</dd>
        <dt>AI agents</dt><dd>{config.anthropicKey ? `Claude API (${config.aiModel})` : 'Demo mode (ANTHROPIC_API_KEY)'}</dd>
        <dt>WhatsApp</dt><dd>{config.waToken && config.waPhoneId ? `Cloud API${config.waNumber ? ` · +${config.waNumber}` : ''}` : 'Not set (WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID)'}</dd>
        <dt>Uptime check URL</dt><dd><code>{config.baseUrl}/healthz</code></dd>
      </dl>
    </Box>
  </>);
});
const MONEY_KEYS: SettingKey[] = ['referral_reward', 'min_withdrawal', 'auto_withdraw_limit', 'dual_approval_threshold', 'kyc_required_above', 'baseline_payouts', 'plan_min_monthly', 'min_commit_default'];
const GROUPS: Record<string, SettingKey[]> = {
  features: ['circles_mode', 'circle_deadline_days', 'circle_max_share_pct', 'feed_enabled', 'price_crawler_enabled', 'price_hold_threshold_pct'],
  money: ['referral_reward', 'min_withdrawal', 'auto_withdraw_limit', 'dual_approval_threshold', 'kyc_required_above', 'pass_card_fees'],
  figures: ['baseline_champions', 'baseline_tons', 'baseline_payouts', 'baseline_farmers', 'rank_thresholds'],
  contact: ['support_phone', 'support_whatsapp', 'support_email', 'maintenance_banner'],
  payouts: ['auto_payouts', 'coverage_warn_ratio', 'plans_enabled', 'plan_min_monthly', 'plan_max_failures', 'gifts_enabled', 'whatsapp_enabled'],
  agents: ['agents_enabled', 'agent_autonomy', 'agent_daily_limit'],
  ranks: ['rank_thresholds'],
  rates: ['rate_4', 'rate_6', 'rate_9', 'rate_12', 'min_commit_default'],
};
post('/admin/settings', 'admin:super', (c) => {
  const keys = GROUPS[c.str('_group')] || [];
  const changed: Record<string, unknown> = {};
  for (const k of keys) {
    const def = DEFAULTS[k];
    let v: unknown;
    if (typeof def === 'boolean') v = c.bool(k);
    else if (MONEY_KEYS.includes(k)) v = Math.round(Number(String(c.body[k] ?? '0').replace(/[₦,\s]/g, '')) * 100) || 0;
    else if (typeof def === 'number') v = Number(c.body[k]) || 0;
    else v = c.str(k, 500);
    if (k === 'circles_mode' && !['off', 'pilot', 'on'].includes(String(v))) continue;
    if (k === 'agent_autonomy' && !['review', 'auto_low'].includes(String(v))) continue;
    if (/^rate_\d+$/.test(k) && !(Number(v) > 0 && Number(v) <= 100)) continue;
    if (k === 'agents_enabled') v = (Array.isArray(c.body.agents_enabled) ? c.body.agents_enabled : [c.body.agents_enabled]).filter((x: unknown) => typeof x === 'string' && /^[a-z]+$/.test(x)).join(',');
    if (JSON.stringify(settings()[k]) !== JSON.stringify(v)) changed[k] = v;
    setSetting(k, v);
  }
  if (Object.keys(changed).length) audit(c.user!.id, 'settings.update', c.str('_group'), changed, c.ip);
  c.redirect('/admin/settings', ['ok', 'Settings saved.']);
});
post('/admin/fx', 'admin:super', (c) => {
  const cur = c.str('currency', 3).toUpperCase(), per = Number(String(c.body.ngn_per_unit).replace(/[,\s]/g, ''));
  if (!/^[A-Z]{3}$/.test(cur) || !(per > 0)) return c.redirect('/admin/settings', ['error', 'Enter a 3-letter currency and a positive rate.']);
  q.run('INSERT INTO fx_rates (currency, per_ngn, updated_at) VALUES (?,?,?) ON CONFLICT(currency) DO UPDATE SET per_ngn=excluded.per_ngn, updated_at=excluded.updated_at', cur, 1 / per, now());
  audit(c.user!.id, 'fx.update', cur, per, c.ip);
  c.redirect('/admin/settings', ['ok', `${cur} saved.`]);
});

export const _ = { escapeHtml, queueEmail, emailShell, siteStats, trailFor, postJournal };
