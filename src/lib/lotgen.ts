// Auto-generated lot title, code and public description, from the commodity, region and buyer.
import { q } from './db';

const KNOWN: Record<string, string> = { soybean: 'SB', sesame: 'SS', maize: 'MZ', paddy_rice: 'PR', rice: 'RC', sorghum: 'SG', millet: 'ML', cashew: 'CS', cocoa: 'CC', ginger: 'GN', cassava: 'CV', groundnut: 'GD', cowpea: 'CP', shea_nut: 'SN' };
/** Two-letter prefix for a commodity code: known ones are fixed, others use initials or the first letter + first consonant. */
export function lotPrefix(commodity: string) {
  if (KNOWN[commodity]) return KNOWN[commodity];
  const words = commodity.split(/[_\s-]+/).filter(Boolean);
  if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
  const w = commodity.replace(/[^a-z]/gi, '');
  const second = w.slice(1).match(/[bcdfghjklmnpqrstvwxyz]/i)?.[0] || w[1] || 'X';
  return (w[0] + second).toUpperCase();
}
export const lotPrefixes = () => Object.fromEntries(q.all<{ code: string }>('SELECT code FROM commodities').map((c) => [c.code, lotPrefix(c.code)]));

/** e.g. SB-2611 (year and month the lot closes); adds -2, -3… if taken. */
export function nextLotCode(commodity: string, closesAt: string, exceptId?: number) {
  const d = new Date(closesAt);
  const base = `${lotPrefix(commodity)}-${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const taken = (code: string) => !!q.get('SELECT 1 FROM lots WHERE code=? AND id IS NOT ?', code, exceptId ?? null);
  if (!taken(base)) return base;
  for (let i = 2; i < 100; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now().toString(36).slice(-3).toUpperCase()}`;
}

/** "a rice miller, Lagos" / "an animal feed mill, Kaduna" — keeps acronyms and proper nouns. */
export function withArticle(buyer: string) {
  const b = buyer.trim();
  if (!b) return '';
  const lower = /^[A-Z][a-z]/.test(b) ? b[0].toLowerCase() + b.slice(1) : b;
  const an = /^[A-Z]{2}/.test(b) ? /^[AEFHILMNORSX]/.test(b) : /^[aeiou]/i.test(lower); // acronyms go by letter sound: an NNPC depot
  return `${an ? 'an' : 'a'} ${lower}`;
}
export function lotTitle(commodityName: string, region: string, buyerType: string) {
  if (region.trim()) return `${commodityName} from ${region.trim()}`;
  return buyerType.trim() ? `${commodityName} for ${withArticle(buyerType)}` : commodityName;
}
export function lotDescription(o: { commodityName: string; region: string; buyerType: string; tonnage: number; farmers: number }) {
  const from = o.farmers > 0 ? `${o.farmers.toLocaleString('en')} farmers` : 'farmers';
  const where = o.region.trim() ? ` in ${o.region.trim()}` : '';
  const buyer = o.buyerType.trim() ? ` from ${withArticle(o.buyerType)}` : '';
  const tons = o.tonnage > 0 ? ` ${o.tonnage.toLocaleString('en')} tons.` : '';
  return `${o.commodityName} bought from ${from}${where} to fill a signed order${buyer}.${tons}`;
}
