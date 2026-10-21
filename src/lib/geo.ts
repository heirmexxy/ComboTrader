import { q } from './db';
import { langMeta, type Lang } from './i18n';

// ISO 3166-1 alpha-2 codes — Champions can join from any country.
export const COUNTRY_CODES = 'AF AX AL DZ AS AD AO AI AQ AG AR AM AW AU AT AZ BS BH BD BB BY BE BZ BJ BM BT BO BQ BA BW BV BR IO BN BG BF BI CV KH CM CA KY CF TD CL CN CX CC CO KM CG CD CK CR CI HR CU CW CY CZ DK DJ DM DO EC EG SV GQ ER EE SZ ET FK FO FJ FI FR GF PF TF GA GM GE DE GH GI GR GL GD GP GU GT GG GN GW GY HT HM VA HN HK HU IS IN ID IR IQ IE IM IL IT JM JP JE JO KZ KE KI KP KR KW KG LA LV LB LS LR LY LI LT LU MO MG MW MY MV ML MT MH MQ MR MU YT MX FM MD MC MN ME MS MA MZ MM NA NR NP NL NC NZ NI NE NG NU NF MK MP NO OM PK PW PS PA PG PY PE PH PN PL PT PR QA RE RO RU RW BL SH KN LC MF PM VC WS SM ST SA SN RS SC SL SG SX SK SI SB SO ZA GS SS ES LK SD SR SJ SE CH SY TW TJ TZ TH TL TG TK TO TT TN TR TM TC TV UG UA AE GB US UM UY UZ VU VE VN VG VI WF EH YE ZM ZW'.split(' ');

export function countryName(code: string, lang: Lang) {
  try { return new Intl.DisplayNames([langMeta(lang).intl.split('-u-')[0]], { type: 'region' }).of(code) || code; } catch { return code; }
}
export function countryOptions(lang: Lang) {
  return COUNTRY_CODES.map((c) => ({ code: c, name: countryName(c, lang) })).sort((a, b) => a.name.localeCompare(b.name));
}

const EUR = 'AT BE CY DE EE ES FI FR GR HR IE IT LT LU LV MT NL PT SI SK'.split(' ');
const XOF = 'BJ BF CI GW ML NE SN TG'.split(' ');
const XAF = 'CM CF TD CG GQ GA'.split(' ');
const MAP: Record<string, string> = { US: 'USD', GB: 'GBP', CA: 'CAD', AU: 'AUD', RW: 'RWF', KE: 'KES', GH: 'GHS', ZA: 'ZAR', AE: 'AED', SA: 'SAR', EG: 'EGP', BR: 'BRL', MZ: 'MZN', AO: 'AOA', TZ: 'TZS', UG: 'UGX', MA: 'MAD', CH: 'CHF', CN: 'CNY', IN: 'INR', QA: 'QAR' };
export function currencyFor(country: string) {
  if (country === 'NG') return 'NGN';
  if (EUR.includes(country)) return 'EUR';
  if (XOF.includes(country)) return 'XOF';
  if (XAF.includes(country)) return 'XAF';
  return MAP[country] || 'USD';
}
/** Approximate local-currency figure for Champions outside Nigeria (rates set in Admin → Settings). */
export function approx(kobo: number, country: string, lang: Lang) {
  const cur = currencyFor(country);
  if (cur === 'NGN') return null;
  const r = q.get<{ per_ngn: number }>('SELECT per_ngn FROM fx_rates WHERE currency=?', cur);
  if (!r) return null;
  const v = (kobo / 100) * r.per_ngn;
  try { return new Intl.NumberFormat(langMeta(lang).intl, { style: 'currency', currency: cur, maximumFractionDigits: v < 100 ? 2 : 0 }).format(v); } catch { return `${cur} ${v.toFixed(2)}`; }
}
