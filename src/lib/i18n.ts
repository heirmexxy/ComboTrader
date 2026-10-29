import en from '../locales/en';
import fr from '../locales/fr';
import sw from '../locales/sw';
import pt from '../locales/pt';
import ar from '../locales/ar';
import xen from '../locales/extra-en';
import xfr from '../locales/extra-fr';
import xsw from '../locales/extra-sw';
import xpt from '../locales/extra-pt';
import xar from '../locales/extra-ar';
Object.assign(en, xen); Object.assign(fr, xfr); Object.assign(sw, xsw); Object.assign(pt, xpt); Object.assign(ar, xar);

export type Lang = 'en' | 'fr' | 'sw' | 'pt' | 'ar';
export const LANGS: { code: Lang; label: string; dir: 'ltr' | 'rtl'; intl: string }[] = [
  { code: 'en', label: 'English', dir: 'ltr', intl: 'en-NG' },
  { code: 'fr', label: 'Français', dir: 'ltr', intl: 'fr-FR' },
  { code: 'sw', label: 'Kiswahili', dir: 'ltr', intl: 'sw-KE' },
  { code: 'pt', label: 'Português', dir: 'ltr', intl: 'pt-PT' },
  { code: 'ar', label: 'العربية', dir: 'rtl', intl: 'ar-EG-u-nu-latn' },
];
const dicts: Record<Lang, Record<string, string>> = { en, fr, sw, pt, ar };
export const isLang = (s: unknown): s is Lang => typeof s === 'string' && s in dicts;
export const langMeta = (l: Lang) => LANGS.find((x) => x.code === l)!;

// Admin-edited overrides (Admin → FAQs & page text) take priority over the files.
let overrides: Map<string, string> | null = null;
let loadOverrides: (() => { key: string; lang: string; value: string }[]) | null = null;
export function setOverrideLoader(fn: () => { key: string; lang: string; value: string }[]) { loadOverrides = fn; overrides = null; }
export function clearOverrides() { overrides = null; }

export function translate(lang: Lang, key: string, vars?: Record<string, string | number>) {
  if (!overrides && loadOverrides) { overrides = new Map(); try { for (const r of loadOverrides()) overrides.set(`${r.lang}:${r.key}`, r.value); } catch { overrides = null; } }
  let s = overrides?.get(`${lang}:${key}`) ?? dicts[lang]?.[key] ?? (en as Record<string, string>)[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
  return s;
}

export function detectLang(acceptLanguage: string | undefined): Lang {
  for (const part of String(acceptLanguage || '').split(',')) {
    const code = part.trim().slice(0, 2).toLowerCase();
    if (isLang(code)) return code;
  }
  return 'en';
}

export function fmtDate(lang: Lang, iso: string | null | undefined, o: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }) {
  if (!iso) return '—';
  try { return new Intl.DateTimeFormat(langMeta(lang).intl, { timeZone: 'Africa/Lagos', ...o }).format(new Date(iso)); } catch { return iso.slice(0, 10); }
}
export function fmtNum(lang: Lang, n: number, digits = 0) {
  return new Intl.NumberFormat(langMeta(lang).intl, { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(n);
}
export function missingKeys(lang: Lang) {
  return Object.keys(en).filter((k) => !(k in dicts[lang]));
}
export const allKeys = () => Object.keys(en);
export const fileValue = (lang: Lang, key: string) => dicts[lang]?.[key] ?? '';
