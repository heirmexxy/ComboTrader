import { useC } from '../render';
import { PublicLayout } from '../layout';
import { Csrf, LotCard, LotTerms, Money, Trail, Sparkline, Empty, Field, Tag, Progress, rateRange, periodRange } from '../components';
import { fmtNGN, earningsFor, addMonths, plusFormat } from '../../lib/util';
import { fmtDate, fmtNum } from '../../lib/i18n';
import { lotPct, lotRemaining, PERIODS, rateFor, type Lot } from '../../lib/trading';
import { q } from '../../lib/db';
import { countryName } from '../../lib/geo';
import type { Circle } from '../../lib/circles';
import type { PriceRow } from '../../lib/prices';
import { settings } from '../../lib/settings';
import { config } from '../../lib/config';
import { LuShieldCheck, LuSprout, LuFileCheck, LuHandshake, LuTruck, LuWarehouse, LuBanknote, LuArrowRight, LuCheck, LuMapPin, LuMessageCircle, LuPhone, LuMail, LuSmartphone, LuWheat, LuUsersRound, LuTrendingDown, LuTrendingUp } from 'react-icons/lu';

type Stats = { champions: number; tons: number; payouts: number; farmers: number };

export function StatsBand({ s }: { s: Stats }) {
  const c = useC();
  const items: [string, string][] = [
    [plusFormat(s.champions), c.t('stats.champions')],
    [`${plusFormat(s.tons)}`, c.t('stats.tons')],
    [`₦${plusFormat(s.payouts / 100)}`, c.t('stats.payouts')],
    [plusFormat(s.farmers), c.t('stats.farmers')],
  ];
  return (
    <section className="stats-band" aria-label={c.t('home.impact_h')}>
      <div className="container stats-grid">
        {items.map(([n, l], i) => <div key={i} className="stat"><strong dir="ltr">{n}</strong><span>{l}</span></div>)}
      </div>
    </section>
  );
}

export function Calculator(_: { rateBps?: number; minKobo?: number } = {}) {
  const c = useC();
  const amount = Math.max(settings().min_commit_default, 25000000);
  const months = 12;
  const rates = Object.fromEntries(PERIODS.map((m) => [m, rateFor(m)]));
  const earn = earningsFor(amount, rates[months], months);
  return (
    <section className="calc card" data-calc data-rates={JSON.stringify(rates)} aria-labelledby="calc-h">
      <h2 id="calc-h">{c.t('calc.h')}</h2>
      <div className="calc-grid">
        <div>
          <div className="field">
            <label htmlFor="calc-amount">{c.t('calc.amount')}</label>
            <input id="calc-amount" type="text" inputMode="numeric" defaultValue={(amount / 100).toLocaleString('en')} data-calc-amount dir="ltr" />
          </div>
          <fieldset className="field">
            <legend>{c.t('calc.period')}</legend>
            <div className="seg">
              {[4, 6, 9, 12].map((m) => (
                <label key={m}><input type="radio" name="calc-period" value={m} defaultChecked={m === months} data-calc-period /><span>{c.t('calc.months', { n: m })}<small className="seg-rate">{rates[m] / 100}%</small></span></label>
              ))}
            </div>
          </fieldset>
        </div>
        <div className="calc-out">
          <p>{c.t('calc.earn')}</p>
          <strong className="calc-earn" data-calc-earn dir="ltr">{fmtNGN(earn)}</strong>
          <p>{c.t('calc.total')} <b data-calc-total dir="ltr">{fmtNGN(amount + earn)}</b> <span data-calc-by>{c.t('calc.by', { date: fmtDate(c.lang, addMonths(new Date().toISOString(), months)) })}</span></p>
          <a className="btn btn-primary" href="/signup">{c.t('calc.cta')}</a>
        </div>
      </div>
      <p className="muted small">{c.t('calc.note', { r4: rates[4] / 100, r6: rates[6] / 100, r9: rates[9] / 100, r12: rates[12] / 100 })}</p>
      <template id="calc-by-tpl">{c.t('calc.by', { date: '{date}' })}</template>
    </section>
  );
}

const STEP_ICONS = [LuBanknote, LuHandshake, LuSprout];

export function HowSteps() {
  const c = useC();
  const s = { min: fmtNGN(settings().min_commit_default), low: rateFor(4) / 100, high: rateFor(12) / 100 };
  return (
    <ol className="steps">
      {[1, 2, 3].map((i) => {
        const I = STEP_ICONS[i - 1];
        return <li key={i} className="step"><span className="step-n" aria-hidden><I /></span><h3>{c.t(`how.s${i}_t`, s)}</h3><p>{c.t(`how.s${i}_d`, s)}</p></li>;
      })}
    </ol>
  );
}

export function Home({ stats, lots, circles, rateBps, heroDone = [] }: { stats: Stats; lots: Lot[]; circles: boolean; rateBps: number; heroDone?: string[] }) {
  const c = useC();
  const st = settings();
  return (
    <PublicLayout title="" description={c.t('home.sub', { low: rateFor(4) / 100, high: rateFor(12) / 100 })}>
      <section className="hero">
        <div className="container hero-grid">
          <div>
            <p className="eyebrow">{c.t('home.eyebrow')}</p>
            <h1>{c.t('home.h1')}</h1>
            <p className="lead">{c.t('home.sub', { low: rateFor(4) / 100, high: rateFor(12) / 100 })}</p>
            <div className="cta-row">
              <a className="btn btn-primary btn-lg" href="/signup">{c.t('home.cta_primary')}</a>
              <a className="btn btn-outline-light btn-lg" href="/how-it-works">{c.t('home.cta_secondary')}</a>
            </div>
            <p className="trust-line"><LuShieldCheck aria-hidden /> {c.t('home.trust', { farmers: plusFormat(stats.farmers) })}</p>
          </div>
          <div className="hero-art" aria-hidden="true">
            <div className="hero-card">
              <span className="tag tag-gold">{c.t('trades.trail')}</span>
              {lots[0] && <p className="hero-card-title">{lots[0].commodity_name} · {lots[0].code}</p>}
              {lots[0] && <Progress pct={lotPct(lots[0])} />}
              <ol className="mini-trail">{['funded', 'sourcing', 'warehoused', 'delivered', 'buyer_paid', 'champions_paid'].map((s) => <li key={s} className={heroDone.includes(s) ? 'done' : ''}>{c.t(`trail.${s}`)}</li>)}</ol>
            </div>
          </div>
        </div>
      </section>
      <StatsBand s={stats} />

      <section className="section">
        <div className="container narrow">
          <h2>{c.t('home.problem_h')}</h2>
          <p className="big">{c.t('home.problem_p1')}</p>
          <p className="big">{c.t('home.problem_p2')}</p>
          <p className="punch">{c.t('home.problem_close')}</p>
        </div>
      </section>

      <section className="section alt">
        <div className="container two-col">
          <div>
            <h2>{c.t('home.guide_h')}</h2>
            <p className="big">{c.t('home.guide_p')}</p>
            <ul className="checks">
              {[1, 3].map((i) => <li key={i}><LuCheck aria-hidden /> {c.t(`home.guide_${i}`)}</li>)}
            </ul>
            <a href="/why-kitovu" className="arrow-link">{c.t('nav.why')} <LuArrowRight aria-hidden /></a>
          </div>
          <div className="backers">
            <p className="eyebrow dark">{c.t('home.backed_by')}</p>
            <ul>{['USAID', 'Acumen', 'Royal Academy of Engineering', 'Lightsmith Group'].map((b) => <li key={b}>{b}</li>)}</ul>
          </div>
        </div>
      </section>

      <section className="section" id="how">
        <div className="container">
          <h2 className="center">{c.t('home.how_h')}</h2>
          <HowSteps />
          <p className="center"><a className="btn btn-primary" href="/signup">{c.t('home.cta_primary')}</a></p>
        </div>
      </section>

      <section className="section alt">
        <div className="container">
          <h2 className="center">{c.t('home.promise_h')}</h2>
          <div className="grid-3">
            {[[LuFileCheck, 1], [LuWheat, 2], [LuShieldCheck, 3]].map(([I, i]: any) => (
              <div key={i} className="card promise"><I aria-hidden className="promise-icon" /><h3>{c.t(`promise.${i}_t`)}</h3><p>{c.t(`promise.${i}_d`)}</p></div>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container two-col">
          <div>
            <h2>{c.t('home.trail_h')}</h2>
            <p className="big">{c.t('home.trail_p')}</p>
          </div>
          <ol className="trail-strip">
            {[[LuBanknote, 'funded'], [LuSprout, 'sourcing'], [LuWarehouse, 'warehoused'], [LuTruck, 'delivered'], [LuHandshake, 'buyer_paid'], [LuCheck, 'champions_paid']].map(([I, s]: any) => (
              <li key={s}><I aria-hidden /> <span>{c.t(`trail.${s}`)}</span></li>
            ))}
          </ol>
        </div>
      </section>

      <section className="section alt" id="lots">
        <div className="container">
          <div className="section-head"><div><h2>{c.t('home.lots_h')}</h2><p>{c.t('home.lots_p')}</p></div><a href="/lots" className="arrow-link">{c.t('home.lots_all')} <LuArrowRight aria-hidden /></a></div>
          {lots.length ? <div className="grid-3">{lots.slice(0, 3).map((l) => <LotCard key={l.id} lot={l} />)}</div> : <Empty>{c.t('lot.none')}</Empty>}
        </div>
      </section>

      <section className="section"><div className="container"><Calculator rateBps={rateBps} /></div></section>

      <section className="section alt">
        <div className="container">
          <h2 className="center">{c.t('home.stakes_h')}</h2>
          <div className="grid-2 stakes">
            <div className="card stakes-without"><LuTrendingDown aria-hidden /><h3>{c.t('home.stakes_without_t')}</h3><p>{c.t('home.stakes_without_d')}</p></div>
            <div className="card stakes-with"><LuTrendingUp aria-hidden /><h3>{c.t('home.stakes_with_t')}</h3><p>{c.t('home.stakes_with_d')}</p></div>
          </div>
        </div>
      </section>

      {circles && (
        <section className="section">
          <div className="container two-col">
            <div><h2>{c.t('home.circles_h')}</h2><p className="big">{c.t('home.circles_p', { slot: fmtNGN(1000000) })}</p><a className="arrow-link" href="/circles">{c.t('nav.circles')} <LuArrowRight aria-hidden /></a></div>
            <div className="circle-art" aria-hidden><LuUsersRound /></div>
          </div>
        </section>
      )}

      <section className="section reach">
        <div className="container two-col">
          <div><h2>{c.t('home.reach_h')}</h2><p className="big">{c.t('home.reach_p')}</p></div>
          <ul className="countries">{[['🇳🇬', 'NG'], ['🇧🇯', 'BJ'], ['🇷🇼', 'RW']].map(([f, cc]) => <li key={cc}>{f} {countryName(cc, c.lang)}</li>)}</ul>
        </div>
      </section>

      <section className="final-cta">
        <div className="container narrow center">
          <h2>{c.t('home.final_h')}</h2>
          <p className="big">{c.t('home.final_p')}</p>
          <a className="btn btn-gold btn-lg" href="/signup">{c.t('nav.signup')}</a>
          <p className="small">{c.t('home.final_talk', { phone: st.support_phone })}</p>
        </div>
      </section>
    </PublicLayout>
  );
}

export function HowItWorks({ faqs }: { faqs: { q: string; a: string }[] }) {
  const c = useC();
  return (
    <PublicLayout title={c.t('how.title')}>
      <PageHead title={c.t('how.title')} intro={c.t('how.intro')} />
      <section className="section"><div className="container"><HowSteps /></div></section>
      <section className="section alt"><div className="container two-col">
        <div><h2>{c.t('how.money_h')}</h2><p className="big">{c.t('how.money_p')}</p></div>
        <div className="card"><h3>{c.t('trades.trail')}</h3><Trail events={[]} compact /></div>
      </div></section>
      <section className="section"><div className="container"><Calculator /></div></section>
      {faqs.length > 0 && <section className="section alt"><div className="container narrow"><h2>{c.t('faqs.title')}</h2><FaqList faqs={faqs.slice(0, 5)} /><a className="arrow-link" href="/faqs">{c.t('nav.faqs')} <LuArrowRight aria-hidden /></a></div></section>}
    </PublicLayout>
  );
}

export function PageHead({ title, intro }: { title: string; intro?: string }) {
  return <section className="page-head"><div className="container"><h1>{title}</h1>{intro && <p className="lead">{intro}</p>}</div></section>;
}

export function LotsPage({ lots, commodities }: { lots: Lot[]; commodities: { code: string; name: string }[] }) {
  const c = useC();
  const open = lots.filter((l) => l.status === 'open');
  const rest = lots.filter((l) => l.status !== 'open');
  return (
    <PublicLayout title={c.t('lots.title')}>
      <PageHead title={c.t('lots.title')} intro={c.t('lots.intro')} />
      <section className="section"><div className="container">
        {open.length ? <div className="grid-3">{open.map((l) => <LotCard key={l.id} lot={l} />)}</div> : <Empty>{c.t('lot.none')}</Empty>}
        <WaitlistForm commodities={commodities} />
        {rest.length > 0 && <><h2 className="mt">{c.t('lot.status.completed')} · {c.t('lot.status.active')}</h2><div className="grid-3">{rest.map((l) => <LotCard key={l.id} lot={l} />)}</div></>}
      </div></section>
    </PublicLayout>
  );
}

export function WaitlistForm({ commodities, commodity }: { commodities?: { code: string; name: string }[]; commodity?: string }) {
  const c = useC();
  const list = commodities || q.all<{ code: string; name: string }>('SELECT code, name FROM commodities WHERE active=1 ORDER BY sort, name');
  const name = commodity ? list.find((x) => x.code === commodity)?.name : '';
  return (
    <form method="post" action="/waitlist" className="card waitlist" id="waitlist">
      <Csrf />
      <h3>{name ? c.t('lot.waitlist', { commodity: name }) : c.t('lot.waitlist_any')}</h3>
      <div className="inline-form">
        <select name="commodity" defaultValue={commodity || 'any'} aria-label={c.t('prices.commodity')}><option value="any">{c.t('lot.any_commodity')}</option>{list.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}</select>
        {!c.user && <input type="email" name="email" required placeholder={c.t('footer.email_ph')} aria-label={c.t('auth.email')} />}
        <button className="btn btn-green" type="submit">{c.t('lot.waitlist_btn')}</button>
      </div>
    </form>
  );
}

export function LotDetail({ lot, trail, commodities }: { lot: Lot; trail: any[]; commodities: { code: string; name: string }[] }) {
  const c = useC();
  const open = lot.status === 'open';
  return (
    <PublicLayout title={lot.title} description={`${lot.commodity_name} · ${rateRange(c, lot)} · ${periodRange(c, lot)}`}>
      <section className="page-head"><div className="container">
        <p className="eyebrow">{lot.commodity_name} · {lot.code}</p>
        <h1>{lot.title}</h1>
        {lot.description && <p className="lead">{lot.description}</p>}
      </div></section>
      <section className="section"><div className="container two-col top">
        <div>
          <div className="card">
            <div className="lot-top"><Tag tone={open ? 'green' : 'grey'}>{c.t(`lot.status.${lot.status}`)}</Tag>{open && <span className="muted">{c.t('lot.closes', { date: fmtDate(c.lang, lot.closes_at) })}</span>}</div>
            <Progress pct={lotPct(lot)} />
            <p className="lot-fill"><span>{c.t('lot.filled', { pct: lotPct(lot) })}</span>{open && <span>{c.t('lot.left', { amount: fmtNGN(lotRemaining(lot)) })}</span>}</p>
            <p className="lot-meta"><span><LuWheat aria-hidden /> {c.t('lot.tonnage', { t: fmtNum(c.lang, lot.tonnage, 1) })}</span><span><LuUsersRound aria-hidden /> {c.t('lot.farmers', { n: lot.farmers })}</span><span><LuMapPin aria-hidden /> {lot.region}</span></p>
            {open
              ? <a className="btn btn-primary btn-block btn-lg" href={c.user ? `/app/lots/${lot.id}` : `/signup?next=/app/lots/${lot.id}`}>{c.t('lot.join')}</a>
              : <WaitlistForm commodities={commodities} commodity={lot.commodity} />}
          </div>
          <div className="card mt"><h3>{c.t('trades.trail')}</h3><Trail events={trail} /></div>
        </div>
        <LotTerms lot={lot} />
      </div></section>
    </PublicLayout>
  );
}

export function CirclesPage({ circles, visible, mode }: { circles: Circle[]; visible: boolean; mode: string }) {
  const c = useC();
  return (
    <PublicLayout title={c.t('circles.title')}>
      <PageHead title={c.t('circles.title')} intro={c.t('circles.intro')} />
      <section className="section"><div className="container two-col top">
        <ol className="numbered">{[1, 2, 3, 4].map((i) => <li key={i}>{c.t(`circles.how${i}`)}</li>)}</ol>
        <div>
          {!visible && <div className="card"><p className="big">{mode === 'off' ? c.t('circles.off') : c.t('circles.pilot')}</p>{!c.user && <a className="btn btn-primary" href="/signup">{c.t('nav.signup')}</a>}</div>}
          {visible && (circles.length ? circles.map((ci) => <CircleCard key={ci.id} ci={ci} />) : <Empty>{c.t('circles.none')}</Empty>)}
        </div>
      </div></section>
    </PublicLayout>
  );
}

export function CircleCard({ ci, href }: { ci: Circle; href?: string }) {
  const c = useC();
  const pct = Math.round(((ci.taken || 0) / ci.slots) * 100);
  return (
    <article className="card circle-card">
      <div className="lot-top"><strong>{ci.name}</strong><Tag tone={toneFor2(ci.status)}>{c.t(`circles.status.${ci.status}`)}</Tag></div>
      <p className="muted small">{ci.lot_title} · {c.t('lot.rate', { rate: rateFor(ci.period_months || 12) / 100 })} · {c.t('lot.period', { n: ci.period_months || 0 })}</p>
      <Progress pct={pct} />
      <p className="lot-fill"><span>{c.t('circles.slots', { taken: ci.taken || 0, total: ci.slots })}</span><span>{c.t('circles.slot_price', { amount: fmtNGN(ci.slot_price) })}</span></p>
      <p className="muted small">{c.t('circles.deadline', { date: fmtDate(c.lang, ci.deadline) })}</p>
      <a className="btn btn-primary btn-block" href={href || `/app/circles/${ci.id}`}>{c.t('circles.take')}</a>
    </article>
  );
}
const toneFor2 = (s: string) => (s === 'filled' ? 'green' : s === 'filling' ? 'gold' : 'grey') as any;

export function PricesPage({ prices, history }: { prices: PriceRow[]; history: Record<string, number[]> }) {
  const c = useC();
  return (
    <PublicLayout title={c.t('prices.title')}>
      <PageHead title={c.t('prices.title')} intro={c.t('prices.intro')} />
      <section className="section"><div className="container">
        {prices.length === 0 ? <Empty>{c.t('prices.none')}</Empty> : (
          <div className="grid-3">
            {prices.map((p) => (
              <article key={p.commodity} id={p.commodity} className="card price-card">
                <div className="lot-top"><h3>{p.name}</h3>{p.change_pct !== null && <span className={`chg ${p.change_pct > 0 ? 'up' : p.change_pct < 0 ? 'down' : ''}`} dir="ltr">{p.change_pct > 0 ? '▲' : p.change_pct < 0 ? '▼' : '■'} {Math.abs(p.change_pct).toFixed(1)}%</span>}</div>
                <p className="price-big" dir="ltr">{fmtNGN(p.price_per_kg)}<small>{c.t('ticker.per_kg')}</small></p>
                <Sparkline points={history[p.commodity] || []} />
                <p className="muted small">{c.t('prices.source')}: {p.source_name}{p.market ? ` · ${p.market}` : ''} · {fmtDate(c.lang, p.observed_on)}</p>
              </article>
            ))}
          </div>
        )}
      </div></section>
    </PublicLayout>
  );
}

export function WhyPage({ stats }: { stats: Stats }) {
  const c = useC();
  return (
    <PublicLayout title={c.t('why.title')}>
      <PageHead title={c.t('home.guide_h')} intro={c.t('home.guide_p')} />
      <StatsBand s={stats} />
      <section className="section"><div className="container two-col top">
        <div><h2>{c.t('why.title')}</h2><p className="big">{c.t('why.story')}</p>
          <ul className="checks">{[1, 2, 3].map((i) => <li key={i}><LuCheck aria-hidden /> {c.t(`home.guide_${i}`)}</li>)}</ul></div>
        <div className="backers"><p className="eyebrow dark">{c.t('home.backed_by')}</p><ul>{['USAID', 'Acumen', 'Royal Academy of Engineering', 'Lightsmith Group'].map((b) => <li key={b}>{b}</li>)}</ul>
          <p className="eyebrow dark mt">{c.t('home.reach_h')}</p><ul>{['NG', 'BJ', 'RW'].map((cc) => <li key={cc}>{countryName(cc, c.lang)}</li>)}</ul></div>
      </div></section>
    </PublicLayout>
  );
}

export function FaqList({ faqs }: { faqs: { q: string; a: string }[] }) {
  return <div className="faqs">{faqs.map((f, i) => <details key={i} className="faq"><summary>{f.q}</summary><p>{f.a}</p></details>)}</div>;
}
export function FaqsPage({ faqs }: { faqs: { q: string; a: string }[] }) {
  const c = useC();
  return (
    <PublicLayout title={c.t('faqs.title')}>
      <PageHead title={c.t('faqs.title')} />
      <section className="section"><div className="container narrow"><FaqList faqs={faqs} /></div></section>
    </PublicLayout>
  );
}

/** /join — the page social posts and ads point to: a short pitch and a lead form (with consent), or straight to sign-up. */
export function JoinPage({ sent, commodities }: { sent?: boolean; commodities: { code: string; name: string }[] }) {
  const c = useC();
  return (
    <PublicLayout title={c.t('join.title')} description={c.t('join.intro')}>
      <PageHead title={c.t('join.title')} intro={c.t('join.intro')} />
      <section className="section"><div className="container two-col top">
        <div>
          <ul className="check-list big">
            <li>{c.t('join.p1')}</li><li>{c.t('join.p2', { low: rateFor(4) / 100, high: rateFor(12) / 100 })}</li><li>{c.t('join.p3')}</li>
          </ul>
          <p><a className="btn btn-primary btn-lg" href="/signup">{c.t('join.signup')}</a></p>
          <p className="muted small"><a href="/legal/risk">{c.t('footer.risk')}</a> · <a href="/how-it-works">{c.t('nav.how')}</a></p>
        </div>
        <div className="card" id="join-form">
          {sent ? <><p className="big">{c.t('join.thanks')}</p><p><a className="btn btn-primary" href="/signup">{c.t('join.signup')}</a></p></> : (
            <form method="post" action="/join">
              <Csrf />
              <h2 className="h3">{c.t('join.form_title')}</h2>
              <Field label={c.t('contact.name')} name="name" required autoComplete="given-name" />
              <Field label={c.t('contact.email')} name="email" type="email" required autoComplete="email" />
              <Field label={c.t('join.phone')} name="phone" type="tel" autoComplete="tel" />
              <div className="field"><label htmlFor="f-interest">{c.t('join.interest')}</label>
                <select id="f-interest" name="interest"><option value="any">{c.t('lot.any_commodity')}</option>{commodities.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}</select></div>
              <label className="check"><input type="checkbox" name="consent" required /> <span>{c.t('join.consent')}</span></label>
              <input type="text" name="website" className="hp" tabIndex={-1} autoComplete="off" aria-hidden="true" />
              <button className="btn btn-green btn-block" type="submit">{c.t('join.send')}</button>
            </form>
          )}
        </div>
      </div></section>
    </PublicLayout>
  );
}

export function ContactPage({ sent }: { sent?: boolean }) {
  const c = useC();
  const s = settings();
  return (
    <PublicLayout title={c.t('contact.title')}>
      <PageHead title={c.t('contact.title')} intro={c.t('contact.intro')} />
      <section className="section"><div className="container two-col top">
        <div className="card">
          {sent ? <p className="big">{c.t('contact.sent')}</p> : (
            <form method="post" action="/contact">
              <Csrf />
              <Field label={c.t('contact.name')} name="name" required autoComplete="name" value={c.user ? `${c.user.first_name} ${c.user.last_name}` : ''} />
              <Field label={c.t('contact.email')} name="email" type="email" required autoComplete="email" value={c.user?.email} />
              <Field label={c.t('contact.message')} name="message" type="textarea" required maxLength={3000} />
              <input type="text" name="website" className="hp" tabIndex={-1} autoComplete="off" aria-hidden="true" />
              <button className="btn btn-primary" type="submit">{c.t('contact.send')}</button>
            </form>
          )}
        </div>
        <ul className="contact-list">
          <li><LuMessageCircle aria-hidden /> {c.t('contact.chat')}</li>
          <li><LuPhone aria-hidden /> {c.t('contact.call')}: <a href={`tel:${s.support_phone.replace(/\s/g, '')}`} dir="ltr">{s.support_phone}</a></li>
          {s.support_whatsapp && <li><LuSmartphone aria-hidden /> {c.t('contact.whatsapp')}: <a href={`https://wa.me/${s.support_whatsapp.replace(/\D/g, '')}`} dir="ltr">{s.support_whatsapp}</a></li>}
          <li><LuMail aria-hidden /> <a href={`mailto:${s.support_email}`}>{s.support_email}</a></li>
          <li><LuMapPin aria-hidden /> {c.t('footer.address')}</li>
        </ul>
      </div></section>
    </PublicLayout>
  );
}

export function InstallPage() {
  const c = useC();
  return (
    <PublicLayout title={c.t('install.title')}>
      <PageHead title={c.t('install.title')} intro={c.t('install.intro')} />
      <section className="section"><div className="container two-col top">
        <div className="card"><h2>{c.t('install.android_h')}</h2><p>{c.t('install.android_p')}</p>
          <button className="btn btn-primary btn-lg" type="button" data-install hidden>{c.t('install.button')}</button>
          <p className="ok-line" data-installed hidden><LuCheck aria-hidden /> {c.t('install.done')}</p></div>
        <div className="card"><h2>{c.t('install.ios_h')}</h2><ol className="numbered">{[1, 2, 3].map((i) => <li key={i}>{c.t(`install.ios_${i}`)}</li>)}</ol></div>
      </div></section>
    </PublicLayout>
  );
}

export function NewsletterPage({ state }: { state?: 'check' | 'confirmed' | 'unsubscribed' | 'already' }) {
  const c = useC();
  const msg = state === 'check' ? 'nl.check_email' : state === 'confirmed' ? 'nl.confirmed' : state === 'unsubscribed' ? 'nl.unsubscribed' : state === 'already' ? 'nl.already' : null;
  return (
    <PublicLayout title={c.t('nl.title')}>
      <PageHead title={c.t('nl.title')} intro={c.t('nl.intro')} />
      <section className="section"><div className="container narrow">
        <div className="card">
          {msg ? <p className="big">{c.t(msg)}</p> : (
            <form method="post" action="/newsletter">
              <Csrf />
              <Field label={c.t('auth.email')} name="email" type="email" required autoComplete="email" value={c.user?.email} />
              <button className="btn btn-primary" type="submit">{c.t('footer.subscribe')}</button>
            </form>
          )}
          <p className="mt"><a className="arrow-link" href="/chronicles">{c.t('blog.title')} <LuArrowRight aria-hidden /></a></p>
        </div>
      </div></section>
    </PublicLayout>
  );
}

export function CalculatorPage() {
  const c = useC();
  return <PublicLayout title={c.t('calc.h')}><section className="section"><div className="container"><Calculator /></div></section></PublicLayout>;
}

export function LegalPage({ kind, html }: { kind: string; html: string }) {
  const c = useC();
  return (
    <PublicLayout title={c.t(`legal.${kind}`)}>
      <PageHead title={c.t(`legal.${kind}`)} intro={c.lang !== 'en' ? c.t('legal.english') : undefined} />
      <section className="section"><div className="container narrow prose" lang="en" dir="ltr" dangerouslySetInnerHTML={{ __html: html }} /></section>
    </PublicLayout>
  );
}

export function ErrorPage({ status, message }: { status: number; message?: string }) {
  const c = useC();
  return (
    <PublicLayout title={status === 404 ? c.t('err.404_title') : 'Error'} noindex>
      <section className="section"><div className="container narrow center">
        <p className="eyebrow dark">{status}</p>
        <h1>{status === 404 ? c.t('err.404_title') : status === 403 ? c.t('err.forbidden') : c.t('err.generic')}</h1>
        <p className="big">{status === 404 ? c.t('err.404_body') : message}</p>
        <a className="btn btn-primary" href="/">{c.t('err.home')}</a>
      </div></section>
    </PublicLayout>
  );
}

export const _unused = { Money, config };
