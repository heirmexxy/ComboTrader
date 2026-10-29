// Champion pages: Harvest Plan, Gift a Harvest, public gift claim, impact receipt, account rights.
import type { ReactNode } from 'react';
import { useC } from '../render';
import { AppLayout, PublicLayout } from '../layout';
import { Csrf, Money, Field, Select, Check, Empty, Progress, Tag, toneFor } from '../components';
import { PageHead } from '../public/pages';
import { fmtDate, fmtNum } from '../../lib/i18n';
import { fmtNGN, earningsFor } from '../../lib/util';
import { lotRemaining, lotPeriods, rateFor, lotDefaultPeriod, type Lot } from '../../lib/trading';
import { monthsToTarget, type Plan } from '../../lib/plans';
import { settings } from '../../lib/settings';
import { config } from '../../lib/config';
import { LuPiggyBank, LuHeartHandshake, LuDownload, LuShare2, LuSprout } from 'react-icons/lu';
import { FaWhatsapp } from 'react-icons/fa6';

function Card({ title, children, className = '' }: { title?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`card ${className}`}>{title && <h2 className="card-title">{title}</h2>}{children}</section>;
}
const lotOptions = (lots: Lot[], c: ReturnType<typeof useC>) => lots.map((l) => ({ value: String(l.id), label: `${l.title} · ${lotDefaultPeriod(l)} ${c.t('plan.months_short')} · ${rateFor(lotDefaultPeriod(l)) / 100}% · ${c.t('lot.left', { amount: fmtNGN(lotRemaining(l)) })}` }));

// ---------- Harvest Plan ----------
export function AppPlans({ plans, commodities, error }: { plans: Plan[]; commodities: { code: string; name: string }[]; error?: string }) {
  const c = useC();
  const s = settings();
  return (
    <AppLayout title={c.t('plan.title')}>
      <div className="page-title"><div><p className="eyebrow dark">{c.t('plan.eyebrow')}</p><h1>{c.t('plan.title')}</h1></div></div>
      {error && <div className="flash flash-error" role="alert">{error}</div>}
      <p className="lead-dark">{c.t('plan.intro')}</p>
      <div className="grid-2 top">
        <Card title={c.t('plan.new')}>
          <form method="post" action="/app/plans" data-plan>
            <Csrf />
            <Field label={c.t('plan.name')} name="name" value={c.t('plan.name_default')} maxLength={60} />
            <div className="row-2">
              <Field label={c.t('plan.target')} name="target" required inputMode="numeric" value="250,000" dir="ltr" />
              <Field label={c.t('plan.monthly')} name="monthly" required inputMode="numeric" value="25,000" dir="ltr" hint={c.t('plan.min_monthly', { amount: fmtNGN(s.plan_min_monthly) })} />
            </div>
            <div className="row-2">
              <Select label={c.t('plan.day')} name="day" value="25" options={Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))} />
              <Select label={c.t('plan.commodity')} name="commodity" options={[{ value: '', label: c.t('plan.any_commodity') }, ...commodities.map((x) => ({ value: x.code, label: x.name }))]} />
            </div>
            <p className="calc-inline" data-plan-months>{c.t('plan.months_to', { n: monthsToTarget(25000000, 2500000) })}</p>
            <p className="muted small">{c.t('plan.how')}</p>
            <Check name="agree" required label={<>{c.t('plan.agree')} <a href="/legal/terms" target="_blank">{c.t('footer.terms')}</a></>} />
            <button className="btn btn-primary btn-block" type="submit"><LuPiggyBank aria-hidden /> {c.t('plan.start')}</button>
          </form>
        </Card>
        <div>
          {plans.length === 0 ? <Empty>{c.t('plan.none')}</Empty> : plans.map((p) => (
            <Card key={p.id} className="mb">
              <div className="box-head"><h3><a href={`/app/plans/${p.id}`}>{p.name}</a></h3><Tag tone={toneFor(p.status)}>{c.t(`plan.status.${p.status}`)}</Tag></div>
              <Progress pct={Math.min(100, Math.round(((p.saved || 0) / p.target_amount) * 100))} />
              <p className="small"><Money kobo={p.saved || 0} /> {c.t('plan.of')} <Money kobo={p.target_amount} /> · {c.t('plan.per_month', { amount: fmtNGN(p.monthly_amount) })}</p>
            </Card>
          ))}
        </div>
      </div>
    </AppLayout>
  );
}

export function PlanDetail({ p }: { p: Plan }) {
  const c = useC();
  const saved = p.saved || 0;
  const pct = Math.min(100, Math.round((saved / p.target_amount) * 100));
  const live = ['active', 'paused', 'ready'].includes(p.status);
  return (
    <AppLayout title={p.name}>
      <div className="page-title"><div><p className="eyebrow dark">{c.t('plan.title')}</p><h1>{p.name}</h1></div><Tag tone={toneFor(p.status)}>{c.t(`plan.status.${p.status}`)}</Tag></div>
      <div className="kpis">
        <div className="kpi"><span className="kpi-label">{c.t('plan.saved')}</span><strong className="kpi-value"><Money kobo={saved} approxFor /></strong></div>
        <div className="kpi"><span className="kpi-label">{c.t('plan.target')}</span><strong className="kpi-value"><Money kobo={p.target_amount} /></strong></div>
        <div className="kpi"><span className="kpi-label">{c.t('plan.monthly')}</span><strong className="kpi-value"><Money kobo={p.monthly_amount} /></strong></div>
        <div className="kpi"><span className="kpi-label">{c.t('plan.next')}</span><strong className="kpi-value">{p.status === 'active' && p.next_charge_at ? fmtDate(c.lang, p.next_charge_at) : '—'}</strong></div>
      </div>
      <Card>
        <Progress pct={pct} label={`${pct}%`} />
        <p>{p.status === 'completed' ? <>{c.t('plan.done_line')} {p.trade_id && <a href={`/app/trades/${p.trade_id}`}>{c.t('plan.view_trade')}</a>}</> : p.status === 'ready' ? c.t('plan.ready_line') : c.t('plan.months_to', { n: monthsToTarget(p.target_amount, p.monthly_amount, saved) })}</p>
        <p className="muted small">{p.card_label ? c.t('plan.card', { card: p.card_label }) : c.t('plan.manual')}</p>
      </Card>
      {live && <div className="grid-2 top mt">
        <Card title={c.t('plan.topup')}>
          <form method="post" action={`/app/plans/${p.id}/topup`}>
            <Csrf />
            <Field label={c.t('wallet.amount')} name="amount" required inputMode="numeric" value={(p.monthly_amount / 100).toLocaleString('en')} dir="ltr" />
            <button className="btn btn-primary btn-block" type="submit">{c.t('plan.topup_btn')}</button>
          </form>
        </Card>
        <Card title={c.t('plan.manage')}>
          <div className="btn-col">
            {p.status === 'active' && <form method="post" action={`/app/plans/${p.id}/pause`}><Csrf /><button className="btn btn-ghost btn-block" type="submit">{c.t('plan.pause')}</button></form>}
            {p.status === 'paused' && <form method="post" action={`/app/plans/${p.id}/resume`}><Csrf /><button className="btn btn-ghost btn-block" type="submit">{c.t('plan.resume')}</button></form>}
            {saved > 0 && <form method="post" action={`/app/plans/${p.id}/release`}><Csrf /><button className="btn btn-ghost btn-block" type="submit">{c.t('plan.release')}</button></form>}
            <form method="post" action={`/app/plans/${p.id}/cancel`} data-confirm={c.t('plan.cancel_confirm')}><Csrf /><button className="btn btn-danger btn-block" type="submit">{c.t('plan.cancel')}</button></form>
          </div>
          <p className="muted small">{c.t('plan.release_note')}</p>
        </Card>
      </div>}
    </AppLayout>
  );
}

// ---------- Gift a Harvest ----------
export function AppGifts({ lots, sent, received, wallet, error }: { lots: Lot[]; sent: any[]; received: any[]; wallet: number; error?: string }) {
  const c = useC();
  return (
    <AppLayout title={c.t('gift.title')}>
      <div className="page-title"><div><p className="eyebrow dark">{c.t('gift.eyebrow')}</p><h1>{c.t('gift.title')}</h1></div></div>
      {error && <div className="flash flash-error" role="alert">{error}</div>}
      <p className="lead-dark">{c.t('gift.intro')}</p>
      <div className="grid-2 top">
        <Card title={c.t('gift.new')}>
          {lots.length === 0 ? <p className="muted">{c.t('lot.none')}</p> : (
            <form method="post" action="/app/gifts">
              <Csrf />
              <Select label={c.t('gift.lot')} name="lot_id" options={lotOptions(lots, c)} />
              <Field label={c.t('wallet.amount')} name="amount" required inputMode="numeric" value={(Math.min(...lots.map((l) => l.min_commit)) / 100).toLocaleString('en')} dir="ltr" hint={c.t('lots.from_wallet', { amount: fmtNGN(wallet) })} />
              <Field label={c.t('gift.to_name')} name="recipient_name" required maxLength={80} />
              <div className="row-2"><Field label={c.t('gift.to_email')} name="recipient_email" type="email" /><Field label={c.t('gift.to_phone')} name="recipient_phone" type="tel" dir="ltr" /></div>
              <Field label={c.t('gift.message')} name="message" type="textarea" maxLength={300} />
              <Check name="agree" required label={<>{c.t('gift.agree')} <a href="/legal/risk" target="_blank">{c.t('footer.risk')}</a></>} />
              <button className="btn btn-primary btn-block" type="submit"><LuHeartHandshake aria-hidden /> {c.t('gift.send')}</button>
              {wallet <= 0 && <p className="small"><a href="/app/wallet#fund">{c.t('app.fund_cta')}</a></p>}
            </form>
          )}
        </Card>
        <div>
          <Card title={c.t('gift.sent')}>
            {sent.length === 0 ? <p className="muted">{c.t('app.none')}</p> : <ul className="list">{sent.map((g) => (
              <li key={g.id}><div><strong>{g.recipient_name}</strong><p className="muted small">{g.lot_title} · <Money kobo={g.amount} /> · {fmtDate(c.lang, g.created_at)}</p></div>
                <div className="btn-row"><Tag tone={toneFor(g.status === 'sent' ? 'pending' : g.status === 'claimed' ? 'paid' : g.status)}>{c.t(`gift.status.${g.status}`)}</Tag>
                  {g.status === 'sent' && <><form method="post" action={`/app/gifts/${g.id}/resend`} className="inline"><Csrf /><button className="btn btn-ghost btn-sm" type="submit">{c.t('gift.resend')}</button></form>
                  <form method="post" action={`/app/gifts/${g.id}/cancel`} className="inline" data-confirm={c.t('gift.cancel_confirm')}><Csrf /><button className="btn btn-ghost btn-sm" type="submit">{c.t('gift.cancel')}</button></form></>}</div></li>))}</ul>}
          </Card>
          {received.length > 0 && <Card title={c.t('gift.received')} className="mt"><ul className="list">{received.map((g) => (
            <li key={g.id}><span>{c.t('gift.from', { name: g.giver_first })} · {g.lot_title}</span><a href={`/app/trades/${g.trade_id}`}><Money kobo={g.amount} /></a></li>))}</ul></Card>}
        </div>
      </div>
    </AppLayout>
  );
}

export function GiftClaim({ g, token, error }: { g: any; token: string; error?: string }) {
  const c = useC();
  const earn = g ? earningsFor(g.amount, g.rate_bps, g.period_months) : 0;
  return (
    <PublicLayout title={c.t('gift.claim_title')} noindex>
      <PageHead title={c.t('gift.claim_title')} />
      <section className="section"><div className="container narrow"><div className="card">
        {error && <div className="flash flash-error" role="alert">{error}</div>}
        {!g || g.status !== 'sent' ? <p className="flash flash-error">{c.t('gift.invalid')}</p> : <>
          <p className="big">{c.t('gift.claim_line', { name: g.giver_first, amount: fmtNGN(g.amount), commodity: g.commodity })}</p>
          {g.message && <blockquote className="quote">“{g.message}”</blockquote>}
          <dl className="kv">
            <dt>{c.t('nav.lots')}</dt><dd>{g.lot_title}{g.region ? ` · ${g.region}` : ''}</dd>
            <dt>{c.t('trades.earn')}</dt><dd dir="ltr">{fmtNGN(earn)}</dd>
            <dt>{c.t('trades.matures')}</dt><dd>{fmtDate(c.lang, g.matures_at)}</dd>
          </dl>
          {c.user ? (
            <form method="post" action={`/gift/${token}/claim`}><Csrf /><button className="btn btn-primary btn-block btn-lg" type="submit">{c.t('gift.claim_btn')}</button></form>
          ) : <div className="btn-col"><a className="btn btn-primary btn-block btn-lg" href={`/signup?next=${encodeURIComponent(`/gift/${token}`)}`}>{c.t('gift.claim_signup')}</a><a className="btn btn-ghost btn-block" href={`/login?next=${encodeURIComponent(`/gift/${token}`)}`}>{c.t('nav.login')}</a></div>}
          <p className="muted small mt">{c.t('gift.claim_note')}</p>
        </>}
      </div></div></section>
    </PublicLayout>
  );
}

// ---------- Impact receipt (public, shareable) ----------
export function ImpactReceipt({ r, token }: { r: any; token: string }) {
  const c = useC();
  const share = r.amount / r.target_amount;
  const tons = share * r.tonnage, farmers = Math.max(1, Math.round(share * r.farmers));
  const img = `${config.baseUrl}/card/${token}.png?lang=${c.lang}`;
  const line = c.t('receipt.line', { name: r.first_name, tons: fmtNum(c.lang, tons, 1), commodity: r.commodity.toLowerCase(), farmers, region: r.region || c.t('receipt.nigeria') });
  return (
    <PublicLayout title={c.t('receipt.title', { name: r.first_name })} description={line} image={img}>
      <PageHead title={c.t('receipt.title', { name: r.first_name })} intro={line} />
      <section className="section"><div className="container narrow">
        <div className="card center">
          <img className="harvest-card" src={img} alt={line} width={1080} height={1080} />
          <p className="big mt"><LuSprout aria-hidden /> {line}</p>
          <p className="muted small">{c.t('receipt.stage', { stage: c.t(`trail.${r.stage || 'funded'}`) })} · {r.certificate_no} · <a href={`/verify/${r.certificate_no}`}>{c.t('verify.title')}</a></p>
          <div className="btn-row center-row mt">
            <a className="btn btn-primary" href={`/r/${r.referral_code}`}>{c.t('receipt.cta')}</a>
            <a className="btn btn-ghost" href={`https://wa.me/?text=${encodeURIComponent(`${line} ${config.baseUrl}/receipt/${token}`)}`} target="_blank" rel="noopener"><FaWhatsapp aria-hidden /> WhatsApp</a>
            <button type="button" className="btn btn-ghost" data-share data-title="ComboTrader" data-text={line} data-url={`${config.baseUrl}/receipt/${token}`}><LuShare2 aria-hidden /> {c.t('blog.share')}</button>
          </div>
        </div>
        <p className="muted small center mt">{c.t('receipt.disclaimer')}</p>
      </div></section>
    </PublicLayout>
  );
}

// ---------- Account rights (inside the profile page) ----------
export function AccountRights({ blockers }: { blockers: string[] }) {
  const c = useC();
  const u = c.user!;
  const year = new Date().getUTCFullYear();
  return (
    <div className="grid-2 top mt">
      <Card title={<span id="growing">{c.t('roll.title')}</span>}>
        <p className="small">{c.t('roll.intro')}</p>
        <form method="post" action="/app/profile/preferences">
          <Csrf />
          <Select label={c.t('roll.default')} name="rollover_default" value={(u as any).rollover_default || 'off'} options={['off', 'principal', 'all'].map((v) => ({ value: v, label: c.t(`roll.${v}`) }))} />
          <Check name="whatsapp_opt_in" label={c.t('wa.opt_in', { number: config.waNumber ? `+${config.waNumber}` : c.t('wa.our_number') })} checked={!!(u as any).whatsapp_opt_in} />
          {config.waNumber && <p className="small"><a href={`https://wa.me/${config.waNumber}?text=MENU`} target="_blank" rel="noopener"><FaWhatsapp aria-hidden /> {c.t('wa.open_chat')}</a></p>}
          <button className="btn btn-ghost" type="submit">{c.t('common.save')}</button>
        </form>
      </Card>
      <Card title={<span id="data">{c.t('rights.title')}</span>}>
        <p className="small">{c.t('rights.intro')}</p>
        <div className="btn-col">
          <a className="btn btn-ghost btn-block" href="/app/profile/export.json"><LuDownload aria-hidden /> {c.t('rights.export')}</a>
          <a className="btn btn-ghost btn-block" href={`/app/wallet/statement.pdf?year=${year}`}><LuDownload aria-hidden /> {c.t('rights.statement', { year })}</a>
          {year > 2026 && <a className="btn btn-ghost btn-block" href={`/app/wallet/statement.pdf?year=${year - 1}`}><LuDownload aria-hidden /> {c.t('rights.statement', { year: year - 1 })}</a>}
        </div>
        <details className="mt"><summary>{c.t('close.title')}</summary>
          {blockers.length ? <><p className="small">{c.t('close.blocked')}</p><ul className="small">{blockers.map((b) => <li key={b}>{c.t(b)}</li>)}</ul></> : (
            <form method="post" action="/app/profile/close" data-confirm={c.t('close.confirm')}>
              <Csrf />
              <p className="small">{c.t('close.intro')}</p>
              <Field label={c.t('close.reason')} name="reason" type="textarea" maxLength={300} />
              <Field label={c.t('close.type')} name="confirm" required hint={c.t('close.type_hint')} />
              {u.totp_enabled ? <Field label={c.t('wallet.twofa_code')} name="code" required inputMode="numeric" maxLength={6} dir="ltr" /> : null}
              <button className="btn btn-danger" type="submit">{c.t('close.btn')}</button>
            </form>
          )}
        </details>
      </Card>
    </div>
  );
}

/** Keep Growing control on a trade page. */
export function RolloverControl({ tradeId, value }: { tradeId: number; value: string }) {
  const c = useC();
  return (
    <form method="post" action={`/app/trades/${tradeId}/rollover`} className="rollover-form">
      <Csrf />
      <Select label={c.t('roll.at_maturity')} name="rollover" value={value || 'off'} options={['off', 'principal', 'all'].map((v) => ({ value: v, label: c.t(`roll.${v}`) }))} />
      <button className="btn btn-ghost btn-sm" type="submit">{c.t('common.save')}</button>
    </form>
  );
}
