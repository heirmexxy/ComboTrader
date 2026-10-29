// Marketplace views: "Sell this trade" on a trade page, and "Buy from Champions".
import { useC } from '../render';
import { AppLayout } from '../layout';
import { Csrf, Money, Tag, Check, Empty } from '../components';
import { fmtDate } from '../../lib/i18n';
import { fmtNGN } from '../../lib/util';
import { stageLabel } from '../../lib/trading';

export interface SellInfo {
  reason: string | null; reasonVars?: Record<string, string>; units: number; unitAmount: number; feePct: number; maxDisc: number;
  quoteAll: { value: number; price: number; fee: number; sellerGets: number };
  listing?: { id: number; units_total: number; units_left: number; discount_bps: number } | null;
  bought?: { at: string; price: number; payout: number } | null;
}
export function SellBox({ m, tradeId }: { m: SellInfo; tradeId: number }) {
  const c = useC();
  if (m.listing) return (
    <section className="card market-box">
      <h2 className="card-title">{c.t('market.sell_title')}</h2>
      <p><Tag tone="gold">{c.t('market.listed_status', { left: m.listing.units_left, total: m.listing.units_total, disc: m.listing.discount_bps / 100 })}</Tag></p>
      <form method="post" action={`/app/market/${m.listing.id}/cancel`}><Csrf /><button className="btn btn-ghost btn-sm" type="submit">{c.t('market.cancel')}</button></form>
    </section>
  );
  if (m.reason === 'market.off') return null;
  return (
    <section className="card market-box">
      <h2 className="card-title">{c.t('market.sell_title')}</h2>
      <p className="muted">{c.t('market.sell_intro', { fee: m.feePct })}</p>
      {m.reason ? <p className="hint">{c.t(m.reason, m.reasonVars)}</p> : (
        <form method="post" action={`/app/trades/${tradeId}/sell`} data-sell data-unit-value={Math.round(m.quoteAll.value / m.units)} data-fee={m.feePct}>
          <Csrf />
          <p className="small">{c.t('market.units_info', { n: m.units, amount: fmtNGN(m.unitAmount) })}</p>
          <div className="row-2">
            <div className="field"><label htmlFor="f-units">{c.t('market.units_to_sell')}</label><input id="f-units" name="units" type="number" min={1} max={m.units} defaultValue={m.units} required inputMode="numeric" /></div>
            <div className="field"><label htmlFor="f-disc">{c.t('market.discount', { max: m.maxDisc })}</label><input id="f-disc" name="discount" type="number" min={0} max={m.maxDisc} step="0.5" defaultValue={0} inputMode="decimal" /></div>
          </div>
          <p className="calc-inline">{c.t('market.value_now')}: <b dir="ltr">{fmtNGN(m.quoteAll.value)}</b> · {c.t('market.you_receive')}: <b dir="ltr" data-sell-get>{fmtNGN(m.quoteAll.sellerGets)}</b></p>
          <button className="btn btn-primary" type="submit">{c.t('market.list')}</button>
        </form>
      )}
    </section>
  );
}
export function BoughtNote({ b }: { b: NonNullable<SellInfo['bought']> }) {
  const c = useC();
  return <p className="flash flash-info">{c.t('market.bought_note', { date: fmtDate(c.lang, b.at), price: fmtNGN(b.price), payout: fmtNGN(b.payout), gain: fmtNGN(b.payout - b.price) })}</p>;
}

export interface Offer { id: number; lot_title: string; commodity: string; region: string | null; stage: string | null; units_left: number; units_total: number; unit_amount: number; discount_bps: number; matures_at: string;
  q1: { price: number; payout: number; daysLeft: number; annualPct: number } }
export function MarketPage({ offers, mine, wallet }: { offers: Offer[]; mine: { id: number; lot_title: string; units_left: number; units_total: number; status: string; discount_bps: number }[]; wallet: number }) {
  const c = useC();
  return (
    <AppLayout title={c.t('market.title')}>
      <div className="page-title"><div><h1>{c.t('market.title')}</h1><p className="muted">{c.t('market.intro')}</p></div></div>
      {offers.length === 0 ? <Empty>{c.t('market.none')}</Empty> : <div className="grid-3">{offers.map((o) => (
        <section key={o.id} className="card offer">
          <p className="eyebrow dark">{o.commodity}{o.region ? ` · ${o.region}` : ''}</p>
          <h3>{o.lot_title}</h3>
          {o.stage && <p className="small muted">{stageLabel(c.lang, o.stage)}</p>}
          <dl className="offer-terms">
            <div><dt>{c.t('market.price_now')} ({c.t('market.per_unit')})</dt><dd><Money kobo={o.q1.price} />{o.discount_bps > 0 && <Tag tone="green">−{o.discount_bps / 100}%</Tag>}</dd></div>
            <div><dt>{c.t('market.you_get', { date: fmtDate(c.lang, o.matures_at) })}</dt><dd><Money kobo={o.q1.payout} /></dd></div>
            <div><dt>{c.t('market.return_label')}</dt><dd>{c.t('market.return', { pct: o.q1.annualPct })}</dd></div>
            <div><dt>{c.t('market.avail')}</dt><dd>{c.t('market.units_avail', { n: o.units_left, total: o.units_total })}</dd></div>
          </dl>
          <p className="muted small">{c.t('market.days_left', { n: o.q1.daysLeft })}</p>
          <form method="post" action={`/app/market/${o.id}/buy`} data-buy data-unit-price={o.q1.price} data-wallet={wallet}>
            <Csrf />
            <div className="field"><label htmlFor={`u-${o.id}`}>{c.t('market.buy_units')}</label><input id={`u-${o.id}`} name="units" type="number" min={1} max={o.units_left} defaultValue={1} required inputMode="numeric" /></div>
            <p className="calc-inline">{c.t('market.total')}: <b dir="ltr" data-buy-total>{fmtNGN(o.q1.price)}</b></p>
            <Check name="agree" required label={<>{c.t('market.agree')} <a href="/legal/risk" target="_blank">{c.t('footer.risk')}</a></>} />
            <button className="btn btn-primary btn-block" type="submit">{c.t('market.buy')}</button>
          </form>
        </section>
      ))}</div>}
      {mine.length > 0 && <section className="card">
        <h2 className="card-title">{c.t('market.your_listings')}</h2>
        <ul className="list">{mine.map((l) => <li key={l.id}><span>{l.lot_title} · {c.t('market.listed_status', { left: l.units_left, total: l.units_total, disc: l.discount_bps / 100 })}</span>
          {l.status === 'listed' ? <form method="post" action={`/app/market/${l.id}/cancel`} className="inline"><Csrf /><button className="btn btn-ghost btn-sm" type="submit">{c.t('market.cancel')}</button></form> : <Tag>{c.t(`market.status.${l.status}`)}</Tag>}</li>)}</ul>
      </section>}
    </AppLayout>
  );
}
