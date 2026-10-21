import type { ReactNode } from 'react';
import { useC } from './render';
import { fmtNGN, earningsFor } from '../lib/util';
import { fmtDate, fmtNum } from '../lib/i18n';
import { approx } from '../lib/geo';
import { lotPct, lotRemaining, STAGES, type Lot } from '../lib/trading';
import { LuCheck, LuMapPin, LuUsers, LuWheat, LuClock, LuFileCheck } from 'react-icons/lu';

export function Logo({ light = true }: { light?: boolean }) {
  return (
    <span className="logo" aria-label="ComboTrader">
      <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true">
        <circle cx="16" cy="16" r="15" fill="#D4A017" />
        <path d="M16 25V11M16 15c-3.5 0-6-2.2-6-5.5 3.5 0 6 2.2 6 5.5zm0 4c3.5 0 6-2.2 6-5.5-3.5 0-6 2.2-6 5.5zm0 4c-3 0-5.2-1.9-5.2-4.8 3 0 5.2 1.9 5.2 4.8z" fill="none" stroke="#1F4D2B" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className={light ? 'logo-word light' : 'logo-word'}>COMBO<b>TRADER</b></span>
    </span>
  );
}

export const Csrf = () => <input type="hidden" name="_csrf" value={useC().csrf} />;

export function Money({ kobo, approxFor }: { kobo: number; approxFor?: boolean }) {
  const c = useC();
  const a = approxFor && c.user ? approx(kobo, c.user.country, c.lang) : null;
  return <span className="money" dir="ltr">{fmtNGN(kobo)}{a && <small className="approx"> {c.t('wallet.approx', { amount: a })}</small>}</span>;
}

export function Flash() {
  const c = useC();
  if (!c.flash) return null;
  return <div className={`flash flash-${c.flash.type}`} role={c.flash.type === 'error' ? 'alert' : 'status'}>{c.flash.msg}</div>;
}

export function Field({ label, name, type = 'text', value, required, hint, autoComplete, placeholder, min, max, step, inputMode, pattern, maxLength, dir }: {
  label: string; name: string; type?: string; value?: string | number | null; required?: boolean; hint?: string; autoComplete?: string;
  placeholder?: string; min?: number | string; max?: number | string; step?: number | string; inputMode?: 'numeric' | 'decimal' | 'email' | 'tel' | 'text'; pattern?: string; maxLength?: number; dir?: 'ltr' | 'rtl';
}) {
  const id = `f-${name}`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}{required ? null : null}</label>
      {type === 'textarea'
        ? <textarea id={id} name={name} required={required} defaultValue={value ?? ''} placeholder={placeholder} rows={5} maxLength={maxLength} />
        : <input id={id} name={name} type={type} required={required} defaultValue={value ?? undefined} autoComplete={autoComplete} placeholder={placeholder}
            min={min} max={max} step={step} inputMode={inputMode} pattern={pattern} maxLength={maxLength} dir={dir} aria-describedby={hint ? `${id}-h` : undefined} />}
      {hint && <p className="hint" id={`${id}-h`}>{hint}</p>}
    </div>
  );
}
export function Select({ label, name, options, value, required }: { label: string; name: string; options: { value: string; label: string }[]; value?: string | null; required?: boolean }) {
  return (
    <div className="field">
      <label htmlFor={`f-${name}`}>{label}</label>
      <select id={`f-${name}`} name={name} defaultValue={value ?? undefined} required={required}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}
export function Check({ name, label, checked, required }: { name: string; label: ReactNode; checked?: boolean; required?: boolean }) {
  return <label className="check"><input type="checkbox" name={name} defaultChecked={checked} required={required} /> <span>{label}</span></label>;
}

export function Tag({ tone = 'grey', children }: { tone?: 'green' | 'gold' | 'red' | 'grey' | 'terra'; children: ReactNode }) {
  return <span className={`tag tag-${tone}`}>{children}</span>;
}
export const toneFor = (status: string) =>
  (({ open: 'green', paid: 'green', success: 'green', verified: 'green', published: 'green', filled: 'gold', active: 'gold', matured: 'terra', requested: 'gold', approved: 'gold', processing: 'gold', filling: 'gold', pending: 'gold', held: 'terra', manual: 'terra', failed: 'red', rejected: 'red', cancelled: 'red', expired: 'grey', completed: 'green', draft: 'grey', scheduled: 'gold', confirmed: 'green' } as Record<string, any>)[status] || 'grey');

export function Progress({ pct, label }: { pct: number; label?: string }) {
  return <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}><span style={{ width: `${pct}%` }} /></div>;
}

export function LotCard({ lot, href }: { lot: Lot; href?: string }) {
  const c = useC();
  const pct = lotPct(lot);
  const open = lot.status === 'open';
  return (
    <article className="card lot-card">
      <div className="lot-top">
        <span className="lot-commodity"><LuWheat aria-hidden /> {lot.commodity_name}</span>
        <Tag tone={toneFor(lot.status)}>{c.t(`lot.status.${lot.status}`)}</Tag>
      </div>
      <h3><a href={href || `/lots/${lot.code}`}>{lot.title}</a></h3>
      <dl className="lot-terms">
        <div><dt>{c.t('lot.term_rate')}</dt><dd>{c.t('lot.rate', { rate: lot.rate_bps / 100 })}</dd></div>
        <div><dt>{c.t('lot.term_period')}</dt><dd>{c.t('lot.period', { n: lot.period_months })}</dd></div>
        <div><dt>{c.t('lot.term_min')}</dt><dd><Money kobo={lot.min_commit} /></dd></div>
      </dl>
      <p className="lot-meta"><span><LuUsers aria-hidden /> {lot.buyer_type}</span><span><LuMapPin aria-hidden /> {lot.region}</span></p>
      <Progress pct={pct} label={c.t('lot.filled', { pct })} />
      <p className="lot-fill"><span>{c.t('lot.filled', { pct })}</span>{open && <span>{c.t('lot.left', { amount: fmtNGN(lotRemaining(lot)) })}</span>}</p>
      {open && <p className="lot-close"><LuClock aria-hidden /> {c.t('lot.closes', { date: fmtDate(c.lang, lot.closes_at) })}</p>}
      <a className={`btn ${open ? 'btn-primary' : 'btn-ghost'} btn-block`} href={href || `/lots/${lot.code}`}>{open ? c.t('lot.join') : c.t('lot.view')}</a>
    </article>
  );
}

export function LotTerms({ lot }: { lot: Lot }) {
  const c = useC();
  const ex = Math.max(lot.min_commit, 100000000);
  return (
    <div className="card">
      <h3>{c.t('lot.terms')}</h3>
      <dl className="kv">
        <dt>{c.t('lot.term_rate')}</dt><dd>{c.t('lot.rate', { rate: lot.rate_bps / 100 })}</dd>
        <dt>{c.t('lot.term_period')}</dt><dd>{c.t('lot.period', { n: lot.period_months })}</dd>
        <dt>{c.t('lot.term_min')}</dt><dd><Money kobo={lot.min_commit} /></dd>
        <dt>{c.t('lot.size')}</dt><dd><Money kobo={lot.target_amount} /> · {c.t('lot.tonnage', { t: fmtNum(c.lang, lot.tonnage, 1) })}</dd>
        <dt>{c.t('lot.buyer')}</dt><dd>{lot.buyer_type}</dd>
        <dt>{c.t('lot.region')}</dt><dd>{lot.region || '—'}</dd>
        <dt>{c.t('lot.term_payout')}</dt><dd>{c.t('lot.term_payout_v')}</dd>
      </dl>
      {lot.contract_ref && <p className="ok-line"><LuFileCheck aria-hidden /> {c.t('lot.contract')}</p>}
      <p className="muted small">{c.t('lot.earn_on', { earn: fmtNGN(earningsFor(ex, lot.rate_bps, lot.period_months)), amount: fmtNGN(ex) })}</p>
    </div>
  );
}

export function Trail({ events, compact }: { events: { stage: string; happened_at: string; note: string | null; photo_path: string | null }[]; compact?: boolean }) {
  const c = useC();
  const reached = new Set(events.map((e) => e.stage));
  return (
    <ol className={`trail ${compact ? 'compact' : ''}`}>
      {STAGES.map((s) => {
        const ev = events.filter((e) => e.stage === s);
        const done = reached.has(s);
        return (
          <li key={s} className={done ? 'done' : ''}>
            <span className="dot" aria-hidden>{done ? <LuCheck /> : null}</span>
            <div>
              <strong>{c.t(`trail.${s}`)}</strong>
              {ev.map((e, i) => (
                <div key={i} className="trail-ev">
                  <span className="muted small">{fmtDate(c.lang, e.happened_at)}</span>
                  {e.note && <p>{e.note}</p>}
                  {e.photo_path && <a href={`/uploads/${e.photo_path}`}><img src={`/uploads/${e.photo_path}`} alt={c.t(`trail.${s}`)} loading="lazy" /></a>}
                </div>
              ))}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function Sparkline({ points, w = 240, h = 56 }: { points: number[]; w?: number; h?: number }) {
  if (points.length < 2) return null;
  const min = Math.min(...points), max = Math.max(...points), span = max - min || 1;
  const xy = points.map((p, i) => `${(i / (points.length - 1)) * (w - 4) + 2},${h - 2 - ((p - min) / span) * (h - 4)}`);
  const up = points[points.length - 1] >= points[0];
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label="Price trend">
      <polyline points={xy.join(' ')} fill="none" stroke={up ? '#2E7D32' : '#C0603A'} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Pager({ page, more, base }: { page: number; more: boolean; base: string }) {
  const sep = base.includes('?') ? '&' : '?';
  return (
    <nav className="pager">
      {page > 1 && <a className="btn btn-ghost btn-sm" href={`${base}${sep}page=${page - 1}`}>←</a>}
      <span className="muted">{page}</span>
      {more && <a className="btn btn-ghost btn-sm" href={`${base}${sep}page=${page + 1}`}>→</a>}
    </nav>
  );
}
