// ComboTrader brand: one place for colours, fonts, logo and voice, used by the website, the post
// images the Social agent draws, and the writing agents (Social, Email, Newsletter).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BRAND = {
  green: '#1F4D2B', green2: '#2E6B3D', gold: '#D4A017', goldLight: '#F6E7B5', cream: '#F7F1E3', paper: '#FFFDF8', terra: '#C0603A', ink: '#1E1E1A',
  headingFont: 'Fraunces SemiBold', bodyFont: 'Inter',
  tagline: 'Put your money where Nigeria’s food moves.',
  site: 'www.combotrader.com.ng',
  kit: '/brand/',
};

/** The logo mark (gold "C" with a leaf growing out of it) for a viewBox of -100 -100 200 200. Draw on green. */
export const MARK_SVG = `<path d="M48.6,-50.4 A70,70 0 1 0 48.6,50.4" fill="none" stroke="#D4A017" stroke-width="22" stroke-linecap="round"/><path d="M-20.0,40.0 C-14.4,-9.0 42.9,-40.1 78.0,-42.0 Q30.3,0.6 -20.0,40.0Z" fill="#E9C65A"/><path d="M-20.0,40.0 C29.3,43.1 70.0,-7.8 78.0,-42.0 Q30.3,0.6 -20.0,40.0Z" fill="#F6E7B5"/><path d="M-14.1,35.1 Q30.3,0.6 64.7,-30.0" fill="none" stroke="#1F4D2B" stroke-width="4" stroke-linecap="round"/>`;
/** The mark on its green disc, viewBox -110 -110 220 220: for light backgrounds. */
export const MARK_DISC_SVG = `<circle r="104" fill="${BRAND.green}"/>${MARK_SVG}`;

/** Brand guidance added to every agent that writes public content. */
export const BRAND_VOICE = `Brand: ComboTrader by Kitovu. Tagline: "${BRAND.tagline}" Voice: warm, plain and concrete, like a trusted Nigerian business explaining real trade; confident, never hype; short sentences; name the commodity, the region, the farmers and the buyer when the facts give them. Use "Harvest Champion", "Trade Lot", "Harvest Trail", "earnings". Colours (if you describe visuals): deep green ${BRAND.green}, gold ${BRAND.gold}, cream ${BRAND.cream}. Write the name as "ComboTrader" (one word, capital C and T).`;

let fontsReady = false;
/** Points the image library at the brand fonts in assets/fonts (call before drawing text with sharp). */
export function useBrandFonts() {
  if (fontsReady) return;
  fontsReady = true;
  const dir = path.resolve('assets/fonts');
  if (!fs.existsSync(dir)) return;
  const conf = path.join(os.tmpdir(), 'combotrader-fonts.conf');
  // Keep the font cache in the data folder so it survives restarts (building it is slow on a small server).
  let cacheDir = path.resolve('data/.fontcache');
  try { fs.mkdirSync(cacheDir, { recursive: true }); fs.accessSync(cacheDir, fs.constants.W_OK); } catch { cacheDir = path.join(os.tmpdir(), 'combotrader-fontcache'); }
  try {
    fs.writeFileSync(conf, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>${dir}</dir><include ignore_missing="yes">/etc/fonts/fonts.conf</include><cachedir>${cacheDir}</cachedir></fontconfig>`);
    process.env.FONTCONFIG_FILE = conf;
  } catch { /* fall back to system fonts */ }
}
