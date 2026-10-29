// Admin: Treasury (coverage of Champion payouts), AI agents inbox, WhatsApp, Plans & gifts, user import.
import { get, post } from '../lib/router';
import { render } from '../views/render';
import { AdminLayout } from '../views/layout';
import { Box, Kpis, Table, Act, F, Form, N, D, S, naira } from '../views/admin/ui';
import { Csrf } from '../views/components';
import { q, now } from '../lib/db';
import { coverage, receivables, latestCash, treasurySnapshot } from '../lib/treasury';
import { AGENTS, ACTION_KINDS, AGENT_JOBS, agentOn, executeAction, rejectAction, opsTrailDraft, opsLotDraft, type AgentName } from '../lib/agents';
import { aiLive, callsToday } from '../lib/ai';
import { handleInbound, waLive } from '../lib/whatsapp';
import { planSaved } from '../lib/plans';
import { importUsers, parseCsv } from '../lib/account';
import { getLot, allLots } from '../lib/trading';
import { settings, setSetting } from '../lib/settings';
import { savePublicImage } from '../lib/uploads';
import { audit } from '../lib/audit';
import { parseNaira, fmtNGN } from '../lib/util';
import { config } from '../lib/config';
import { HttpError, type Ctx } from '../lib/http';

const page = (c: Ctx, title: string, body: React.ReactNode, actions?: React.ReactNode) => render(c, <AdminLayout title={title} actions={actions}>{body}</AdminLayout>);
const pct = (r: number | null) => (r === null ? '—' : `${(r * 100).toFixed(0)}%`);

// ============ Treasury ============
get('/admin/treasury', 'admin:finance', (c) => {
  const hs = [7, 30, 60, 90].map(coverage);
  const recv = receivables();
  const cash = latestCash();
  const snap = treasurySnapshot();
  const brief = q.get<any>("SELECT * FROM agent_actions WHERE agent='treasury' ORDER BY id DESC LIMIT 1");
  page(c, 'Treasury', <>
    <p className="muted">Champions are paid on the payout date from Kitovu's balance sheet, whether or not the buyer has paid. This page shows whether cash, the credit line and buyer money due will cover what is owed.</p>
    <Kpis items={hs.map((h) => [`Due in ${h.horizon} days`, <N k={h.due.total} />, `${h.due.count} trades · available ${fmtNGN(h.available)} · coverage ${pct(h.ratio)}`] as [string, React.ReactNode, string])} />
    <div className="btn-row">{hs.map((h) => <span key={h.horizon} className={`tag cov-${h.level}`}>{h.horizon}d: {h.level === 'unknown' ? 'no cash position' : h.level}</span>)}</div>
    {brief && <Box title={`Treasury agent brief · ${brief.created_at.slice(0, 10)}`}><pre className="pre">{brief.summary}</pre></Box>}
    <div className="grid-2 top">
      <Box title="Cash position">
        {cash ? <p>Last recorded <b><N k={cash.amount} /></b> cash + <b><N k={cash.credit_line} /></b> undrawn credit line, as of <D v={cash.as_of} />. {cash.note && <span className="muted">({cash.note})</span>}</p> : <p className="flash flash-error">No cash position recorded. Coverage cannot be checked until you add one.</p>}
        <Form action="/admin/treasury/cash" submit="Record cash position">
          <F label="Cash available for payouts (₦)" name="amount" required hint="Paystack balance + Kitovu bank accounts set aside for Champion payouts." />
          <F label="Undrawn credit line (₦)" name="credit_line" value="0" />
          <F label="As of" name="as_of" type="date" value={now().slice(0, 10)} required />
          <F label="Note" name="note" />
        </Form>
      </Box>
      <Box title="Overdue buyers (Kitovu is covering these payouts)">
        {snap.overdue.length === 0 ? <p className="muted">No buyer is overdue.</p> : <Table rows={snap.overdue} cols={[['Lot', (r) => r.lot], ['Buyer', (r) => r.buyer], ['Outstanding', (r) => <N k={r.outstanding} />, 'num'], ['Days late', (r) => r.days]]} />}
        {snap.missingBuyerTerms.length > 0 && <p className="small">Add the buyer contract value and due date for: <b>{snap.missingBuyerTerms.join(', ')}</b> (below).</p>}
      </Box>
    </div>
    <Box title="Buyer receivables by lot">
      <Table rows={recv} cols={[
        ['Lot', (r) => <><a href={`/admin/lots/${r.id}`}><b>{r.code}</b></a><br /><span className="muted small">{r.title}</span></>], ['Buyer', (r) => r.buyer_name || r.buyer_type], ['Status', (r) => <S s={r.overdue ? 'overdue' : r.status} />],
        ['Buyer owes', (r) => r.buyer_amount ? <N k={r.buyer_amount} /> : <span className="muted">not set</span>, 'num'], ['Received', (r) => <N k={r.received} />, 'num'], ['Due', (r) => <D v={r.buyer_due_at} />],
        ['Owed to Champions', (r) => <><N k={r.champions_owed} /><br /><span className="muted small">from <D v={r.champions_due_at} /></span></>, 'num'],
        ['', (r) => <details><summary className="small">Update</summary>
          <form method="post" action={`/admin/treasury/lots/${r.id}/terms`} className="form-grid"><Csrf />
            <F label="Buyer contract value (₦)" name="buyer_amount" value={naira(r.buyer_amount)} /><F label="Buyer payment due" name="buyer_due_at" type="date" value={r.buyer_due_at?.slice(0, 10)} />
            <div className="form-actions"><button className="btn btn-ghost btn-sm">Save terms</button></div></form>
          <form method="post" action={`/admin/treasury/lots/${r.id}/payment`} className="form-grid"><Csrf />
            <F label="Buyer payment received (₦)" name="amount" required /><F label="Received on" name="received_at" type="date" value={now().slice(0, 10)} /><F label="Note / bank reference" name="note" />
            <div className="form-actions"><button className="btn btn-green btn-sm">Record payment</button></div></form></details>],
      ]} />
    </Box>
    <div className="btn-row"><Act action="/admin/agents/run/treasury" label="Run treasury agent now" /></div>
  </>);
});
post('/admin/treasury/cash', 'admin:finance', (c) => {
  const amount = parseNaira(c.body.amount);
  if (!amount && c.str('amount') !== '0') return c.redirect('/admin/treasury', ['error', 'Enter the cash amount.']);
  q.insert('cash_positions', { amount, credit_line: parseNaira(c.body.credit_line), note: c.str('note', 200) || null, as_of: new Date(`${c.str('as_of', 10)}T12:00:00Z`).toISOString(), created_by: c.user!.id, created_at: now() });
  audit(c.user!.id, 'treasury.cash', undefined, { amount }, c.ip);
  c.redirect('/admin/treasury', ['ok', 'Cash position recorded.']);
});
post('/admin/treasury/lots/:id/terms', 'admin:finance', (c) => {
  const l = getLot(Number(c.params.id)); if (!l) throw new HttpError(404, 'Not found');
  const due = c.str('buyer_due_at', 10);
  q.run('UPDATE lots SET buyer_amount=?, buyer_due_at=? WHERE id=?', parseNaira(c.body.buyer_amount) || null, due ? new Date(`${due}T12:00:00Z`).toISOString() : null, l.id);
  audit(c.user!.id, 'lot.buyer_terms', `lot:${l.id}`, { amount: c.body.buyer_amount, due }, c.ip);
  c.back('/admin/treasury', ['ok', 'Buyer terms saved.']);
});
post('/admin/treasury/lots/:id/payment', 'admin:finance', (c) => {
  const l = getLot(Number(c.params.id)); if (!l) throw new HttpError(404, 'Not found');
  const amount = parseNaira(c.body.amount);
  if (!amount) return c.back('/admin/treasury', ['error', 'Enter the amount received.']);
  q.insert('buyer_payments', { lot_id: l.id, amount, received_at: new Date(`${c.str('received_at', 10) || now().slice(0, 10)}T12:00:00Z`).toISOString(), note: c.str('note', 200) || null, created_by: c.user!.id, created_at: now() });
  audit(c.user!.id, 'lot.buyer_payment', `lot:${l.id}`, { amount }, c.ip);
  c.back('/admin/treasury', ['ok', `Recorded ${fmtNGN(amount)} from the buyer.`]);
});

// ============ AI agents ============
function payloadView(a: any) {
  const p = JSON.parse(a.payload || '{}');
  if (a.kind === 'send_message') return <><b>{p.title}</b><pre className="pre">{p.body}</pre></>;
  if (a.kind === 'reply_ticket') return <pre className="pre">{p.reply}</pre>;
  if (a.kind === 'trail_update') return <><b>{p.stage}</b><pre className="pre">{p.note}</pre></>;
  if (a.kind === 'draft_newsletter') return <><b>{p.subject}</b><pre className="pre">{p.body}</pre></>;
  if (a.kind === 'social_posts') return <>{(p.posts || []).map((x: string, i: number) => <pre key={i} className="pre">{x}</pre>)}</>;
  if (a.kind === 'admin_alert') return <pre className="pre">{p.body}</pre>;
  return <pre className="pre">{JSON.stringify(p, null, 2)}</pre>;
}
/** Which payload field an admin may edit before approving. */
const EDITABLE: Record<string, string> = { send_message: 'body', reply_ticket: 'reply', trail_update: 'note', draft_newsletter: 'body' };

get('/admin/agents', 'admin:any', (c) => {
  const status = String(c.query.status || 'proposed');
  const agent = String(c.query.agent || '');
  const rows = q.all<any>(`SELECT a.*, u.first_name, u.last_name FROM agent_actions a LEFT JOIN users u ON u.id=a.target_user_id WHERE (?='all' OR a.status=?) AND (?='' OR a.agent=?) ORDER BY CASE a.risk WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, a.id DESC LIMIT 60`, status, status, agent, agent);
  const runs = q.all<any>('SELECT agent, COUNT(*) n, SUM(tokens_in) tin, SUM(tokens_out) tout, SUM(CASE WHEN status!=\'ok\' THEN 1 ELSE 0 END) errs FROM agent_runs WHERE created_at>=? GROUP BY agent', new Date(Date.now() - 30 * 864e5).toISOString());
  const s = settings();
  const lots = allLots().filter((l) => ['open', 'filled', 'active'].includes(l.status));
  page(c, 'AI agents', <>
    <p className="muted">Agents propose; people decide. Agents cannot move money, approve withdrawals or change balances. {aiLive() ? <>Model: <b>{config.aiModel}</b> / <b>{config.aiModelFast}</b> · {callsToday()} of {s.agent_daily_limit} calls used in the last 24 hours.</> : <b>Demo mode: no ANTHROPIC_API_KEY, so agents draft from rules and templates.</b>} Autonomy: <b>{s.agent_autonomy === 'auto_low' ? 'low-risk messages send automatically' : 'everything waits for review'}</b>{c.can('super') && <> (<a href="/admin/settings#agents">change</a>)</>}.</p>
    <div className="btn-row">
      {['proposed', 'approved', 'auto', 'rejected', 'failed', 'all'].map((st) => <a key={st} className={`btn btn-sm ${st === status ? 'btn-primary' : 'btn-ghost'}`} href={`/admin/agents?status=${st}${agent ? `&agent=${agent}` : ''}`}>{st} {st === 'proposed' ? `(${q.val("SELECT COUNT(*) FROM agent_actions WHERE status='proposed'")})` : ''}</a>)}
    </div>
    {rows.length === 0 ? <Box><p className="muted">Nothing here.</p></Box> : rows.map((a) => (
      <section key={a.id} className={`card admin-box agent-card risk-${a.risk}`}>
        <div className="box-head"><h2>{a.title}</h2><span className="btn-row"><S s={a.status} /><span className="tag tag-grey">{AGENTS[a.agent as AgentName]?.name || a.agent}</span><span className="tag tag-grey">risk: {a.risk}</span></span></div>
        <p className="muted small"><D v={a.created_at} time />{a.first_name && <> · <a href={`/admin/champions/${a.target_user_id}`}>{a.first_name} {a.last_name}</a></>}{a.summary && a.kind !== 'admin_alert' && <> · {a.summary.slice(0, 300)}</>}</p>
        {payloadView(a)}
        {a.result && <p className="small">Result: {a.result}</p>}
        {a.status === 'proposed' && a.kind !== 'social_posts' && (
          <form method="post" action={`/admin/agents/${a.id}/approve`} className="form-grid"><Csrf />
            {EDITABLE[a.kind] && <F label="Edit before approving (optional)" name="edit" type="textarea" rows={4} value={JSON.parse(a.payload)[EDITABLE[a.kind]]} />}
            <div className="form-actions btn-row"><button className="btn btn-green btn-sm" type="submit">Approve & run</button></div>
          </form>)}
        {a.status === 'proposed' && <div className="btn-row"><Act action={`/admin/agents/${a.id}/reject`} label={a.kind === 'social_posts' ? 'Done' : 'Reject'} tone={a.kind === 'social_posts' ? 'ghost' : 'danger'} /></div>}
      </section>
    ))}
    <div className="grid-2 top">
      <Box title="Agents" id="run">
        <Table rows={Object.entries(AGENTS)} cols={[['Agent', ([k, v]) => <><b>{v.name}</b> {agentOn(k as AgentName) ? '' : <span className="tag tag-grey">off</span>}<br /><span className="muted small">{v.what}</span></>],
          ['Last 30 days', ([k]) => { const r = runs.find((x) => x.agent === k); return r ? <span className="small">{r.n} runs · {(r.tin || 0) + (r.tout || 0)} tokens{r.errs ? ` · ${r.errs} errors` : ''}</span> : <span className="muted small">—</span>; }],
          ['', ([k]) => AGENT_JOBS[k] ? <Act action={`/admin/agents/run/${k}`} label="Run now" /> : null]]} />
      </Box>
      <Box title="Ops copilot">
        <Form action="/admin/agents/ops/trail" multipart submit="Draft Trail update">
          <F label="Lot" name="lot_id" options={lots.map((l) => [String(l.id), `${l.code} · ${l.title}`])} />
          <F label="Field notes (rough is fine)" name="notes" type="textarea" rows={4} required hint="e.g. “collected 12t from Ogbomoso cluster today, moisture 11%, trucks to warehouse tomorrow”" />
          <div className="field"><label htmlFor="a-photo">Photo (optional)</label><input id="a-photo" type="file" name="photo" accept="image/*" /></div>
        </Form>
        <hr />
        <Form action="/admin/agents/ops/lot" submit="Draft lot from contract">
          <F label="Paste the buyer contract or LPO summary" name="text" type="textarea" rows={5} required />
        </Form>
      </Box>
    </div>
  </>);
});
post('/admin/agents/:id/approve', 'admin:any', (c) => {
  const a = q.get<any>('SELECT * FROM agent_actions WHERE id=?', Number(c.params.id));
  if (!a) throw new HttpError(404, 'Not found');
  const need: Record<string, string> = { reply_ticket: 'support', send_message: 'support', trail_update: 'operations', draft_lot: 'operations', draft_newsletter: 'content', flag_account: 'support', admin_alert: 'finance' };
  if (need[a.kind] && !c.can(need[a.kind])) throw new HttpError(403, `Needs the ${need[a.kind]} role`);
  const field = EDITABLE[a.kind];
  const edited = field && c.str('edit', 20000) ? { [field]: c.str('edit', 20000) } : undefined;
  try { const r = executeAction(a.id, c.user!.id, edited); c.redirect('/admin/agents', ['ok', `Done: ${r}`]); }
  catch (e: any) { c.redirect('/admin/agents', ['error', e.message]); }
});
post('/admin/agents/:id/reject', 'admin:any', (c) => { rejectAction(Number(c.params.id), c.user!.id, c.str('reason', 300)); c.redirect('/admin/agents', ['ok', 'Closed.']); });
post('/admin/agents/run/:name', 'admin:any', async (c) => {
  const fn = AGENT_JOBS[c.params.name];
  if (!fn) throw new HttpError(404, 'Unknown agent');
  if (c.params.name === 'treasury' && !c.can('finance')) throw new HttpError(403, 'Forbidden');
  let r: string;
  try { r = await fn(); } catch (e: any) { r = `error: ${e.message}`; }
  audit(c.user!.id, 'agent.run', c.params.name, r, c.ip);
  c.back('/admin/agents', ['ok', `${c.params.name}: ${r}`]);
});
post('/admin/agents/ops/trail', 'admin:operations', async (c) => {
  try {
    const photo = c.files.photo ? await savePublicImage(c.files.photo) : null;
    await opsTrailDraft(c.int('lot_id'), c.str('notes', 2000), photo, c.user!.id);
    c.redirect('/admin/agents', ['ok', 'Trail update drafted below. Review and approve it to notify Champions.']);
  } catch (e: any) { c.redirect('/admin/agents', ['error', e.message]); }
});
post('/admin/agents/ops/lot', 'admin:operations', async (c) => {
  try { await opsLotDraft(c.str('text', 8000), c.user!.id); c.redirect('/admin/agents', ['ok', 'Lot drafted below. Approve to create it as a draft.']); }
  catch (e: any) { c.redirect('/admin/agents', ['error', e.message]); }
});

// ============ WhatsApp ============
get('/admin/whatsapp', 'admin:support', (c) => {
  const phone = String(c.query.phone || '').replace(/\D/g, '');
  const convs = q.all<any>(`SELECT x.*, u.first_name, u.last_name FROM (SELECT phone, MAX(created_at) last, COUNT(*) n, MAX(user_id) uid FROM wa_messages GROUP BY phone) x LEFT JOIN users u ON u.id=x.uid ORDER BY x.last DESC LIMIT 40`);
  const msgs = phone ? q.all<any>('SELECT * FROM wa_messages WHERE phone=? ORDER BY id DESC LIMIT 80', phone).reverse() : [];
  page(c, 'WhatsApp', <>
    <p className="muted">{waLive() ? <>Live on the WhatsApp Cloud API{config.waNumber && <> · number <b>+{config.waNumber}</b></>}. Webhook: <code>{config.baseUrl}/webhooks/whatsapp</code></> : <b>Not connected: set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID. You can still test replies with the simulator.</b>} Champions are recognised by their verified phone number. Nothing on WhatsApp can move money.</p>
    <div className="grid-2 top">
      <Box title="Conversations"><Table rows={convs} cols={[['Phone', (r) => <a href={`/admin/whatsapp?phone=${r.phone}`}>+{r.phone}</a>], ['Champion', (r) => r.uid ? <a href={`/admin/champions/${r.uid}`}>{r.first_name} {r.last_name}</a> : <span className="muted">unknown</span>], ['Messages', (r) => r.n], ['Last', (r) => <D v={r.last} time />]]} /></Box>
      <Box title={phone ? `+${phone}` : 'Simulator'}>
        {phone && <div className="chat">{msgs.map((m) => <div key={m.id} className={`msg ${m.direction}`}>{m.body}<br /><span className="muted small">{m.created_at.slice(11, 16)}</span></div>)}</div>}
        <Form action="/admin/whatsapp/simulate" submit="Send as this phone">
          <F label="Phone (digits, e.g. 2348012345678)" name="phone" value={phone} required />
          <F label="Message" name="text" value="MENU" required hint="Try MENU, 1 (balance), 2 (trades), 3 (payout), 4 (trail), 5 (lots), 6 (plan), 7 (person), or a question." />
        </Form>
      </Box>
    </div>
  </>);
});
post('/admin/whatsapp/simulate', 'admin:support', async (c) => {
  const phone = c.str('phone', 20).replace(/\D/g, '');
  const reply = await handleInbound(phone, c.str('text', 1000), null);
  q.insert('wa_messages', { phone, user_id: null, direction: 'out', body: `[simulator] ${reply}`, created_at: now() });
  c.redirect(`/admin/whatsapp?phone=${phone}`);
});

// ============ Plans & gifts ============
get('/admin/plans', 'admin:finance', (c) => {
  const plans = q.all<any>("SELECT p.*, u.first_name, u.last_name FROM plans p JOIN users u ON u.id=p.user_id WHERE p.status!='setup' ORDER BY p.id DESC LIMIT 200");
  const gifts = q.all<any>('SELECT g.*, u.first_name, u.last_name, t.amount, t.certificate_no FROM gifts g JOIN users u ON u.id=g.giver_id JOIN trades t ON t.id=g.trade_id ORDER BY g.id DESC LIMIT 100');
  const rolls = q.all<any>('SELECT r.*, u.first_name, u.last_name FROM rollovers r JOIN users u ON u.id=r.user_id ORDER BY r.id DESC LIMIT 50');
  const totalSaved = plans.reduce((s, p) => s + planSaved(p), 0);
  page(c, 'Plans & gifts', <>
    <Kpis items={[['Harvest Plans running', plans.filter((p) => ['active', 'paused', 'ready'].includes(p.status)).length], ['Saved in plans', <N k={totalSaved} />, 'Champions’ money, not yet in a trade'], ['Gifts waiting to be claimed', gifts.filter((g) => g.status === 'sent').length], ['Keep Growing pending', rolls.filter((r) => r.status === 'pending').length]]} />
    <Box title="Harvest Plans"><Table rows={plans} cols={[['Champion', (p) => <a href={`/admin/champions/${p.user_id}`}>{p.first_name} {p.last_name}</a>], ['Plan', (p) => p.name], ['Saved', (p) => <><N k={planSaved(p)} /> <span className="muted small">of {fmtNGN(p.target_amount)}</span></>], ['Monthly', (p) => <N k={p.monthly_amount} />], ['Card', (p) => p.card_label || 'manual'], ['Next', (p) => <D v={p.next_charge_at} />], ['Status', (p) => <S s={p.status} />]]} /></Box>
    <Box title="Gifts"><Table rows={gifts} cols={[['From', (g) => `${g.first_name} ${g.last_name}`], ['To', (g) => `${g.recipient_name} ${g.recipient_email || g.recipient_phone || ''}`], ['Trade', (g) => <>{g.certificate_no} · <N k={g.amount} /></>], ['Sent', (g) => <D v={g.created_at} />], ['Status', (g) => <S s={g.status} />]]} /></Box>
    <Box title="Keep Growing (rollovers)"><Table rows={rolls} cols={[['Champion', (r) => `${r.first_name} ${r.last_name}`], ['Amount', (r) => <N k={r.amount} />], ['Commodity', (r) => r.commodity], ['Status', (r) => <S s={r.status} />], ['Expires', (r) => <D v={r.expires_at} />]]} /></Box>
  </>);
});

// ============ Import existing users ============
get('/admin/champions/import', 'admin:super', (c) => page(c, 'Import existing users', <Box>
  <p>Upload a CSV with a header row. Columns: <code>first_name, last_name, email, phone, country, city, opening_balance</code>. Only the first three are required.</p>
  <ul className="small"><li>Each person gets an account and (if ticked) an email to set their password. The link proves their email address.</li><li>Opening balances become <b>pending adjustments</b> that a second admin approves in Wallets & ledger, so every naira has a record.</li><li>Existing emails are skipped.</li></ul>
  <Form action="/admin/champions/import" multipart submit="Import">
    <div className="field"><label htmlFor="a-csv">CSV file</label><input id="a-csv" type="file" name="csv" accept=".csv,text/csv" required /></div>
    <F label="Email each person a link to set their password" name="invite" type="checkbox" value={1} />
  </Form>
</Box>));
post('/admin/champions/import', 'admin:super', (c) => {
  const f = c.files.csv;
  if (!f) return c.redirect('/admin/champions/import', ['error', 'Choose a CSV file.']);
  const rows = parseCsv(f.data.toString('utf8').replace(/^﻿/, ''));
  if (!rows.length) return c.redirect('/admin/champions/import', ['error', 'The file has no rows.']);
  if (rows.length > 20000) return c.redirect('/admin/champions/import', ['error', 'Split files larger than 20,000 rows.']);
  const r = importUsers(rows, c.user!.id, { sendInvites: c.bool('invite') });
  c.redirect('/admin/champions', ['ok', `Imported ${r.created} accounts; ${r.balances} opening balances await a second approval in Wallets & ledger.${r.skipped.length ? ` Skipped ${r.skipped.length}: ${r.skipped.slice(0, 5).join('; ')}${r.skipped.length > 5 ? '…' : ''}` : ''}`.slice(0, 900)]);
});

export const _ = { setSetting, ACTION_KINDS };
