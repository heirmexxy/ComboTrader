import type { ReactNode } from 'react';
import { Csrf, Tag, toneFor } from '../components';
import { fmtNGN } from '../../lib/util';

export const N = ({ k }: { k: number | null | undefined }) => <span className="num" dir="ltr">{fmtNGN(Number(k || 0))}</span>;
export const D = ({ v, time }: { v: string | null | undefined; time?: boolean }) => <span className="nowrap">{v ? (time ? v.slice(0, 16).replace('T', ' ') : v.slice(0, 10)) : '—'}</span>;
export const S = ({ s }: { s: string }) => <Tag tone={toneFor(s)}>{s}</Tag>;

export function Box({ title, children, actions, id }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; id?: string }) {
  return <section className="card admin-box" id={id}>{(title || actions) && <div className="box-head">{title && <h2>{title}</h2>}{actions}</div>}{children}</section>;
}
export function Kpis({ items }: { items: [string, ReactNode, string?][] }) {
  return <div className="kpis">{items.map(([l, v, sub], i) => <div className="kpi" key={i}><span className="kpi-label">{l}</span><strong className="kpi-value">{v}</strong>{sub && <span className="muted small">{sub}</span>}</div>)}</div>;
}
export function Table<T>({ rows, cols, empty = 'Nothing here yet.' }: { rows: T[]; cols: [string, (r: T) => ReactNode, string?][]; empty?: string }) {
  if (!rows.length) return <p className="muted">{empty}</p>;
  return (
    <div className="table-wrap"><table className="table">
      <thead><tr>{cols.map(([h, , cls], i) => <th key={i} className={cls}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{cols.map(([, f, cls], j) => <td key={j} className={cls}>{f(r)}</td>)}</tr>)}</tbody>
    </table></div>
  );
}
/** A one-button POST form. */
export function Act({ action, label, tone = 'ghost', confirm, fields }: { action: string; label: string; tone?: 'ghost' | 'primary' | 'green' | 'danger'; confirm?: string; fields?: Record<string, string | number> }) {
  return (
    <form method="post" action={action} className="inline" data-confirm={confirm}>
      <Csrf />
      {fields && Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <button className={`btn btn-${tone} btn-sm`} type="submit">{label}</button>
    </form>
  );
}
export function F({ label, name, value, type = 'text', required, hint, options, step, rows }: {
  label: string; name: string; value?: string | number | null; type?: string; required?: boolean; hint?: string; options?: [string, string][]; step?: string; rows?: number;
}) {
  const id = `a-${name}`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {options ? <select id={id} name={name} defaultValue={value == null ? undefined : String(value)}>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        : type === 'textarea' ? <textarea id={id} name={name} defaultValue={value ?? ''} required={required} rows={rows || 6} />
        : type === 'checkbox' ? <input id={id} type="checkbox" name={name} defaultChecked={!!value} />
        : <input id={id} name={name} type={type} defaultValue={value ?? undefined} required={required} step={step} />}
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}
export function Form({ action, children, submit = 'Save', multipart, className }: { action: string; children: ReactNode; submit?: string; multipart?: boolean; className?: string }) {
  return <form method="post" action={action} encType={multipart ? 'multipart/form-data' : undefined} className={className || 'form-grid'}><Csrf />{children}<div className="form-actions"><button className="btn btn-primary" type="submit">{submit}</button></div></form>;
}
export const naira = (k: number | null | undefined) => (k == null ? '' : (k / 100).toLocaleString('en', { maximumFractionDigits: 2 }));
