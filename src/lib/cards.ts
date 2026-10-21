// Shareable Harvest Card (PNG) and the PDF trade certificate.
import sharp from 'sharp';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { config } from './config';
import { fmtNGN, earningsFor } from './util';
import { translate, type Lang } from './i18n';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export async function harvestCardPng(o: { firstName: string; tons: number; commodity: string; farmers: number; code: string; refCode: string; lang: Lang }) {
  const t = (k: string, v?: any) => esc(translate(o.lang, k, v));
  const rtl = o.lang === 'ar';
  const anchor = rtl ? 'end' : 'start';
  const x = rtl ? 1000 : 80;
  const tons = o.tons >= 10 ? Math.round(o.tons) : Math.round(o.tons * 10) / 10;
  const host = config.baseUrl.replace(/^https?:\/\//, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">
  <rect width="1080" height="1080" fill="#1F4D2B"/>
  <circle cx="900" cy="180" r="260" fill="#2E6B3D"/>
  <circle cx="160" cy="960" r="220" fill="#24573A"/>
  <g font-family="Arial, Helvetica, sans-serif" text-anchor="${anchor}" direction="${rtl ? 'rtl' : 'ltr'}">
    <text x="${x}" y="140" font-size="44" font-weight="700" fill="#FFFFFF">COMBO<tspan fill="#D4A017">TRADER</tspan></text>
    <text x="${x}" y="330" font-size="40" fill="#D4A017" font-weight="700">${esc(o.firstName.toUpperCase())}</text>
    <text x="${x}" y="420" font-size="76" font-weight="700" fill="#FFFFFF">${t('card.champion')}</text>
    <text x="${x}" y="560" font-size="150" font-weight="700" fill="#D4A017">${tons} t</text>
    <text x="${x}" y="630" font-size="44" fill="#F7F1E3">${esc(o.commodity)}</text>
    <text x="${x}" y="740" font-size="44" fill="#F7F1E3">${t('lot.farmers', { n: o.farmers })}</text>
    <rect x="${rtl ? 1000 - 640 : 80}" y="850" width="640" height="96" rx="48" fill="#C0603A"/>
    <text x="${rtl ? 680 : 400}" y="912" font-size="38" font-weight="700" fill="#FFFFFF" text-anchor="middle">${esc(host)}/r/${esc(o.refCode)}</text>
    <text x="${x}" y="1030" font-size="26" fill="#9FB8A5">${esc(o.code)}</text>
  </g>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export async function certificatePdf(o: {
  certificateNo: string; name: string; email: string; lotTitle: string; lotCode: string; commodity: string; amount: number; rateBps: number;
  months: number; startAt: string; maturesAt: string; buyerType: string; status: string;
}) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const green = rgb(0.12, 0.3, 0.17), gold = rgb(0.83, 0.63, 0.09), ink = rgb(0.17, 0.17, 0.17), grey = rgb(0.45, 0.45, 0.45);
  // NB: Standard PDF fonts can't draw ₦, so amounts use "NGN".
  const ngn = (k: number) => 'NGN ' + fmtNGN(k).replace('₦', '');
  page.drawRectangle({ x: 0, y: 762, width: 595, height: 80, color: green });
  page.drawText('COMBO', { x: 40, y: 792, size: 24, font: bold, color: rgb(1, 1, 1) });
  page.drawText('TRADER', { x: 40 + bold.widthOfTextAtSize('COMBO', 24), y: 792, size: 24, font: bold, color: gold });
  page.drawText('Trade Certificate', { x: 40, y: 712, size: 26, font: bold, color: green });
  page.drawText(`Certificate no. ${o.certificateNo}`, { x: 40, y: 688, size: 11, font: reg, color: grey });
  const earn = earningsFor(o.amount, o.rateBps, o.months);
  const rows: [string, string][] = [
    ['Harvest Champion', `${o.name} (${o.email})`], ['Trade Lot', `${o.lotTitle} (${o.lotCode})`], ['Commodity', o.commodity],
    ['Buyer', o.buyerType], ['Amount committed', ngn(o.amount)], ['Rate', `${o.rateBps / 100}% per annum`], ['Period', `${o.months} months`],
    ['Expected earnings', ngn(earn)], ['Expected total payout', ngn(o.amount + earn)], ['Start date', o.startAt.slice(0, 10)],
    ['Payout date', o.maturesAt.slice(0, 10)], ['Status', o.status],
  ];
  let y = 640;
  for (const [k, v] of rows) {
    page.drawText(k, { x: 40, y, size: 11, font: reg, color: grey });
    page.drawText(v.slice(0, 70), { x: 210, y, size: 12, font: bold, color: ink });
    page.drawLine({ start: { x: 40, y: y - 10 }, end: { x: 555, y: y - 10 }, thickness: 0.5, color: rgb(0.9, 0.86, 0.78) });
    y -= 30;
  }
  const note = [
    'Principal and earnings are credited to your ComboTrader wallet on the payout date. Commodity trades carry risk;',
    'see the Risk statement at ' + config.baseUrl + '/legal/risk. This certificate is issued by Kitovu Technology',
    'Company Limited (RC 1348965), Kitovu Business Hub, Iseyin-Saki Expressway, Iseyin, Oyo State, Nigeria.',
  ];
  note.forEach((ln, i) => page.drawText(ln, { x: 40, y: 230 - i * 14, size: 9, font: reg, color: grey }));
  page.drawText(`Verify: ${config.baseUrl}/verify/${o.certificateNo}`, { x: 40, y: 170, size: 10, font: bold, color: green });
  page.drawText(`Issued ${new Date().toISOString().slice(0, 10)}`, { x: 40, y: 150, size: 9, font: reg, color: grey });
  return Buffer.from(await doc.save());
}
