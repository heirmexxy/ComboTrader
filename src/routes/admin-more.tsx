// Admin: Treasury (coverage of Champion payouts), AI agents inbox, WhatsApp, Plans & gifts, user import.
import { get, post } from '../lib/router';
import { translate } from '../lib/i18n';
import { render } from '../views/render';
import { AdminLayout } from '../views/layout';
import { Box, Kpis, Table, Act, F, Form, N, D, S, naira } from '../views/admin/ui';
import { Csrf } from '../views/components';
import { q, now } from '../lib/db';
import { coverage, receivables, latestCash, treasurySnapshot } from '../lib/treasury';
import { AGENTS, ACTION_KINDS, AGENT_JOBS, agentOn, executeAction, rejectAction, opsTrailDraft, opsLotDraft, researchProspects, syncLeads, type AgentName } from '../lib/agents';
import { aiLive, callsToday, agentMode } from '../lib/ai';
import { lessonScore, scoreOutcomes, type Lesson } from '../lib/learning';
import { CHANNELS, CHANNEL_NAMES, CHANNEL_SETUP, channelReady, wantedChannels, runSocial, runEmail, CAMPAIGN_KEYS, publishDueSocial, type Channel } from '../lib/marketing';
import { savePublicImage as saveImg } from '../lib/uploads';
import { marketOn, openListings, quote, buyUnits, houseUser } from '../lib/market';
import { userById as uById } from '../lib/auth';
import { testModeAvailable, simulatedPayments, addSampleLots, clearTestData, testTables } from '../lib/testmode';
import { randomToken, isEmail } from '../lib/util';
import { handleInbound, waLive } from '../lib/whatsapp';
import { planSaved } from '../lib/plans';
import { importUsers, parseCsv } from '../lib/account';
import { getLot, allLots, siteStats } from '../lib/trading';
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
  if (a.kind === 'publish_social') { const post = q.get<any>('SELECT image_path, channels FROM social_posts WHERE id=?', p.post_id); return <div className="post-preview">{post?.image_path && <img src={`/uploads/${post.image_path}`} alt="" width={180} height={180} />}<div><pre className="pre">{p.text}</pre><p className="muted small">Goes to: {String(post?.channels || '').split(',').filter(Boolean).map((ch) => `${CHANNEL_NAMES[ch as Channel]}${channelReady(ch) ? '' : ' (copy & post)'}`).join(', ') || 'no channels selected'} · {'{link}'} becomes a tracked link per channel</p></div></div>; }
  if (a.kind === 'send_campaign') return <><b>{p.title}</b><pre className="pre">{p.body}</pre><p className="muted small">{(p.recipients || []).length} recipients · placeholders like {'{name}'} are filled per person · tracked button + unsubscribe link added</p></>;
  if (a.kind === 'send_invite' || a.kind === 'send_outreach') return <><b>{p.title}</b><pre className="pre">{p.body}</pre>{p.lesson_id && <p className="muted small">From learned template #{p.lesson_id}</p>}</>;
  if (a.kind === 'save_prospects') return <Table rows={p.organisations || []} cols={[['Organisation', (o: any) => <><b>{o.name}</b><br /><span className="muted small">{o.location}</span></>], ['Contact', (o: any) => <span className="small">{o.email || o.phone || '—'}{o.website && <><br /><a href={o.website} target="_blank" rel="noopener">{o.website}</a></>}</span>], ['Why', (o: any) => <span className="small">{o.why}</span>]]} />;
  return <pre className="pre">{JSON.stringify(p, null, 2)}</pre>;
}
/** Which payload field an admin may edit before approving. */
const EDITABLE: Record<string, string> = { send_message: 'body', reply_ticket: 'reply', trail_update: 'note', draft_newsletter: 'body', send_invite: 'body', send_outreach: 'body', publish_social: 'text', send_campaign: 'body' };

get('/admin/agents', 'admin:any', (c) => {
  const status = String(c.query.status || 'proposed');
  const agent = String(c.query.agent || '');
  const rows = q.all<any>(`SELECT a.*, u.first_name, u.last_name FROM agent_actions a LEFT JOIN users u ON u.id=a.target_user_id WHERE (?='all' OR a.status=?) AND (?='' OR a.agent=?) ORDER BY CASE a.risk WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, a.id DESC LIMIT 60`, status, status, agent, agent);
  const runs = q.all<any>('SELECT agent, COUNT(*) n, SUM(tokens_in) tin, SUM(tokens_out) tout, SUM(CASE WHEN status!=\'ok\' THEN 1 ELSE 0 END) errs FROM agent_runs WHERE created_at>=? GROUP BY agent', new Date(Date.now() - 30 * 864e5).toISOString());
  const s = settings();
  const lots = allLots().filter((l) => ['open', 'filled', 'active'].includes(l.status));
  page(c, 'AI agents', <>
    <p className="muted">Agents propose; people decide. Agents cannot move money, approve withdrawals or change balances. Autonomy: <b>{s.agent_autonomy === 'auto_low' ? 'low-risk messages send automatically' : 'everything waits for review'}</b>{c.can('super') && <> (<a href="/admin/settings#agents">change</a>)</>}.</p>
    <section className="card admin-box mode-switch">
      <div className="box-head"><h2>How the agents think</h2>
        <span className="btn-row">{c.can('super') ? (['rules', 'ai'] as const).map((m) => <Act key={m} action="/admin/agents/mode" fields={{ mode: m }} label={m === 'ai' ? 'AI (Claude)' : 'Rules'} tone={s.agent_mode === m ? 'primary' : 'ghost'} />) : <b>{s.agent_mode === 'ai' ? 'AI' : 'Rules'}</b>}</span></div>
      <p className="small">{s.agent_mode === 'ai'
        ? aiLive() ? <>AI is on: agents use <b>{config.aiModel}</b> / <b>{config.aiModelFast}</b> ({callsToday()} of {s.agent_daily_limit} calls in the last 24 hours) and every approved result teaches the rules.</> : <><b>AI is selected but there is no ANTHROPIC_API_KEY on the server</b>, so agents are using rules until the key is added.</>
        : <>Rules are on: agents use the FAQs, built-in templates and <a href="/admin/agents/learning">what they have learned</a> from AI and from your approvals. No model calls, no cost. Web research for new organisations pauses.</>}</p>
    </section>
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
        <Table rows={Object.entries(AGENTS)} cols={[['Agent', ([k, v]) => <><b>{v.name}</b> {agentOn(k as AgentName) ? '' : <span className="tag tag-grey">off</span>} <span className={`tag ${agentMode(k) === 'ai' && aiLive() ? 'tag-green' : 'tag-grey'}`}>{agentMode(k) === 'ai' && aiLive() ? 'AI' : 'Rules'}</span><br /><span className="muted small">{v.what}</span>
          {c.can('super') && <form method="post" action={`/admin/agents/mode/${k}`} className="agent-mode"><Csrf />
            <select name="mode" defaultValue={(() => { try { return JSON.parse(String(s.agent_modes || '{}'))[k] || ''; } catch { return ''; } })()} aria-label={`Mode for ${v.name}`} data-autosubmit>
              <option value="">Follow the switch</option><option value="ai">Always AI</option><option value="rules">Always rules</option></select>
            <noscript><button className="btn btn-ghost btn-sm" type="submit">Set</button></noscript></form>}</>],
          ['Last 30 days', ([k]) => { const r = runs.find((x) => x.agent === k); return r ? <span className="small">{r.n} runs · {(r.tin || 0) + (r.tout || 0)} tokens{r.errs ? ` · ${r.errs} errors` : ''}</span> : <span className="muted small">—</span>; }],
          ['', ([k]) => AGENT_JOBS[k] ? <Act action={`/admin/agents/run/${k}`} label="Run now" /> : null]]} />
        <p className="small"><a href="/admin/agents/learning">What the agents have learned →</a> · <a href="/admin/prospects">Prospects →</a></p>
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
  const need: Record<string, string> = { reply_ticket: 'support', send_message: 'support', trail_update: 'operations', draft_lot: 'operations', draft_newsletter: 'content', flag_account: 'support', admin_alert: 'finance', send_invite: 'content', send_outreach: 'content', save_prospects: 'content', publish_social: 'content', send_campaign: 'content' };
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
post('/admin/agents/mode', 'admin:super', (c) => {
  const m = c.str('mode') === 'rules' ? 'rules' : 'ai';
  setSetting('agent_mode', m); audit(c.user!.id, 'agents.mode', m, undefined, c.ip);
  c.back('/admin/agents', ['ok', m === 'ai' ? (aiLive() ? 'Agents now use AI.' : 'AI selected. Add ANTHROPIC_API_KEY on the server to start using it; until then agents use rules.') : 'Agents now use rules and what they have learned.']);
});
post('/admin/agents/mode/:agent', 'admin:super', (c) => {
  if (!(c.params.agent in AGENTS)) throw new HttpError(404, 'Unknown agent');
  let o: Record<string, string> = {}; try { o = JSON.parse(String(settings().agent_modes || '{}')); } catch { o = {}; }
  const m = c.str('mode'); if (m === 'ai' || m === 'rules') o[c.params.agent] = m; else delete o[c.params.agent];
  setSetting('agent_modes', JSON.stringify(o)); audit(c.user!.id, 'agents.mode', c.params.agent, m || 'follow', c.ip);
  c.back('/admin/agents#run', ['ok', `${AGENTS[c.params.agent as AgentName].name}: ${m === 'ai' ? 'always AI' : m === 'rules' ? 'always rules' : 'follows the switch'}.`]);
});
const LESSON_LABEL: Record<string, string> = { answer: 'Answer', template: 'Message template', signal: 'Risk signal', advice: 'Advice', post: 'Post pattern', stage_words: 'Trail stage words' };
function lessonView(l: Lesson) {
  let c: any = {}; try { c = JSON.parse(l.content); } catch {}
  if (l.kind === 'answer') return <><b className="small">Q: {c.q}</b><pre className="pre">{c.a}</pre></>;
  if (l.kind === 'template') return <><b className="small">{c.title}</b><pre className="pre">{c.body}</pre></>;
  if (l.kind === 'signal') return <span className="small">{c.advice || 'No advice yet'} </span>;
  if (l.kind === 'advice' || l.kind === 'post') return <pre className="pre">{c.text}</pre>;
  if (l.kind === 'stage_words') return <span className="small">{Object.entries(c).map(([st, w]: any) => `${st}: ${Object.entries(w).sort((a: any, b: any) => b[1] - a[1]).slice(0, 8).map(([x]) => x).join(', ')}`).join(' · ')}</span>;
  return <pre className="pre">{l.content}</pre>;
}
get('/admin/agents/learning', 'admin:any', (c) => {
  const agent = String(c.query.agent || ''), kind = String(c.query.kind || ''), state = String(c.query.state || '');
  const rows = q.all<Lesson>(`SELECT * FROM agent_lessons WHERE (?='' OR agent=?) AND (?='' OR kind=?) AND (?='' OR (?='off' AND active=0) OR (?='on' AND active=1)) ORDER BY active DESC, (wins+losses) DESC, id DESC LIMIT 200`, agent, agent, kind, kind, state, state, state);
  const stats = q.all<any>('SELECT agent, COUNT(*) n, SUM(active) on_, SUM(wins) w, SUM(losses) l FROM agent_lessons GROUP BY agent');
  const pending = Number(q.val('SELECT COUNT(*) FROM lesson_outcomes WHERE scored_at IS NULL') ?? 0);
  page(c, 'What the agents have learned', <>
    <p className="muted">Lessons come from AI output you approved, your own edits, and results: a week after each message we check whether the person took the step, and the score decides which template the rules use next. Switched-off lessons are never used; answers taken from unreviewed chats start switched off.</p>
    <Kpis items={[...stats.map((x) => [AGENTS[x.agent as AgentName]?.name || x.agent, `${x.on_} in use`, `${x.n} learned · ${x.w || 0} worked / ${x.l || 0} didn't`] as [string, string, string]), ['Waiting to be scored', pending, 'messages sent in the last week']]} />
    <div className="btn-row">
      <a className={`btn btn-sm ${!agent ? 'btn-primary' : 'btn-ghost'}`} href="/admin/agents/learning">All</a>
      {Object.keys(AGENTS).map((k) => <a key={k} className={`btn btn-sm ${agent === k ? 'btn-primary' : 'btn-ghost'}`} href={`/admin/agents/learning?agent=${k}`}>{AGENTS[k as AgentName].name}</a>)}
      <a className={`btn btn-sm ${state === 'off' ? 'btn-primary' : 'btn-ghost'}`} href={`/admin/agents/learning?state=off${agent ? `&agent=${agent}` : ''}`}>Waiting for review</a>
      <Act action="/admin/agents/learning/score" label="Score results now" />
    </div>
    <Box>{rows.length ? <Table rows={rows} cols={[
      ['Lesson', (l) => <><span className="tag tag-grey">{AGENTS[l.agent as AgentName]?.name || l.agent}</span> <span className="tag tag-grey">{LESSON_LABEL[l.kind] || l.kind}</span> <span className="muted small">{l.key.slice(0, 80)} · {l.lang} · from {l.source}</span>{lessonView(l)}</>],
      ['Results', (l) => l.wins + l.losses ? <span className="small">{l.wins} worked / {l.losses} didn't<br />score {(lessonScore(l) * 100).toFixed(0)}%</span> : <span className="muted small">used {l.uses}×</span>],
      ['', (l) => <div className="btn-row"><Act action={`/admin/agents/lessons/${l.id}/toggle`} label={l.active ? 'Switch off' : 'Use it'} tone={l.active ? 'ghost' : 'green'} /><Act action={`/admin/agents/lessons/${l.id}/delete`} label="Delete" tone="danger" confirm="Delete this lesson?" /></div>],
    ]} /> : <p className="muted">Nothing learned yet. Lessons appear as agents run and you approve their drafts.</p>}</Box>
  </>);
});
post('/admin/agents/lessons/:id/toggle', 'admin:any', (c) => { q.run('UPDATE agent_lessons SET active=1-active, updated_at=? WHERE id=?', now(), Number(c.params.id)); audit(c.user!.id, 'lesson.toggle', c.params.id, undefined, c.ip); c.back('/admin/agents/learning', ['ok', 'Updated.']); });
post('/admin/agents/lessons/:id/delete', 'admin:any', (c) => { q.run('DELETE FROM agent_lessons WHERE id=?', Number(c.params.id)); audit(c.user!.id, 'lesson.delete', c.params.id, undefined, c.ip); c.back('/admin/agents/learning', ['ok', 'Deleted.']); });
post('/admin/agents/learning/score', 'admin:any', (c) => c.back('/admin/agents/learning', ['ok', `Scored: ${scoreOutcomes()}`]));

// ============ Marketing (RevOps) ============
get('/admin/marketing', 'admin:content', (c) => {
  const s = settings();
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const clicks = Number(q.val('SELECT COUNT(*) FROM link_clicks WHERE created_at>=?', since) ?? 0);
  const leads = Number(q.val('SELECT COUNT(*) FROM leads WHERE created_at>=?', since) ?? 0);
  const bySource = q.all<any>(`SELECT COALESCE(acq_source,'unknown') src, COUNT(*) n, SUM(CASE WHEN EXISTS (SELECT 1 FROM trades t WHERE t.user_id=u.id) THEN 1 ELSE 0 END) traded FROM users u WHERE role='champion' AND created_at>=? GROUP BY src ORDER BY n DESC`, since);
  const signups = bySource.reduce((a, r) => a + r.n, 0), traded = bySource.reduce((a, r) => a + r.traded, 0);
  const posts = q.all<any>('SELECT * FROM social_posts ORDER BY id DESC LIMIT 15');
  const inbox = q.all<any>('SELECT * FROM social_inbox ORDER BY id DESC LIMIT 20');
  const camps = CAMPAIGN_KEYS.map((k) => ({ k, sent: Number(q.val('SELECT COUNT(*) FROM campaign_sends WHERE campaign=? AND sent_at>=?', k, since) ?? 0), clicks: Number(q.val('SELECT COALESCE(SUM(clicks),0) FROM links WHERE campaign=? AND created_at>=?', `email-${k}`, since) ?? 0),
    worked: Number(q.val("SELECT COUNT(*) FROM lesson_outcomes WHERE situation=? AND won=1 AND sent_at>=?", `email:${k}`, since) ?? 0), variants: Number(q.val("SELECT COUNT(*) FROM agent_lessons WHERE agent='email' AND key=? AND active=1", `email:${k}`) ?? 0) }));
  const on = String(s.email_campaigns).split(',');
  const meta = `${config.baseUrl}/webhooks/meta`;
  page(c, 'Marketing', <>
    <p className="muted">The Social and Email agents work with or without AI. Without AI they use templates and the versions that have worked best; with AI, Claude writes new versions and the winners become templates. Every post and email uses tracked links, so you can see what brings clicks and sign-ups.</p>
    <Kpis items={[['Tracked clicks', clicks, 'last 30 days'], ['New leads', leads, 'last 30 days'], ['New Champions', signups, `${traded} have traded`], ['Social agent', agentMode('social') === 'ai' && aiLive() ? 'AI' : 'Rules', `${s.social_posts_per_week} posts a week`], ['Email agent', agentMode('email') === 'ai' && aiLive() ? 'AI' : 'Rules', `${on.length} campaigns on`]]} />
    <div className="btn-row">
      <Act action="/admin/marketing/post-now" label="Write a post now" tone="green" />
      <Act action="/admin/agents/run/email" label="Prepare due emails now" />
      <a className="btn btn-ghost btn-sm" href="/admin/agents?agent=social">Posts waiting for approval</a>
      <a className="btn btn-ghost btn-sm" href="/admin/agents?agent=email">Emails waiting for approval</a>
    </div>
    <div className="grid-2 top">
      <Box title="Where new Champions came from (30 days)">{bySource.length ? <Table rows={bySource} cols={[['Source', (r) => r.src], ['Sign-ups', (r) => r.n], ['Traded', (r) => r.traded]]} /> : <p className="muted">No sign-ups yet in this period.</p>}</Box>
      <Box title="Channels">
        <Table rows={[...CHANNELS]} cols={[['Channel', (ch) => <><b>{CHANNEL_NAMES[ch]}</b>{!wantedChannels().includes(ch) && <span className="tag tag-grey">not used</span>}</>],
          ['Status', (ch) => channelReady(ch) ? <span className="tag tag-green">connected: posts publish automatically</span> : <span className="small">Copy &amp; post: ready-made text and image below. To connect, add {CHANNEL_SETUP[ch]} to the server settings file.</span>]]} />
        <p className="small">Comments, DMs and lead forms: in your Meta app, subscribe the Page (fields <code>feed</code>, <code>messages</code>, <code>leadgen</code>) and Instagram (<code>comments</code>, <code>messages</code>) to <code>{meta}</code> with the verify token in META_VERIFY_TOKEN. Your ads and posts can also point to <a href="/join" target="_blank">{config.baseUrl}/join</a>, which captures leads with consent.</p>
      </Box>
    </div>
    <Box title="Social posts">{posts.length ? posts.map((p) => {
      const res: Record<string, any> = JSON.parse(p.results || '{}');
      const links = q.all<any>('SELECT channel, clicks, id FROM links WHERE campaign=?', `post-${p.id}`);
      return <div key={p.id} className="post-row">
        {p.image_path ? <img src={`/uploads/${p.image_path}`} alt="" width={120} height={120} loading="lazy" /> : <div className="post-noimg" />}
        <div className="post-body">
          <p className="small"><S s={p.status} /> <span className="tag tag-grey">{p.kind}</span> {p.scheduled_at && <>for <D v={p.scheduled_at} time /></>} {links.length > 0 && <> · {links.reduce((a, l) => a + l.clicks, 0)} clicks</>}</p>
          <pre className="pre">{String(p.text).replace('{link}', '🔗')}</pre>
          {Object.entries(res).filter(([k]) => !k.startsWith('_')).map(([ch, r]: any) => <div key={ch} className="small post-channel"><b>{CHANNEL_NAMES[ch as Channel] || ch}:</b>{' '}
            {r.id ? <>published ✓</> : r.manual ? (r.done ? <>posted by hand ✓</> : <><button type="button" className="btn btn-ghost btn-sm" data-copy={r.text}>Copy text</button> {p.image_path && <a className="btn btn-ghost btn-sm" href={`/uploads/${p.image_path}`} download>Download image</a>} <Act action={`/admin/marketing/posts/${p.id}/done`} fields={{ channel: ch }} label="Mark as posted" /></>) : r.error ? <span className="error">failed: {r.error}</span> : null}
            {' '}<span className="muted">{links.find((l) => l.channel === ch)?.clicks ?? 0} clicks</span></div>)}
        </div></div>;
    }) : <p className="muted">No posts yet. Click “Write a post now”, or wait for the next posting day.</p>}</Box>
    <div className="grid-2 top">
      <Box title="Write a post yourself"><Form action="/admin/marketing/posts" multipart submit="Schedule post">
        <F label="Text" name="text" type="textarea" rows={4} required hint="Put {link} where the tracked link should go (added at the end if you leave it out)." />
        <div className="field"><label htmlFor="a-image">Image (needed for Instagram)</label><input id="a-image" type="file" name="image" accept="image/*" /></div>
        <F label="Link goes to" name="url" value="/join" hint="e.g. /join, /lots/SB-2611, /how-it-works" />
        <F label="Publish at (Lagos time, empty = now)" name="when" type="datetime-local" />
      </Form></Box>
      <Box title="Comments, DMs and lead forms">{inbox.length ? <Table rows={inbox} cols={[['', (m) => <><span className="tag tag-grey">{m.channel} · {m.kind}</span> <span className="muted small"><D v={m.created_at} time /></span><br /><span className="small">{m.author && <b>{m.author}: </b>}{String(m.text || '').slice(0, 200)}</span>{m.reply && <p className="small muted">↳ {m.reply.slice(0, 200)}</p>}</>]]} /> : <p className="muted">Nothing yet. Once the Meta webhook is connected, comments asking how to join get a reply with the /join link, DMs get an answer, and lead-form sign-ups become leads.</p>}</Box>
    </div>
    <Box title="Email campaigns (to Champions)">
      <Table rows={camps} cols={[['Campaign', (r) => <><b>{r.k.replace('_', ' ')}</b><br /><span className="muted small">{CAMPAIGN_DESC[r.k]}</span></>], ['Sent (30 days)', (r) => r.sent], ['Clicks', (r) => r.clicks], ['Worked', (r) => r.sent ? `${r.worked}` : '—'], ['Versions being tested', (r) => r.variants]]} />
      <p className="muted small">“Worked” means the person clicked or made a trade within a week. With two or more versions, each is tried about 15 times, then the best one is used. Champions can unsubscribe from these emails; messages about their own trades still arrive.</p>
    </Box>
    <Box title="Settings" id="settings"><Form action="/admin/marketing/settings" submit="Save">
      <F label="Social posts per week" name="social_posts_per_week" type="number" value={s.social_posts_per_week} hint="New Trade Lots are always posted the day they open." />
      <F label="Posting hour (Lagos time, 0–23)" name="social_post_hour" type="number" value={s.social_post_hour} />
      <fieldset className="field"><legend>Post to</legend>{CHANNELS.map((ch) => <label key={ch} className="check"><input type="checkbox" name="social_channels[]" value={ch} defaultChecked={wantedChannels().includes(ch)} /> <span>{CHANNEL_NAMES[ch]}</span></label>)}</fieldset>
      <F label="Answer comments and DMs that ask how to join" name="social_auto_reply" type="checkbox" value={s.social_auto_reply} />
      <F label="A post “worked” at this many clicks in a week" name="social_click_goal" type="number" value={s.social_click_goal} />
      <fieldset className="field"><legend>Email campaigns on</legend>{['welcome', 'maturity', 'paid_out', 'winback', 'new_lot', 'market'].map((k) => <label key={k} className="check"><input type="checkbox" name="email_campaigns[]" value={k} defaultChecked={on.includes(k)} /> <span>{k.replace('_', ' ')}</span></label>)}</fieldset>
      <F label="Test two subject lines on every newsletter" name="newsletter_ab" type="checkbox" value={s.newsletter_ab} />
    </Form></Box>
  </>);
});
const CAMPAIGN_DESC: Record<string, string> = {
  welcome_1: 'Day 1 after sign-up: how a Trade Lot works', welcome_2: 'Day 4: choose your period, rates', welcome_3: 'Day 8: Harvest Circles, Plans, referrals',
  maturity: '7–10 days before a payout: choose Keep Growing or wallet', paid_out: 'A few days after a payout, if the money is still idle', winback: 'No trade for 60+ days (once a quarter)', new_lot: 'When a lot opens: Champions who have funded before', market: 'Trades for sale on the marketplace: Champions with enough idle wallet money (every two weeks at most)',
};
post('/admin/marketing/post-now', 'admin:content', async (c) => {
  let r: string; try { r = await runSocial(true); } catch (e: any) { r = `error: ${e.message}`; }
  audit(c.user!.id, 'social.post_now', undefined, r, c.ip);
  c.redirect('/admin/agents?agent=social', ['ok', `Social: ${r}. Approve it below to publish.`]);
});
post('/admin/marketing/posts', 'admin:content', async (c) => {
  let text = c.str('text', 3000); if (!text) return c.back('/admin/marketing', ['error', 'Write the post text.']);
  if (!text.includes('{link}')) text += ' {link}';
  const image = c.files.image ? await saveImg(c.files.image, 1080) : null;
  const w = c.str('when', 20);
  const when = w ? new Date(`${w}:00+01:00`).toISOString() : now();
  const id = q.insert('social_posts', { kind: 'custom', ref: `custom:${Date.now()}`, text, text_short: text.length > 250 ? `${text.replace('{link}', '').slice(0, 220).replace(/\s+\S*$/, '')}… {link}` : text, image_path: image, channels: wantedChannels().join(','), status: 'scheduled', scheduled_at: when, created_at: now(),
    results: JSON.stringify({ _url: c.str('url', 200) || '/join' }) }).id;
  audit(c.user!.id, 'social.custom_post', `post:${id}`, undefined, c.ip);
  if (when <= now()) await publishDueSocial();
  c.redirect('/admin/marketing', ['ok', when <= now() ? 'Post published (copy-and-post channels are ready below).' : 'Post scheduled.']);
});
post('/admin/marketing/posts/:id/done', 'admin:content', (c) => {
  const p = q.get<any>('SELECT * FROM social_posts WHERE id=?', Number(c.params.id)); if (!p) throw new HttpError(404, 'Not found');
  const res = JSON.parse(p.results || '{}'); const ch = c.str('channel', 20);
  if (res[ch]) res[ch].done = now();
  q.run('UPDATE social_posts SET results=? WHERE id=?', JSON.stringify(res), p.id);
  c.back('/admin/marketing', ['ok', 'Marked as posted.']);
});
post('/admin/marketing/settings', 'admin:content', (c) => {
  const list = (k: string, allowed: readonly string[]) => (Array.isArray(c.body[k]) ? c.body[k] : [c.body[k]]).filter((x: unknown) => typeof x === 'string' && allowed.includes(x)).join(',');
  setSetting('social_posts_per_week', Math.min(14, Math.max(0, c.int('social_posts_per_week'))));
  setSetting('social_post_hour', Math.min(23, Math.max(0, c.int('social_post_hour'))));
  setSetting('social_channels', list('social_channels', CHANNELS));
  setSetting('social_auto_reply', c.bool('social_auto_reply'));
  setSetting('social_click_goal', Math.max(1, c.int('social_click_goal') || 10));
  setSetting('email_campaigns', list('email_campaigns', ['welcome', 'maturity', 'paid_out', 'winback', 'new_lot', 'market']));
  setSetting('newsletter_ab', c.bool('newsletter_ab'));
  audit(c.user!.id, 'marketing.settings', undefined, undefined, c.ip);
  c.back('/admin/marketing', ['ok', 'Saved.']);
});

// ============ Marketplace ============
get('/admin/marketplace', 'admin:operations', (c) => {
  const s = settings();
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const listings = openListings().map((l) => ({ ...l, q1: quote(l, l, 1), seller: uById(l.seller_id) }));
  const sales = q.all<any>(`SELECT s.*, l.title AS lot_title, su.first_name AS sf, su.last_name AS sl, bu.first_name AS bf, bu.last_name AS bl, bu.role AS brole FROM trade_sales s JOIN trades t ON t.id=s.new_trade_id JOIN lots l ON l.id=t.lot_id
    JOIN users su ON su.id=s.seller_id JOIN users bu ON bu.id=s.buyer_id ORDER BY s.id DESC LIMIT 30`);
  const sold30 = q.get<any>('SELECT COUNT(*) n, COALESCE(SUM(price),0) v, COALESCE(SUM(fee),0) f FROM trade_sales WHERE created_at>=?', since);
  const house = q.get<any>("SELECT COUNT(*) n, COALESCE(SUM(t.amount),0) p FROM trades t JOIN users u ON u.id=t.user_id WHERE u.role='house' AND t.status IN ('active','matured')");
  const spent = -Number(q.val("SELECT COALESCE(SUM(e.amount),0) FROM entries e JOIN ledger_accounts a ON a.id=e.account_id WHERE a.code='kitovu:market_purchases'") ?? 0);
  page(c, 'Marketplace', <>
    <p className="muted">Champions sell trades (whole, or in units of at least {fmtNGN(s.market_unit)}) to other Champions before the payout date, at the value to date less any discount (up to {s.market_max_discount_pct}%). The seller pays a {Number(s.market_fee_bps) / 100}% fee. Kitovu still pays whoever holds the trade on the payout date, so coverage does not change. Kitovu can buy like any other buyer, with no commitment to do so.</p>
    <Kpis items={[['Status', marketOn() ? (s.marketplace_mode === 'on' ? 'Live' : 'On (test mode)') : 'Off'], ['For sale now', listings.length, fmtNGN(listings.reduce((a, l) => a + l.unit_amount * l.units_left, 0)) + ' principal'],
      ['Sold (30 days)', sold30.n, `${fmtNGN(sold30.v)} · fees ${fmtNGN(sold30.f)}`], ['Held by Kitovu', house.n, `${fmtNGN(house.p)} principal · ${fmtNGN(spent)} spent buying`]]} />
    {c.can('super') && <Box title="Switch" actions={<div className="btn-row">{(['off', 'on'] as const).map((m) => <Act key={m} action="/admin/marketplace/mode" fields={{ mode: m }} label={m === 'on' ? 'Live' : 'Off'} tone={s.marketplace_mode === m ? 'primary' : 'ghost'} />)}</div>}>
      <p className="small">Off: hidden from Champions (existing listings stay paused). Live: Champions see “Buy from Champions” and can sell eligible trades. While test mode is on (Admin → Testing), the marketplace is on for testing whatever this switch says.</p>
      <Form action="/admin/marketplace/settings" submit="Save rules">
        <F label="Unit size (₦)" name="market_unit" value={naira(s.market_unit)} hint="Smallest piece of a trade a buyer can take. A ₦2,500,000 trade is 10 units at ₦250,000." />
        <F label="Fee (% of sale price, paid by the seller)" name="market_fee_pct" type="number" step="0.1" value={Number(s.market_fee_bps) / 100} />
        <F label="Largest discount a seller may offer (%)" name="market_max_discount_pct" type="number" step="0.5" value={s.market_max_discount_pct} />
        <F label="Days a trade must be held before selling" name="market_min_hold_days" type="number" value={s.market_min_hold_days} />
        <F label="No selling in the last … days before payout" name="market_cutoff_days" type="number" value={s.market_cutoff_days} />
      </Form>
    </Box>}
    <Box title="For sale now">{listings.length ? <Table rows={listings} cols={[
      ['Trade', (l) => <><b>{l.lot_title}</b><br /><span className="muted small">{l.seller ? `${l.seller.first_name} ${l.seller.last_name}` : ''} · pays <D v={l.matures_at} /></span></>],
      ['Units', (l) => `${l.units_left} of ${l.units_total} × ${fmtNGN(l.unit_amount)}`],
      ['Price per unit now', (l) => <>{fmtNGN(l.q1.price)}{l.discount_bps ? <span className="muted small"> (−{l.discount_bps / 100}%)</span> : null}<br /><span className="muted small">buyer return {l.q1.annualPct}% a year</span></>],
      ['', (l) => c.can('finance') ? <form method="post" action={`/admin/marketplace/${l.id}/buy`} className="inline" data-confirm="Buy these units with Kitovu's money? Kitovu will hold the trade and be paid on the payout date."><Csrf />
        <input name="units" type="number" min={1} max={l.units_left} defaultValue={l.units_left} aria-label="Units" style={{ width: 70 }} /> <button className="btn btn-ghost btn-sm" type="submit">Buy as Kitovu</button></form> : null],
    ]} /> : <p className="muted">Nothing for sale.</p>}</Box>
    <Box title="Recent sales">{sales.length ? <Table rows={sales} cols={[['When', (x) => <D v={x.created_at} time />], ['Trade', (x) => x.lot_title], ['Seller → buyer', (x) => `${x.sf} ${x.sl} → ${x.brole === 'house' ? 'Kitovu' : `${x.bf} ${x.bl}`}`],
      ['Units', (x) => x.units], ['Principal', (x) => <N k={x.principal} />], ['Price', (x) => <N k={x.price} />], ['Fee', (x) => <N k={x.fee} />]]} /> : <p className="muted">No sales yet.</p>}</Box>
  </>);
});
post('/admin/marketplace/mode', 'admin:super', (c) => {
  const m = c.str('mode') === 'on' ? 'on' : 'off';
  setSetting('marketplace_mode', m); audit(c.user!.id, 'market.mode', m, undefined, c.ip);
  c.back('/admin/marketplace', ['ok', m === 'on' ? 'The marketplace is live.' : 'The marketplace is off.']);
});
post('/admin/marketplace/settings', 'admin:super', (c) => {
  const unit = parseNaira(c.body.market_unit);
  if (unit < 1000000) return c.back('/admin/marketplace', ['error', 'The unit size must be at least ₦10,000.']);
  setSetting('market_unit', unit);
  setSetting('market_fee_bps', Math.round(Math.min(10, Math.max(0, Number(c.body.market_fee_pct) || 0)) * 100));
  setSetting('market_max_discount_pct', Math.min(20, Math.max(0, Number(c.body.market_max_discount_pct) || 0)));
  setSetting('market_min_hold_days', Math.min(365, Math.max(0, c.int('market_min_hold_days'))));
  setSetting('market_cutoff_days', Math.min(90, Math.max(0, c.int('market_cutoff_days'))));
  audit(c.user!.id, 'market.settings', undefined, undefined, c.ip);
  c.back('/admin/marketplace', ['ok', 'Saved.']);
});
post('/admin/marketplace/:id/buy', 'admin:finance', (c) => {
  try { const r = buyUnits(c.user!, Number(c.params.id), c.int('units'), { asKitovu: true, by: c.user!.id }); c.back('/admin/marketplace', ['ok', `Kitovu bought ${fmtNGN(r.principal)} of principal for ${fmtNGN(r.price)}. It is paid on the payout date like any trade.`]); }
  catch (e: any) { c.back('/admin/marketplace', ['error', e.key ? translate('en', e.key, e.vars) : e.message]); }
});

// ============ Testing ============
get('/admin/testing', 'admin:super', (c) => {
  const s = settings();
  const n = (sql: string) => Number(q.val(sql) ?? 0);
  page(c, 'Testing', <>
    <p className="muted">Use this before launch to try every flow with simulated money, then remove all test data in one step.</p>
    <Box title="Test mode">
      {!testModeAvailable() ? <p><b>Off — live payments are connected.</b> Test mode is only possible while no Paystack secret key is set, so simulated money can never mix with real money.</p> : <>
        <p>Status: <b>{simulatedPayments() ? 'ON — wallet top-ups and withdrawals are simulated; no real money moves.' : 'OFF — payments are not connected yet, so wallets cannot be funded.'}</b></p>
        <div className="btn-row">
          <Act action="/admin/testing/mode" fields={{ on: s.test_mode ? 0 : 1 }} label={s.test_mode ? 'Turn test mode off' : 'Turn test mode on'} tone={s.test_mode ? 'ghost' : 'green'} />
          <Act action="/admin/testing/sample-lots" label="Add 4 sample Trade Lots and Harvest Circles" />
        </div>
        <p className="muted small">While test mode is on, the Marketplace (selling trades to other Champions) is on with no minimum holding period and Harvest Circles are open to every Champion (whatever the Circles setting), every sample lot allows circles, and the soybean and sesame lots come with two open sample circles each. Sample lots and circles are marked “TEST ·”. While test mode is on, every page shows a “payments are simulated” banner. Adding the live Paystack key later switches test mode off automatically.</p>
      </>}
    </Box>
    <Box title="Clear all test data">
      <p>Now on the platform: <b>{n("SELECT COUNT(*) FROM users WHERE role!='admin'")}</b> Champions, <b>{n('SELECT COUNT(*) FROM lots')}</b> lots, <b>{n('SELECT COUNT(*) FROM trades')}</b> trades, <b>{n('SELECT COUNT(*) FROM payments')}</b> payments, <b>{n('SELECT COUNT(*) FROM withdrawals')}</b> withdrawals, <b>{n('SELECT COUNT(*) FROM leads')}</b> leads.</p>
      <p className="small"><b>Removed:</b> every Champion account, all wallets and ledger entries, lots, trades, Trail updates, payments, withdrawals, circles, plans, gifts, referrals, waitlist, leads, organisations, newsletters and subscribers, messages, notifications, agent drafts and what agents learned, social posts and email campaign history.<br />
        <b>Kept:</b> admin accounts (with their authenticators), all settings and rates, commodities, prices, FAQs and page text, Chronicles posts, and the audit log. A full backup is saved first.</p>
      <form method="post" action="/admin/testing/clear" className="form-grid"><Csrf />
        <F label="Type CLEAR to confirm" name="confirm" required />
        <div className="form-actions"><button className="btn btn-danger" type="submit">Clear all test data</button></div>
      </form>
      <p className="muted small">Tables emptied: {testTables().join(', ')}.</p>
    </Box>
  </>);
});
post('/admin/testing/mode', 'admin:super', (c) => {
  if (!testModeAvailable()) return c.back('/admin/testing', ['error', 'Live payments are connected, so test mode is not available.']);
  setSetting('test_mode', c.int('on') === 1); audit(c.user!.id, 'testmode', String(c.int('on')), undefined, c.ip);
  c.back('/admin/testing', ['ok', c.int('on') === 1 ? 'Test mode is on: payments are simulated.' : 'Test mode is off.']);
});
post('/admin/testing/sample-lots', 'admin:super', (c) => {
  if (!testModeAvailable()) return c.back('/admin/testing', ['error', 'Not available with live payments.']);
  const n = addSampleLots(c.user!.id); audit(c.user!.id, 'testmode.sample_lots', String(n), undefined, c.ip);
  c.back('/admin/testing', ['ok', `${n} sample lots added and open, with sample Harvest Circles.`]);
});
post('/admin/testing/clear', 'admin:super', (c) => {
  if (c.str('confirm') !== 'CLEAR') return c.back('/admin/testing', ['error', 'Type CLEAR (capital letters) to confirm.']);
  const r = clearTestData(c.user!.id);
  setSetting('test_mode', false);
  c.redirect('/admin/testing', ['ok', `Test data cleared (${r.counts.champions || 0} Champions removed). Backup saved as ${r.backup.split('/').pop()}. Test mode is off.`]);
});

// ============ Prospects (finding new Champions) ============
const ORG_STATUSES = ['new', 'contacted', 'replied', 'meeting', 'won', 'lost', 'do_not_contact'];
get('/admin/prospects', 'admin:content', (c) => {
  syncLeads();
  const tab = String(c.query.tab || 'orgs');
  const s = settings();
  const leadStats = q.all<any>('SELECT status, COUNT(*) n FROM leads GROUP BY status');
  const orgStats = q.all<any>('SELECT status, COUNT(*) n FROM prospects GROUP BY status');
  const nOf = (rows: any[], st: string) => rows.find((r) => r.status === st)?.n || 0;
  const leads = tab === 'leads' ? q.all<any>('SELECT * FROM leads ORDER BY id DESC LIMIT 300') : [];
  const orgs = tab === 'orgs' ? q.all<any>("SELECT * FROM prospects ORDER BY CASE status WHEN 'replied' THEN 0 WHEN 'meeting' THEN 1 WHEN 'new' THEN 2 WHEN 'contacted' THEN 3 ELSE 4 END, id DESC LIMIT 300") : [];
  page(c, 'Prospects', <>
    <p className="muted">The Prospector finds new Champions in three ways: it invites people who asked to hear from us (waitlist, newsletter, contact form, WhatsApp), asks Champions with good results to refer friends, and contacts organisations whose members could join together through Harvest Circles. Invitations to people who asked to hear from us can send automatically when autonomy allows; emails to organisations and imported contacts always wait for your approval. Every email has a one-click opt-out.</p>
    <Kpis items={[['Leads', leadStats.reduce((a, r) => a + r.n, 0), `${nOf(leadStats, 'signed_up')} signed up · ${nOf(leadStats, 'unsubscribed')} unsubscribed`], ['Organisations', orgStats.reduce((a, r) => a + r.n, 0), `${nOf(orgStats, 'replied') + nOf(orgStats, 'meeting')} talking · ${nOf(orgStats, 'won')} won`], ['Prospector', agentOn('prospector') ? agentMode('prospector') === 'ai' && aiLive() ? 'AI' : 'Rules' : 'off', `up to ${s.prospect_daily_limit} drafts a day`]]} />
    <div className="btn-row">
      <a className={`btn btn-sm ${tab === 'orgs' ? 'btn-primary' : 'btn-ghost'}`} href="/admin/prospects?tab=orgs">Organisations</a>
      <a className={`btn btn-sm ${tab === 'leads' ? 'btn-primary' : 'btn-ghost'}`} href="/admin/prospects?tab=leads">People (leads)</a>
      <Act action="/admin/agents/run/prospector" label="Run Prospector now" tone="green" />
      <Act action="/admin/prospects/research" label="Find organisations on the web now" />
    </div>
    {tab === 'orgs' ? <>
      <Box title="Organisations">{orgs.length ? <Table rows={orgs} cols={[
        ['Organisation', (o) => <><b>{o.name}</b><br /><span className="muted small">{o.segment}{o.location ? ` · ${o.location}` : ''} · {o.source === 'ai_research' ? 'found by AI' : o.source}</span>{o.why && <p className="small">{o.why}</p>}</>],
        ['Contact', (o) => <span className="small">{o.contact_name && <>{o.contact_name}<br /></>}{o.email || <span className="muted">no email</span>}{o.phone && <><br />{o.phone}</>}{o.website && <><br /><a href={o.website} target="_blank" rel="noopener">website</a></>}</span>],
        ['Emails', (o) => <span className="small">{o.touches}{o.last_touch_at && <><br /><D v={o.last_touch_at} /></>}</span>],
        ['Status', (o) => <form method="post" action={`/admin/prospects/${o.id}/status`} className="inline"><Csrf /><select name="status" defaultValue={o.status} data-autosubmit aria-label="Status">{ORG_STATUSES.map((x) => <option key={x} value={x}>{x.replace(/_/g, ' ')}</option>)}</select> <button className="btn btn-ghost btn-sm" type="submit">Save</button></form>],
      ]} /> : <p className="muted">No organisations yet. Add one below, import a list, or let the Prospector find some (AI mode).</p>}</Box>
      <div className="grid-2 top">
        <Box title="Add an organisation"><Form action="/admin/prospects/new" submit="Add">
          <F label="Name" name="name" required /><F label="Type" name="segment" options={String(s.prospect_segments).split(',').map((x) => [x.trim(), x.trim()] as [string, string]).concat([['Other', 'Other']])} />
          <F label="Location" name="location" /><F label="Contact person" name="contact_name" /><F label="Email" name="email" type="email" /><F label="Phone" name="phone" /><F label="Website" name="website" />
          <F label="Why they fit" name="why" type="textarea" rows={2} />
        </Form></Box>
        <Box title="What the Prospector looks for"><Form action="/admin/prospects/settings" submit="Save">
          <F label="Types of organisation (comma-separated)" name="prospect_segments" type="textarea" rows={3} value={s.prospect_segments} />
          <F label="Places (comma-separated)" name="prospect_regions" type="textarea" rows={2} value={s.prospect_regions} />
          <F label="Most drafts per day" name="prospect_daily_limit" type="number" value={s.prospect_daily_limit} />
        </Form><p className="muted small">AI research takes the next type and place in turn once a week, or when you click “Find organisations”.</p></Box>
      </div>
    </> : <>
      <Box title="People who may become Champions">{leads.length ? <Table rows={leads} cols={[
        ['Who', (l) => <><b>{l.email || l.phone}</b>{l.name && <> · {l.name}</>}<br /><span className="muted small">from {l.source} · {l.lang}{l.consent ? ' · consent recorded' : ' · no consent: will not be emailed'}</span></>],
        ['Invitations', (l) => <span className="small">{l.touches} of 3{l.last_touch_at && <><br /><D v={l.last_touch_at} /></>}</span>],
        ['Status', (l) => <S s={l.status} />],
      ]} /> : <p className="muted">No leads yet. They arrive automatically from the waitlist, newsletter, contact form and WhatsApp.</p>}
        <p className="muted small">People who messaged on WhatsApp without an account are listed but not emailed (no email address); they already got a sign-up link in the chat.</p></Box>
      <Box title="Import contacts (CSV)">
        <p className="small">Columns: <code>email, name, phone, lang, consent</code>. Put <code>yes</code> in consent only for people who agreed to hear from Kitovu (e.g. signed up at an event or are existing Kitovu customers). Contacts without consent are stored but never emailed. Invitations to imported contacts always wait for approval.</p>
        <Form action="/admin/prospects/import" multipart submit="Import"><div className="field"><label htmlFor="a-csv">CSV file</label><input id="a-csv" type="file" name="csv" accept=".csv,text/csv" required /></div></Form>
      </Box>
    </>}
  </>);
});
post('/admin/prospects/new', 'admin:content', (c) => {
  const name = c.str('name', 150); if (!name) return c.back('/admin/prospects', ['error', 'Enter a name.']);
  const email = c.str('email', 150).toLowerCase();
  q.run('INSERT OR IGNORE INTO prospects (name, segment, location, website, contact_name, email, phone, why, source, token, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    name, c.str('segment', 80) || 'Other', c.str('location', 120) || null, c.str('website', 200) || null, c.str('contact_name', 100) || null, isEmail(email) ? email : null, c.str('phone', 40) || null, c.str('why', 500) || null, 'manual', randomToken(16), now());
  audit(c.user!.id, 'prospect.add', name, undefined, c.ip);
  c.back('/admin/prospects', ['ok', `${name} added. The Prospector drafts the first email on its next run.`]);
});
post('/admin/prospects/:id/status', 'admin:content', (c) => {
  const st = c.str('status'); if (!ORG_STATUSES.includes(st)) throw new HttpError(400, 'Unknown status');
  q.run('UPDATE prospects SET status=? WHERE id=?', st, Number(c.params.id));
  audit(c.user!.id, 'prospect.status', c.params.id, st, c.ip);
  c.back('/admin/prospects', ['ok', 'Saved.']);
});
post('/admin/prospects/settings', 'admin:content', (c) => {
  setSetting('prospect_segments', c.str('prospect_segments', 1000).split(',').map((x) => x.trim()).filter(Boolean).join(','));
  setSetting('prospect_regions', c.str('prospect_regions', 1000).split(',').map((x) => x.trim()).filter(Boolean).join(','));
  setSetting('prospect_daily_limit', Math.min(200, Math.max(1, c.int('prospect_daily_limit') || 15)));
  c.back('/admin/prospects', ['ok', 'Saved.']);
});
post('/admin/prospects/research', 'admin:content', async (c) => {
  try { const r = await researchProspects(); audit(c.user!.id, 'prospect.research', undefined, r, c.ip); c.redirect('/admin/agents?status=all&agent=prospector', ['ok', r]); }
  catch (e: any) { c.back('/admin/prospects', ['error', e.message]); }
});
post('/admin/prospects/import', 'admin:content', (c) => {
  const f = c.files.csv; if (!f) return c.back('/admin/prospects?tab=leads', ['error', 'Choose a CSV file.']);
  let added = 0, skipped = 0;
  for (const r of parseCsv(f.data.toString('utf8')).slice(0, 5000)) {
    const email = String(r.email || '').trim().toLowerCase();
    if (!isEmail(email) || q.get('SELECT 1 FROM users WHERE email=?', email)) { skipped++; continue; }
    const lang = ['en', 'fr', 'sw', 'pt', 'ar'].includes(String(r.lang || '').trim()) ? String(r.lang).trim() : 'en';
    const res = q.run('INSERT OR IGNORE INTO leads (email, phone, name, lang, source, consent, token, created_at) VALUES (?,?,?,?,?,?,?,?)', email, String(r.phone || '').trim() || null, String(r.name || '').trim().split(' ')[0] || null, lang, 'import', /^(y|yes|1|true)$/i.test(String(r.consent || '').trim()) ? 1 : 0, randomToken(16), now());
    res.changes ? added++ : skipped++;
  }
  audit(c.user!.id, 'leads.import', undefined, { added, skipped }, c.ip);
  c.redirect('/admin/prospects?tab=leads', ['ok', `${added} contacts imported, ${skipped} skipped (invalid, duplicate or already Champions).`]);
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

// ============ Homepage numbers ============
get('/admin/figures', 'admin:content', (c) => {
  const s = settings();
  const live = {
    champions: Number(q.val("SELECT COUNT(*) FROM users WHERE role='champion'") ?? 0),
    tons: Number(q.val("SELECT COALESCE(SUM(tonnage),0) FROM lots WHERE status='completed'") ?? 0),
    payouts: Number(q.val("SELECT COALESCE(SUM(amount + earnings),0) FROM trades WHERE status='paid'") ?? 0),
    farmers: Number(q.val("SELECT COALESCE(SUM(farmers),0) FROM lots WHERE status='completed'") ?? 0),
  };
  const shown = siteStats();
  const row = (label: string, name: string, value: string | number, liveV: string, shownV: string, hint: string) => (
    <tr><td><b>{label}</b><br /><span className="muted small">{hint}</span></td><td><input name={name} defaultValue={value} inputMode="numeric" aria-label={label} /></td><td className="num">{liveV}</td><td className="num"><b>{shownV}</b></td></tr>);
  page(c, 'Homepage numbers', <>
    <p className="muted">These four numbers show on the homepage and across the site, with a “+” after them (for example “1,000+ Harvest Champions”).</p>
    <form method="post" action="/admin/figures" className="card admin-box"><Csrf />
      <div className="table-wrap"><table className="table">
        <thead><tr><th>Number</th><th>Your figure</th><th className="num">Platform activity so far</th><th className="num">Shown now</th></tr></thead>
        <tbody>
          {row('Harvest Champions', 'baseline_champions', s.baseline_champions, live.champions.toLocaleString('en'), shown.champions.toLocaleString('en') + '+', 'People who have backed trades with Kitovu')}
          {row('Tons in completed trades', 'baseline_tons', s.baseline_tons, live.tons.toLocaleString('en'), shown.tons.toLocaleString('en') + '+', 'Commodities moved')}
          {row('Paid out to Champions (₦)', 'baseline_payouts', naira(s.baseline_payouts), fmtNGN(live.payouts), fmtNGN(shown.payouts) + '+', 'Principal and earnings paid')}
          {row('Farmers served by Kitovu', 'baseline_farmers', s.baseline_farmers, live.farmers.toLocaleString('en'), shown.farmers.toLocaleString('en') + '+', 'Farmers Kitovu has worked with')}
        </tbody>
      </table></div>
      <fieldset className="field"><legend>How to show them</legend>
        <label className="check"><input type="radio" name="figures_mode" value="add" defaultChecked={s.figures_mode !== 'exact'} /> <span>Your figure <b>plus</b> platform activity (numbers grow by themselves as Champions join and get paid)</span></label>
        <label className="check"><input type="radio" name="figures_mode" value="exact" defaultChecked={s.figures_mode === 'exact'} /> <span>Exactly your figure (you update it yourself)</span></label>
      </fieldset>
      <div className="form-actions"><button className="btn btn-primary" type="submit">Save homepage numbers</button> <a className="btn btn-ghost" href="/" target="_blank">View homepage</a></div>
    </form>
  </>);
});
post('/admin/figures', 'admin:content', (c) => {
  const n = (k: string) => Math.max(0, Math.round(Number(String(c.body[k] ?? '').replace(/[₦,\s]/g, '')) || 0));
  const v = { baseline_champions: n('baseline_champions'), baseline_tons: n('baseline_tons'), baseline_payouts: Math.round(Number(String(c.body.baseline_payouts ?? '').replace(/[₦,\s]/g, '')) * 100) || 0, baseline_farmers: n('baseline_farmers'), figures_mode: c.body.figures_mode === 'exact' ? 'exact' : 'add' };
  for (const [k, val] of Object.entries(v)) setSetting(k as any, val);
  audit(c.user!.id, 'settings.figures', undefined, v, c.ip);
  c.redirect('/admin/figures', ['ok', 'Homepage numbers saved.']);
});

export const _ = { setSetting, ACTION_KINDS };
