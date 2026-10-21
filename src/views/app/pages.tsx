import type { ReactNode } from 'react';
import { useC } from '../render';
import { AppLayout } from '../layout';
import { Csrf, Money, LotCard, LotTerms, Trail, Tag, toneFor, Field, Select, Check, Empty, Progress } from '../components';
import { CircleCard } from '../public/pages';
import { fmtDate, fmtNum, LANGS } from '../../lib/i18n';
import { fmtNGN, earningsFor } from '../../lib/util';
import { RANKS, lotRemaining, lateEarnings, type Lot, type Trade } from '../../lib/trading';
import type { Circle } from '../../lib/circles';
import { config } from '../../lib/config';
import { settings } from '../../lib/settings';
import { estimateFee } from '../../lib/wallet';
import { LuWallet, LuSprout, LuCalendar, LuReceipt, LuArrowRight, LuDownload, LuShare2, LuCopy, LuShieldCheck, LuCheck } from 'react-icons/lu';
import { FaWhatsapp, FaXTwitter, FaFacebook, FaLinkedin } from 'react-icons/fa6';

function Card({ title, children, className = '' }: { title?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`card ${className}`}>{title && <h2 className="card-title">{title}</h2>}{children}</section>;
}
function Kpi({ label, children, icon }: { label: string; children: ReactNode; icon?: ReactNode }) {
  return <div className="kpi">{icon}<span className="kpi-label">{label}</span><strong className="kpi-value">{children}</strong></div>;
}

export interface HomeData {
  wallet: number; reserved: number; impact: { tons: number; farmers: number; committed: number; earned: number; expected: number };
  rank: { rank: string; index: number; next: { rank: string; tons: number } | null }; nextPayout: Trade & { lot_title?: string } | undefined;
  activeCount: number; lots: Lot[]; recent: { title: string; body: string | null; created_at: string; link: string | null }[];
}
export function AppHome({ d }: { d: HomeData }) {
  const c = useC();
  const u = c.user!;
  return (
    <AppLayout title={c.t('app.nav.home')}>
      <div className="page-title"><h1>{c.t('app.hello', { name: u.first_name })}</h1>
        <div className="cta-row"><a className="btn btn-primary" href="/app/wallet#fund">{c.t('app.fund_cta')}</a><a className="btn btn-ghost" href="/app/lots">{c.t('app.lot_cta')}</a></div></div>
      {!u.phone_verified_at && <div className="flash flash-info">{c.t('app.verify_phone_banner')} <a href="/verify-phone">{c.t('auth.phone_title')}</a></div>}
      <div className="kpis">
        <Kpi label={c.t('app.committed')} icon={<LuSprout aria-hidden />}><Money kobo={d.impact.committed} approxFor /></Kpi>
        <Kpi label={c.t('app.expected')} icon={<LuReceipt aria-hidden />}><Money kobo={d.impact.expected} /></Kpi>
        <Kpi label={c.t('app.earned')} icon={<LuCheck aria-hidden />}><Money kobo={d.impact.earned} /></Kpi>
        <Kpi label={c.t('app.next_payout')} icon={<LuCalendar aria-hidden />}>{d.nextPayout ? fmtDate(c.lang, d.nextPayout.matures_at) : '—'}</Kpi>
        <Kpi label={c.t('app.wallet')} icon={<LuWallet aria-hidden />}><Money kobo={d.wallet} approxFor /></Kpi>
        <Kpi label={c.t('app.active_trades')}>{d.activeCount}</Kpi>
      </div>
      <div className="grid-2">
        <Card title={c.t('app.rank')} className="rank-card">
          <div className="rank-row">{RANKS.map((r, i) => <span key={r} className={`rank-step ${i <= d.rank.index ? 'on' : ''}`}>{c.t(`rank.${r}`)}</span>)}</div>
          <p className="rank-now">{c.t(`rank.${d.rank.rank}`)}</p>
          <p className="muted">{d.rank.next ? c.t('rank.next', { tons: fmtNum(c.lang, d.rank.next.tons, 1), rank: c.t(`rank.${d.rank.next.rank}`) }) : c.t('rank.top')}</p>
        </Card>
        <Card title={c.t('app.impact')}>
          <p className="big">{c.t('app.impact_line', { tons: fmtNum(c.lang, d.impact.tons, 1), farmers: d.impact.farmers })}</p>
          <a className="arrow-link" href="/app/referrals">{c.t('app.nav.refer')} <LuArrowRight aria-hidden /></a>
        </Card>
      </div>
      <h2 className="section-title">{c.t('app.open_lots')}</h2>
      {d.lots.length ? <div className="grid-3">{d.lots.map((l) => <LotCard key={l.id} lot={l} href={`/app/lots/${l.id}`} />)}</div> : <Empty>{c.t('lot.none')}</Empty>}
      <h2 className="section-title">{c.t('app.recent')}</h2>
      <Card>{d.recent.length ? <ul className="list">{d.recent.map((n, i) => <li key={i}><div><strong>{n.title}</strong><p className="muted small">{n.body}</p></div><span className="muted small">{fmtDate(c.lang, n.created_at)}</span></li>)}</ul> : <p className="muted">{c.t('app.none')}</p>}</Card>
    </AppLayout>
  );
}

export function AppLots({ lots }: { lots: Lot[] }) {
  const c = useC();
  return (
    <AppLayout title={c.t('app.nav.lots')}>
      <div className="page-title"><h1>{c.t('lots.title')}</h1></div>
      <p className="lead-dark">{c.t('lots.intro')}</p>
      {lots.length ? <div className="grid-3">{lots.map((l) => <LotCard key={l.id} lot={l} href={`/app/lots/${l.id}`} />)}</div> : <Empty>{c.t('lot.none')} <a href="/lots">{c.t('lot.waitlist_btn')}</a></Empty>}
    </AppLayout>
  );
}

export function JoinLot({ lot, wallet, trail, error }: { lot: Lot; wallet: number; trail: any[]; error?: string }) {
  const c = useC();
  const open = lot.status === 'open';
  const rem = lotRemaining(lot);
  const def = Math.min(Math.max(lot.min_commit, 0), rem);
  return (
    <AppLayout title={lot.title}>
      <div className="page-title"><div><p className="eyebrow dark">{lot.commodity_name} · {lot.code}</p><h1>{c.t('lots.join_title', { lot: lot.title })}</h1></div></div>
      {error && <div className="flash flash-error" role="alert">{error}</div>}
      <div className="grid-2 top">
        <Card>
          {open ? (
            <form method="post" action={`/app/lots/${lot.id}/join`} data-join data-rate={lot.rate_bps} data-months={lot.period_months}>
              <Csrf />
              <Field label={c.t('lots.amount')} name="amount" required inputMode="numeric" value={(def / 100).toLocaleString('en')} dir="ltr" hint={`${c.t('lot.min', { amount: fmtNGN(lot.min_commit) })} · ${c.t('lot.left', { amount: fmtNGN(rem) })}`} />
              <p className="calc-inline">{c.t('calc.earn')}: <b data-join-earn dir="ltr">{fmtNGN(earningsFor(def, lot.rate_bps, lot.period_months))}</b> · {c.t('lot.matures', { date: fmtDate(c.lang, new Date(Date.now() + lot.period_months * 30.44 * 864e5).toISOString()) })}</p>
              <p className="muted">{c.t('lots.from_wallet', { amount: fmtNGN(wallet) })} {wallet < def && <a href="/app/wallet#fund">{c.t('app.fund_cta')}</a>}</p>
              <Check name="agree" required label={<>{c.t('lots.agree_terms')} <a href="/legal/risk" target="_blank">{c.t('footer.risk')}</a></>} />
              <button className="btn btn-primary btn-block btn-lg" type="submit">{c.t('lots.confirm')}</button>
            </form>
          ) : <p className="big">{c.t('lots.not_open')}</p>}
          <Progress pct={Math.min(100, Math.round(((lot.funded || 0) / lot.target_amount) * 100))} />
        </Card>
        <LotTerms lot={lot} />
      </div>
      <Card title={c.t('trades.trail')} className="mt"><Trail events={trail} /></Card>
    </AppLayout>
  );
}

type TradeRow = Trade & { lot_title: string; lot_code: string; commodity_name: string };
export function AppTrades({ trades }: { trades: TradeRow[] }) {
  const c = useC();
  return (
    <AppLayout title={c.t('trades.title')}>
      <div className="page-title"><h1>{c.t('trades.title')}</h1><a className="btn btn-primary" href="/app/lots">{c.t('app.lot_cta')}</a></div>
      {trades.length === 0 ? <Empty>{c.t('trades.none')}</Empty> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>{c.t('nav.lots')}</th><th>{c.t('trades.amount')}</th><th>{c.t('trades.earn')}</th><th>{c.t('trades.matures')}</th><th>{c.t('common.status')}</th></tr></thead>
          <tbody>{trades.map((t) => (
            <tr key={t.id}>
              <td><a href={`/app/trades/${t.id}`}><b>{t.lot_title}</b></a><br /><span className="muted small">{t.commodity_name} · {t.certificate_no}</span></td>
              <td><Money kobo={t.amount} /></td>
              <td><Money kobo={t.earnings ?? earningsFor(t.amount, t.rate_bps, t.period_months)} /></td>
              <td>{fmtDate(c.lang, t.matures_at)}</td>
              <td><Tag tone={toneFor(t.status)}>{c.t(`trades.status.${t.status}`)}</Tag></td>
            </tr>))}</tbody>
        </table></div>
      )}
    </AppLayout>
  );
}

export function TradeDetail({ t, trail, tons, farmers }: { t: TradeRow & { buyer_type: string; rate_bps: number }; trail: any[]; tons: number; farmers: number }) {
  const c = useC();
  const earn = t.earnings ?? earningsFor(t.amount, t.rate_bps, t.period_months) + lateEarnings(t as any);
  const card = `${config.baseUrl}/card/${t.share_token}.png`;
  const refLink = `${config.baseUrl}/r/${c.user!.referral_code}`;
  const text = `${c.t('trades.share_text', { tons: fmtNum(c.lang, tons, 1), commodity: t.commodity_name.toLowerCase(), farmers })} ${refLink}`;
  const enc = encodeURIComponent;
  return (
    <AppLayout title={t.lot_title}>
      <div className="page-title"><div><p className="eyebrow dark">{t.certificate_no}</p><h1>{t.lot_title}</h1></div><Tag tone={toneFor(t.status)}>{c.t(`trades.status.${t.status}`)}</Tag></div>
      {(t as any).original_matures_at && t.status !== 'paid' && <div className="flash flash-info">{c.t('trades.delayed', { from: fmtDate(c.lang, (t as any).original_matures_at), to: fmtDate(c.lang, t.matures_at), reason: (t as any).delay_reason || '' })}</div>}
      <div className="kpis">
        <Kpi label={c.t('trades.amount')}><Money kobo={t.amount} approxFor /></Kpi>
        <Kpi label={c.t('trades.earn')}><Money kobo={earn} /></Kpi>
        <Kpi label={c.t('trades.started')}>{fmtDate(c.lang, t.start_at)}</Kpi>
        <Kpi label={c.t('trades.matures')}>{fmtDate(c.lang, t.matures_at)}</Kpi>
      </div>
      <div className="grid-2 top">
        <Card title={c.t('trades.trail')}>{trail.length ? <Trail events={trail} /> : <><Trail events={[]} /><p className="muted">{c.t('trades.trail_none')}</p></>}</Card>
        <div>
          <Card title={c.t('trades.card')}>
            <img className="harvest-card" src={`/card/${t.share_token}.png?lang=${c.lang}`} alt={c.t('trades.card')} width={1080} height={1080} />
            <div className="share-row">
              <a href={`https://wa.me/?text=${enc(text)}`} target="_blank" rel="noopener" aria-label="WhatsApp"><FaWhatsapp /></a>
              <a href={`https://x.com/intent/post?text=${enc(text)}`} target="_blank" rel="noopener" aria-label="X"><FaXTwitter /></a>
              <a href={`https://www.facebook.com/sharer/sharer.php?u=${enc(refLink)}`} target="_blank" rel="noopener" aria-label="Facebook"><FaFacebook /></a>
              <a href={`https://www.linkedin.com/sharing/share-offsite/?url=${enc(refLink)}`} target="_blank" rel="noopener" aria-label="LinkedIn"><FaLinkedin /></a>
              <button type="button" className="btn btn-ghost btn-sm" data-share data-title="ComboTrader" data-text={text} data-url={refLink} data-file={card}><LuShare2 aria-hidden /> {c.t('blog.share')}</button>
              <a className="btn btn-ghost btn-sm" href={`/card/${t.share_token}.png?lang=${c.lang}`} download={`harvest-card-${t.certificate_no}.png`}><LuDownload aria-hidden /> {c.t('trades.download')}</a>
            </div>
          </Card>
          <Card className="mt"><a className="btn btn-green btn-block" href={`/app/trades/${t.id}/certificate.pdf`}><LuDownload aria-hidden /> {c.t('trades.cert')}</a>
            <p className="muted small center">{config.baseUrl}/verify/{t.certificate_no}</p></Card>
        </div>
      </div>
    </AppLayout>
  );
}

export function AppCircles({ mine, open, lots }: { mine: (Circle & { my_slots: number })[]; open: Circle[]; lots: Lot[] }) {
  const c = useC();
  return (
    <AppLayout title={c.t('circles.title')}>
      <div className="page-title"><h1>{c.t('circles.title')}</h1></div>
      <p className="lead-dark">{c.t('circles.intro')}</p>
      {mine.length > 0 && <><h2 className="section-title">{c.t('circles.your_slots', { n: '' }).replace(/\s+$/, '')}</h2>
        <div className="grid-3">{mine.map((ci) => <div key={ci.id}><CircleCard ci={ci} /><p className="muted small">{c.t('circles.your_slots', { n: ci.my_slots })}</p></div>)}</div></>}
      <h2 className="section-title">{c.t('nav.circles')}</h2>
      {open.length ? <div className="grid-3">{open.map((ci) => <CircleCard key={ci.id} ci={ci} />)}</div> : <Empty>{c.t('circles.none')}</Empty>}
      {lots.length > 0 && (
        <Card title={c.t('circles.create')} className="mt">
          <form method="post" action="/app/circles" className="form-grid">
            <Csrf />
            <Field label={c.t('circles.name')} name="name" required maxLength={60} placeholder="Family Harvest Circle" />
            <Select label={c.t('nav.lots')} name="lot_id" options={lots.map((l) => ({ value: String(l.id), label: `${l.title} · ${l.rate_bps / 100}%` }))} />
            <Select label={c.t('circles.how_many')} name="slots" value="25" options={[10, 20, 25, 50].map((n) => ({ value: String(n), label: String(n) }))} />
            <Select label={c.t('circles.slot_price', { amount: '' }).trim()} name="slot_price" value="10000" options={[5000, 10000, 20000, 50000].map((n) => ({ value: String(n), label: fmtNGN(n * 100) }))} />
            <button className="btn btn-primary" type="submit">{c.t('circles.create')}</button>
          </form>
        </Card>
      )}
    </AppLayout>
  );
}

export function CircleDetail({ ci, mySlots, wallet }: { ci: Circle; mySlots: number; wallet: number }) {
  const c = useC();
  const left = ci.slots - (ci.taken || 0);
  const canTake = ci.status === 'filling' && left > 0 && mySlots < ci.max_slots_per_user;
  const invite = `${config.baseUrl}/c/${ci.invite_code}`;
  return (
    <AppLayout title={ci.name}>
      <div className="page-title"><div><p className="eyebrow dark">{ci.lot_title}</p><h1>{ci.name}</h1></div><Tag tone={ci.status === 'filled' ? 'green' : 'gold'}>{c.t(`circles.status.${ci.status}`)}</Tag></div>
      <div className="grid-2 top">
        <Card>
          <Progress pct={Math.round(((ci.taken || 0) / ci.slots) * 100)} />
          <p className="lot-fill"><span>{c.t('circles.slots', { taken: ci.taken || 0, total: ci.slots })}</span><span>{c.t('circles.slot_price', { amount: fmtNGN(ci.slot_price) })}</span></p>
          <p className="muted">{c.t('circles.deadline', { date: fmtDate(c.lang, ci.deadline) })} · {c.t('lot.rate', { rate: (ci.rate_bps || 0) / 100 })} · {c.t('lot.period', { n: ci.period_months || 0 })}</p>
          {mySlots > 0 && <p className="ok-line"><LuCheck aria-hidden /> {c.t('circles.your_slots', { n: mySlots })}</p>}
          {canTake && (
            <form method="post" action={`/app/circles/${ci.id}/take`}>
              <Csrf />
              <Field label={c.t('circles.how_many')} name="slots" type="number" min={1} max={Math.min(left, ci.max_slots_per_user - mySlots)} value={1} required hint={c.t('circles.max', { n: ci.max_slots_per_user })} />
              <p className="muted small">{c.t('lots.from_wallet', { amount: fmtNGN(wallet) })}</p>
              <button className="btn btn-primary btn-block" type="submit">{c.t('circles.take')}</button>
            </form>
          )}
          {mySlots > 0 && ci.status === 'filling' && <form method="post" action={`/app/circles/${ci.id}/release`} className="mt"><Csrf /><button className="btn btn-ghost btn-sm" type="submit">{c.t('circles.leave')}</button></form>}
        </Card>
        <Card title={c.t('circles.invite')}>
          <div className="copy-row"><input readOnly value={invite} aria-label={c.t('circles.invite')} dir="ltr" /><button type="button" className="btn btn-ghost" data-copy={invite}><LuCopy aria-hidden /> {c.t('ref.copy')}</button></div>
          <ol className="numbered small">{[1, 2, 3, 4].map((i) => <li key={i}>{c.t(`circles.how${i}`)}</li>)}</ol>
        </Card>
      </div>
    </AppLayout>
  );
}

export interface WalletData { balance: number; reserved: number; statement: { kind: string; memo: string | null; amount: number; created_at: string }[]; withdrawals: any[]; banks: any[]; kyc: string }
export function AppWallet({ d }: { d: WalletData }) {
  const c = useC();
  const s = settings();
  const u = c.user!;
  const bank = d.banks.find((b) => b.country === 'NG' && b.name_match);
  const intl = d.banks.find((b) => b.country !== 'NG');
  const jk = (k: string, memo: string | null) => c.t(`jk.${k === 'withdraw_paid' ? 'withdraw_hold' : k === 'payout' ? 'principal' : k}`, { lot: memo || '' });
  return (
    <AppLayout title={c.t('wallet.title')}>
      <div className="page-title"><h1>{c.t('wallet.title')}</h1></div>
      <div className="kpis">
        <Kpi label={c.t('wallet.available')} icon={<LuWallet aria-hidden />}><Money kobo={d.balance} approxFor /></Kpi>
        <Kpi label={c.t('wallet.reserved')}><Money kobo={d.reserved} /></Kpi>
      </div>
      <div className="grid-2 top">
        <Card title={c.t('wallet.fund')}>
          <form method="post" action="/app/wallet/fund" id="fund">
            <Csrf />
            <Field label={c.t('wallet.amount')} name="amount" required inputMode="numeric" value="1,000,000" dir="ltr" />
            <p className="muted small">{c.t('wallet.fund_note')}{s.pass_card_fees && ` ${c.t('wallet.fee_note', { fee: fmtNGN(estimateFee(100000000)) })}`}</p>
            <button className="btn btn-primary btn-block" type="submit">{c.t('wallet.fund_btn')}</button>
          </form>
        </Card>
        <Card title={c.t('wallet.withdraw')}>
          {d.kyc !== 'verified' ? <p>{c.t('wallet.kyc_needed')} <a href="/app/profile#kyc">{c.t('profile.verification')}</a></p>
          : bank ? (
            <form method="post" action="/app/wallet/withdraw">
              <Csrf />
              <input type="hidden" name="bank_account_id" value={bank.id} />
              <Field label={c.t('wallet.amount')} name="amount" required inputMode="numeric" dir="ltr" hint={c.t('wallet.min', { amount: fmtNGN(s.min_withdrawal) })} />
              <p className="muted small">{c.t('wallet.to_bank')}: <b>{bank.bank_name} · {bank.account_number} · {bank.account_name}</b></p>
              {u.totp_enabled ? <Field label={c.t('wallet.twofa_code')} name="code" required inputMode="numeric" autoComplete="one-time-code" maxLength={6} dir="ltr" /> : null}
              <button className="btn btn-green btn-block" type="submit">{c.t('wallet.withdraw_btn')}</button>
            </form>
          ) : <p>{c.t('wallet.no_bank')} <a href="/app/profile#bank">{c.t('bank.add')}</a></p>}
          {d.kyc === 'verified' && (u.country !== 'NG' || intl) && (
            <form method="post" action="/app/wallet/withdraw" className="mt">
              <Csrf /><input type="hidden" name="route" value="manual" />
              <p className="small">{c.t('wallet.intl')}</p>
              <Field label={c.t('wallet.amount')} name="amount" required inputMode="numeric" dir="ltr" />
              {u.totp_enabled ? <Field label={c.t('wallet.twofa_code')} name="code" required inputMode="numeric" maxLength={6} dir="ltr" /> : null}
              <button className="btn btn-ghost btn-block" type="submit">{c.t('wallet.intl_btn')}</button>
            </form>
          )}
        </Card>
      </div>
      {d.withdrawals.length > 0 && <Card title={c.t('wallet.withdrawals')} className="mt"><div className="table-wrap"><table className="table">
        <thead><tr><th>{c.t('wallet.date')}</th><th>{c.t('wallet.amount_col')}</th><th>{c.t('common.status')}</th></tr></thead>
        <tbody>{d.withdrawals.map((w) => <tr key={w.id}><td>{fmtDate(c.lang, w.created_at)}</td><td><Money kobo={w.amount} /></td><td><Tag tone={toneFor(w.status)}>{c.t(`wallet.status.${w.status}`)}</Tag></td></tr>)}</tbody>
      </table></div></Card>}
      <Card title={c.t('wallet.history')} className="mt">
        <p><a href="/app/wallet/statement.csv" className="small"><LuDownload aria-hidden /> {c.t('wallet.statement')}</a></p>
        {d.statement.length === 0 ? <p className="muted">{c.t('app.none')}</p> : <div className="table-wrap"><table className="table">
          <thead><tr><th>{c.t('wallet.date')}</th><th>{c.t('wallet.desc')}</th><th className="num">{c.t('wallet.amount_col')}</th></tr></thead>
          <tbody>{d.statement.map((r, i) => <tr key={i}><td>{fmtDate(c.lang, r.created_at, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td><td>{jk(r.kind, r.memo)}</td><td className={`num ${r.amount < 0 ? 'neg' : 'pos'}`} dir="ltr">{r.amount < 0 ? '−' : '+'}{fmtNGN(Math.abs(r.amount))}</td></tr>)}</tbody>
        </table></div>}
      </Card>
    </AppLayout>
  );
}

export function AppReferrals({ friends, earned, reward }: { friends: { first_name: string; created_at: string; funded: number; reward: number | null }[]; earned: number; reward: number }) {
  const c = useC();
  const link = `${config.baseUrl}/r/${c.user!.referral_code}`;
  const text = `${c.t('ref.share_text')} ${link}`;
  const enc = encodeURIComponent;
  return (
    <AppLayout title={c.t('ref.title')}>
      <div className="page-title"><h1>{c.t('ref.title')}</h1></div>
      <Card>
        <p className="big">{c.t('ref.intro', { amount: fmtNGN(reward) })}</p>
        <div className="copy-row"><input readOnly value={link} aria-label={c.t('ref.link')} dir="ltr" /><button type="button" className="btn btn-primary" data-copy={link}><LuCopy aria-hidden /> {c.t('ref.copy')}</button></div>
        <p className="muted">{c.t('ref.code')}: <b dir="ltr">{c.user!.referral_code}</b></p>
        <div className="share-row"><span>{c.t('ref.share')}:</span>
          <a href={`https://wa.me/?text=${enc(text)}`} target="_blank" rel="noopener" aria-label="WhatsApp"><FaWhatsapp /></a>
          <a href={`https://x.com/intent/post?text=${enc(text)}`} target="_blank" rel="noopener" aria-label="X"><FaXTwitter /></a>
          <a href={`https://www.facebook.com/sharer/sharer.php?u=${enc(link)}`} target="_blank" rel="noopener" aria-label="Facebook"><FaFacebook /></a>
          <a href={`https://www.linkedin.com/sharing/share-offsite/?url=${enc(link)}`} target="_blank" rel="noopener" aria-label="LinkedIn"><FaLinkedin /></a>
        </div>
      </Card>
      <div className="kpis mt"><Kpi label={c.t('ref.earned')}><Money kobo={earned} /></Kpi><Kpi label={c.t('ref.friends')}>{friends.length}</Kpi></div>
      <Card title={c.t('ref.friends')}>
        {friends.length === 0 ? <p className="muted">{c.t('app.none')}</p> : <ul className="list">{friends.map((f, i) => (
          <li key={i}><span>{f.first_name}</span><span className="muted small">{f.funded ? c.t('ref.status_funded', { amount: fmtNGN(f.reward || 0) }) : c.t('ref.status_signed')} · {fmtDate(c.lang, f.created_at)}</span></li>))}</ul>}
      </Card>
    </AppLayout>
  );
}

export function AppProfile({ banks, bankList, countries }: { banks: any[]; bankList: { code: string; name: string }[]; countries: { code: string; name: string }[] }) {
  const c = useC();
  const u = c.user!;
  const ng = banks.find((b) => b.country === 'NG');
  const intl = banks.find((b) => b.country !== 'NG');
  return (
    <AppLayout title={c.t('profile.title')}>
      <div className="page-title"><h1>{c.t('profile.title')}</h1></div>
      <div className="grid-2 top">
        <Card title={c.t('profile.personal')}>
          <form method="post" action="/app/profile">
            <Csrf />
            <div className="row-2"><Field label={c.t('auth.first')} name="first_name" required value={u.first_name} /><Field label={c.t('auth.last')} name="last_name" required value={u.last_name} /></div>
            <p className="muted small">{u.email} · {u.phone || '—'} {u.phone_verified_at ? <LuShieldCheck aria-label="verified" /> : <a href="/verify-phone">{c.t('auth.phone_title')}</a>}</p>
            <div className="row-2"><Select label={c.t('auth.country')} name="country" value={u.country} options={countries.map((x) => ({ value: x.code, label: x.name }))} /><Field label={c.t('auth.city')} name="city" value={u.city} /></div>
            <div className="row-2"><Field label={c.t('profile.kin_name')} name="next_of_kin_name" value={u.next_of_kin_name} /><Field label={c.t('profile.kin_phone')} name="next_of_kin_phone" type="tel" value={u.next_of_kin_phone} dir="ltr" /></div>
            <Select label={c.t('profile.lang')} name="lang" value={u.lang} options={LANGS.map((l) => ({ value: l.code, label: l.label }))} />
            <Check name="notif_email" label={c.t('profile.notif_email')} checked={!!u.notif_email} />
            <Check name="notif_sms" label={c.t('profile.notif_sms')} checked={!!u.notif_sms} />
            <Check name="feed_opt_in" label={c.t('profile.feed')} checked={!!u.feed_opt_in} />
            <button className="btn btn-primary" type="submit">{c.t('profile.save')}</button>
          </form>
        </Card>
        <div>
          <Card title={<span id="kyc">{c.t('profile.verification')} <Tag tone={toneFor(u.kyc_status)}>{c.t(`kyc.${u.kyc_status}`)}</Tag></span>}>
            {u.kyc_status === 'verified' ? <p className="ok-line"><LuShieldCheck aria-hidden /> {c.t('kyc.verified')}</p> : u.kyc_status === 'pending' ? <p>{c.t('kyc.submitted')}</p> : <>
              {u.kyc_note && <p className="flash flash-error">{u.kyc_note}</p>}
              {u.country === 'NG' ? (
                <form method="post" action="/app/profile/kyc">
                  <Csrf />
                  <p className="small">{c.t('kyc.ng_intro')}</p>
                  <Field label={c.t('kyc.bvn')} name="bvn" required inputMode="numeric" pattern="\d{11}" maxLength={11} dir="ltr" autoComplete="off" />
                  <Select label={c.t('bank.bank')} name="bank_code" options={bankList.map((b) => ({ value: b.code, label: b.name }))} value={ng?.bank_code} />
                  <Field label={c.t('bank.number')} name="account_number" required inputMode="numeric" pattern="\d{10}" maxLength={10} value={ng?.account_number} dir="ltr" />
                  <button className="btn btn-green" type="submit">{c.t('kyc.submit')}</button>
                </form>
              ) : (
                <form method="post" action="/app/profile/kyc-doc" encType="multipart/form-data">
                  <Csrf />
                  <p className="small">{c.t('kyc.intl_intro')}</p>
                  <div className="field"><label htmlFor="doc">{c.t('kyc.upload')}</label><input id="doc" type="file" name="doc" accept="image/jpeg,image/png,application/pdf" required /></div>
                  <button className="btn btn-green" type="submit">{c.t('kyc.submit')}</button>
                </form>
              )}
            </>}
          </Card>
          <Card title={<span id="bank">{c.t('bank.title')}</span>} className="mt">
            {ng ? <p className="ok-line"><LuCheck aria-hidden /> {c.t('bank.current')}: <b>{ng.bank_name} · {ng.account_number} · {ng.account_name}</b></p> : <p className="muted">{c.t('bank.none')}</p>}
            <form method="post" action="/app/profile/bank">
              <Csrf />
              <Select label={c.t('bank.bank')} name="bank_code" options={bankList.map((b) => ({ value: b.code, label: b.name }))} />
              <Field label={c.t('bank.number')} name="account_number" required inputMode="numeric" pattern="\d{10}" maxLength={10} dir="ltr" />
              {c.user!.totp_enabled ? <Field label={c.t('wallet.twofa_code')} name="code" required inputMode="numeric" maxLength={6} dir="ltr" /> : null}
              <button className="btn btn-ghost" type="submit">{c.t('bank.add')}</button>
            </form>
            {u.country !== 'NG' && (
              <form method="post" action="/app/profile/bank-intl" className="mt">
                <Csrf />
                <Field label={c.t('bank.intl')} name="details" type="textarea" required value={intl?.details} hint={c.t('bank.intl_hint')} maxLength={600} />
                <button className="btn btn-ghost" type="submit">{c.t('common.save')}</button>
              </form>
            )}
          </Card>
        </div>
      </div>
    </AppLayout>
  );
}

export function AppSecurity({ setupSecret, otpauth, sessions, logins }: { setupSecret?: string; otpauth?: string; sessions: any[]; logins: any[] }) {
  const c = useC();
  const u = c.user!;
  return (
    <AppLayout title={c.t('sec.title')}>
      <div className="page-title"><h1>{c.t('sec.title')}</h1></div>
      <div className="grid-2 top">
        <Card title={<>{c.t('sec.twofa')} <Tag tone={u.totp_enabled ? 'green' : 'grey'}>{u.totp_enabled ? c.t('sec.twofa_on') : c.t('sec.twofa_off')}</Tag></>}>
          <p className="muted small">{c.t('sec.twofa_why')}</p>
          {u.totp_enabled ? (
            <form method="post" action="/app/security/2fa/disable"><Csrf />
              <Field label={c.t('auth.code')} name="code" required inputMode="numeric" maxLength={6} dir="ltr" />
              <button className="btn btn-ghost" type="submit">{c.t('sec.disable')}</button></form>
          ) : setupSecret ? (
            <form method="post" action="/app/security/2fa/enable"><Csrf />
              <p className="small">{c.t('sec.scan')}</p>
              <p className="secret" dir="ltr">{setupSecret.match(/.{1,4}/g)!.join(' ')}</p>
              <p><a className="btn btn-ghost btn-sm" href={otpauth}>{c.t('sec.open_app')}</a></p>
              <Field label={c.t('auth.code')} name="code" required inputMode="numeric" maxLength={6} dir="ltr" autoComplete="one-time-code" />
              <button className="btn btn-primary" type="submit">{c.t('sec.enable')}</button></form>
          ) : <form method="post" action="/app/security/2fa/setup"><Csrf /><button className="btn btn-primary" type="submit">{c.t('sec.enable')}</button></form>}
        </Card>
        <Card title={c.t('sec.change_pw')}>
          <form method="post" action="/app/security/password"><Csrf />
            <Field label={c.t('sec.current')} name="current" type="password" required autoComplete="current-password" />
            <Field label={c.t('sec.new')} name="password" type="password" required autoComplete="new-password" hint={c.t('auth.password_hint')} />
            <button className="btn btn-primary" type="submit">{c.t('common.save')}</button></form>
        </Card>
      </div>
      <Card title={c.t('sec.devices')} className="mt">
        <ul className="list">{sessions.map((s) => <li key={s.id}><div><b>{shortUa(s.ua)}</b> {s.id === c.sessionId && <Tag tone="green">{c.t('sec.this_device')}</Tag>}<p className="muted small" dir="ltr">{s.ip}</p></div><span className="muted small">{fmtDate(c.lang, s.last_seen, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span></li>)}</ul>
        <form method="post" action="/app/security/signout-others"><Csrf /><button className="btn btn-ghost btn-sm" type="submit">{c.t('sec.signout_all')}</button></form>
      </Card>
      <Card title={c.t('sec.history')} className="mt">
        <ul className="list">{logins.map((l, i) => <li key={i}><span>{shortUa(l.ua)} <span className="muted small" dir="ltr">{l.ip}</span></span><span><Tag tone={l.success ? 'green' : 'red'}>{l.success ? c.t('sec.success') : c.t('sec.failed')}</Tag> <span className="muted small">{fmtDate(c.lang, l.created_at, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span></span></li>)}</ul>
      </Card>
    </AppLayout>
  );
}
export function shortUa(ua: string | null) {
  const s = String(ua || '');
  const os = /Android/.test(s) ? 'Android' : /iPhone|iPad/.test(s) ? 'iPhone' : /Windows/.test(s) ? 'Windows' : /Mac OS/.test(s) ? 'Mac' : /Linux/.test(s) ? 'Linux' : 'Device';
  const br = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : /Firefox\//.test(s) ? 'Firefox' : 'Browser';
  return `${br} · ${os}`;
}

export function AppSupport({ tickets }: { tickets: any[] }) {
  const c = useC();
  return (
    <AppLayout title={c.t('support.title')}>
      <div className="page-title"><h1>{c.t('support.title')}</h1></div>
      <div className="grid-2 top">
        <Card title={c.t('support.chat')}><p>{c.t('support.chat_p')}</p><a className="arrow-link" href="/faqs">{c.t('nav.faqs')} <LuArrowRight aria-hidden /></a></Card>
        <Card title={c.t('support.ticket')}>
          <form method="post" action="/app/support"><Csrf />
            <Field label={c.t('support.subject')} name="subject" required maxLength={120} />
            <Field label={c.t('support.message')} name="body" type="textarea" required maxLength={3000} />
            <button className="btn btn-primary" type="submit">{c.t('support.send')}</button></form>
        </Card>
      </div>
      {tickets.length > 0 && <Card title={c.t('support.your_tickets')} className="mt"><ul className="list">{tickets.map((t) => (
        <li key={t.id}><div><b>{t.subject}</b><p className="small">{t.body}</p>{t.reply && <p className="reply small">↳ {t.reply}</p>}</div><Tag tone={t.status === 'open' ? 'gold' : 'green'}>{c.t(`support.status.${t.status}`)}</Tag></li>))}</ul></Card>}
    </AppLayout>
  );
}

export function AppNotifications({ items }: { items: any[] }) {
  const c = useC();
  return (
    <AppLayout title={c.t('notif.title')}>
      <div className="page-title"><h1>{c.t('notif.title')}</h1>
        <form method="post" action="/app/notifications/read"><Csrf /><button className="btn btn-ghost btn-sm" type="submit">{c.t('notif.mark_read')}</button></form></div>
      <Card title={c.t('notif.push')}>
        <p className="small">{c.t('notif.push_p')}</p>
        <button type="button" className="btn btn-green" data-push>{c.t('notif.push_btn')}</button> <span className="small" data-push-status />
      </Card>
      <Card className="mt">{items.length === 0 ? <p className="muted">{c.t('notif.none')}</p> : <ul className="list">{items.map((n) => (
        <li key={n.id} className={n.read_at ? '' : 'unread'}><div>{n.link ? <a href={n.link}><b>{n.title}</b></a> : <b>{n.title}</b>}<p className="small">{n.body}</p></div><span className="muted small">{fmtDate(c.lang, n.created_at, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span></li>))}</ul>}</Card>
    </AppLayout>
  );
}
