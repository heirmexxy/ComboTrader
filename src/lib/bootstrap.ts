// Reference data every installation needs (runs at start-up; never overwrites admin edits).
import { q, now } from './db';
import { FAQS } from '../content/faqs';

const COMMODITIES: [string, string][] = [
  ['maize', 'Maize'], ['rice', 'Rice'], ['paddy_rice', 'Paddy rice'], ['soybean', 'Soybean'], ['sesame', 'Sesame'],
  ['sorghum', 'Sorghum'], ['millet', 'Millet'], ['cashew', 'Cashew'], ['cocoa', 'Cocoa'],
];

export function bootstrap() {
  if (!q.val('SELECT COUNT(*) FROM commodities')) {
    COMMODITIES.forEach(([code, name], i) => q.insert('commodities', { code, name, bag_kg: 100, active: 1, sort: i }));
  }
  if (!q.val('SELECT COUNT(*) FROM price_sources')) {
    q.insert('price_sources', {
      name: 'commodity.ng', kind: 'table', url: 'https://commodity.ng/live-prices/', enabled: 1,
      config: JSON.stringify({ label_col: 0, price_col: 1, unit_kg: 50, market: 'Nigeria (national average)',
        aliases: { Rice: 'rice', Maize: 'maize', 'Soya Beans': 'soybean', Millet: 'millet', Sorghum: 'sorghum' } }),
    });
    q.insert('price_sources', {
      name: 'NCX', kind: 'pattern_all', url: 'https://ncx.com.ng/', enabled: 1,
      config: JSON.stringify({
        note: 'NCX prices are per kg (confirmed by Kitovu).',
        regex: '(?<name>Cocoa|Maize White|Maize Yellow|Millet Gero|Paddy|Sesame|Sorghum|Soya)\\s*\\((?<code>[A-Z]{5,7})\\)\\s*₦\\s*(?<price>[\\d,]+(?:\\.\\d+)?)',
        unit_kg: 1,
        aliases: { Cocoa: 'cocoa', 'Maize White': 'maize', 'Maize Yellow': 'maize', 'Millet Gero': 'millet', Paddy: 'paddy_rice', Sesame: 'sesame', Sorghum: 'sorghum', Soya: 'soybean' },
        markets: { KAN: 'Kano', KAD: 'Kaduna', PLT: 'Plateau', SKT: 'Sokoto', JIG: 'Jigawa', EBO: 'Ebonyi', TRB: 'Taraba', NAS: 'Nasarawa', YBE: 'Yobe', OND: 'Ondo' },
      }),
    });
    q.insert('price_sources', {
      name: 'AFEX (Africa Exchange)', kind: 'json', url: 'https://africaexchange.com/markets', enabled: 0,
      config: JSON.stringify({ note: 'AFEX loads prices with JavaScript, so the page has none to read. Needs an AFEX data feed or API URL (JSON) — set it here with path/fields, then enable.', path: 'data', fields: { commodity: 'name', price: 'closing_price' }, unit_kg: 1, aliases: {} }),
    });
  }
  if (!q.val('SELECT COUNT(*) FROM fx_rates')) {
    // Placeholder rates — update in Admin → Settings before relying on them.
    for (const [cur, ngnPerUnit] of [['USD', 1450], ['GBP', 1900], ['EUR', 1650], ['XOF', 2.5], ['RWF', 1.0], ['KES', 11.2], ['GHS', 120], ['ZAR', 80]] as [string, number][]) {
      q.insert('fx_rates', { currency: cur, per_ngn: 1 / ngnPerUnit, updated_at: now() });
    }
  }
  if (!q.val('SELECT COUNT(*) FROM faqs')) {
    for (const [lang, items] of Object.entries(FAQS)) items.forEach(([qq, a], i) => q.insert('faqs', { lang, q: qq, a, sort: i }));
  }
}
