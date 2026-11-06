// ComboTrader marketing & sales playbook: the briefing pack in a form the agents read.
// Source document: "ComboTrader Marketing & Sales Briefing Pack" (Claude Docs). Change the doc first, then this file.
// Used by: Social, Email, Prospector, Growth, Support (AI prompts) and their rules-mode templates, the content
// library scheduler and the off-message check.

export const PLAYBOOK_DOC = 'https://claude.ai/artifact/Xm3Z6Dfr7GFYXY2PkyFcSc';

export const PROMISE = 'You can see exactly where your money goes.';

export const SEGMENTS = [
  { key: 'professionals', name: 'Urban professionals', who: 'Salaried 25–45s in banking, oil and gas, telecoms, tech, health and public service', want: 'Money that keeps up with prices, tied to something real', fear: 'Farmcrowdy and others collapsed', message: 'Every lot has a signed buyer, a named commodity and region, and a Harvest Trail you can follow', channels: 'LinkedIn, Instagram, X, email, WhatsApp', phase: 1 },
  { key: 'cooperatives', name: 'Staff and professional cooperatives', who: 'Company staff co-ops, thrift and credit societies, professional bodies’ welfare schemes', want: 'A transparent use for pooled funds, with reporting to members', fear: 'Our committee must approve and see the paperwork', message: 'Harvest Circles: one lot for the group, statements for the committee, one contact', channels: 'Direct outreach, LinkedIn, in-person sessions', phase: 1 },
  { key: 'community', name: 'Faith, alumni and community groups', who: 'Church and mosque welfare arms, alumni associations, town unions, esusu and ajo groups', want: 'Grow group savings and support farmers', fear: 'Trust in who runs it', message: 'Kitovu has worked with farmers since 2018; visit or call the team', channels: 'WhatsApp, Facebook groups (our own posts), in-person talks', phase: 2 },
  { key: 'diaspora', name: 'Diaspora Nigerians', who: 'UK, US, Canada, Ireland, UAE; professionals sending money home', want: 'A real stake in home, run transparently', fear: 'Distance, FX and verification', message: 'Same lots, same Trail, naira wallet; see the farmers and the buyer before you commit', channels: 'LinkedIn, Facebook, diaspora associations, YouTube', phase: 3 },
  { key: 'network', name: 'Kitovu’s own network', who: 'Agristore dealers, eProcure buyers, partners and past customers', want: 'A product from a company they already know', fear: 'How is this different from earlier agri platforms?', message: 'Trade finance against signed orders, not farm funding; regulated payments; published payout dates', channels: 'Email, WhatsApp, partner briefings', phase: 1 },
] as const;

export const LOCATIONS = [
  { phase: 1, places: ['Lagos (Victoria Island, Lekki, Ikoyi, Ikeja, Yaba)', 'Abuja (Wuse, Maitama, Garki, Gwarinpa, Jabi)', 'Ibadan and Oyo State (Iseyin, Oyo, Ogbomoso)'] },
  { phase: 2, places: ['Port Harcourt', 'Enugu', 'Benin City', 'Abeokuta', 'Ilorin'] },
  { phase: 3, places: ['London', 'Manchester', 'Birmingham', 'Houston', 'Atlanta', 'Washington DC area', 'Toronto', 'Calgary', 'Dublin', 'Dubai'] },
  { phase: 4, places: ['Kano', 'Kaduna', 'Jos', 'Makurdi'] },
] as const;
/** Where the Prospector looks, in order. */
export const PROSPECT_REGIONS = ['Lagos', 'Abuja', 'Ibadan', 'Port Harcourt', 'Enugu', 'Benin City', 'Abeokuta', 'Ilorin', 'London', 'Houston', 'Toronto'];
export const PROSPECT_SEGMENTS = ['Staff cooperative societies', 'Professional associations (state branches)', 'University alumni associations', 'Church and mosque welfare or cooperative arms', 'Thrift and credit societies', 'Nigerian diaspora professional associations', 'Telegram channels and groups'];

export const SOURCES = {
  publish: [
    { channel: 'Website and blog (Chronicles)', handle: 'www.combotrader.com.ng', agent: 'growth', cadence: '1 article a week' },
    { channel: 'Facebook Page', handle: 'ComboTrader', agent: 'social', cadence: '4 posts a week' },
    { channel: 'Instagram', handle: '@combotraderofficial', agent: 'social', cadence: '4 posts a week plus Trail stories' },
    { channel: 'LinkedIn page', handle: 'ComboTrader', agent: 'social', cadence: '3 posts a week' },
    { channel: 'Telegram channel', handle: '@combotraderofficial', agent: 'social', cadence: 'every new lot and payout; each post links to the bot' },
    { channel: 'Telegram bot', handle: 'the ComboTrader bot', agent: 'support', cadence: 'answers anyone who opens it (Adaeze); Champions link their account' },
    { channel: 'WhatsApp', handle: '+234 912 220 8765', agent: 'support', cadence: 'replies only; broadcasts only to opted-in Champions' },
    { channel: 'Email', handle: 'hello@combotrader.com.ng', agent: 'email', cadence: 'lifecycle emails and a fortnightly newsletter' },
  ],
  prospect: [
    { type: 'Professional bodies', where: 'ICAN (ican.org.ng), CIBN (cibng.org), Nigerian Bar Association (nigerianbar.org.ng), medical, engineering and HR institutes and their state branches', collect: 'welfare or cooperative contact, branch secretary email' },
    { type: 'Staff cooperatives', where: 'company websites and LinkedIn pages of banks, telcos, oil and gas, FMCG firms and federal agencies; searches for "staff multipurpose cooperative society"', collect: 'co-op secretary or treasurer, official email' },
    { type: 'Alumni and community', where: 'university alumni associations (UNILAG, UI, UNN, OAU, ABU and others), town unions, Rotary and Lions clubs', collect: 'welfare or investment committee contact' },
    { type: 'Faith groups', where: 'welfare and cooperative arms of large churches and Muslim associations in target cities', collect: 'cooperative or welfare office' },
    { type: 'Diaspora', where: 'Nigerians in Diaspora Commission (nidcom.gov.ng) partner lists, NIDO chapters, UK, US and Canada Nigerian professional associations', collect: 'chapter president or events lead' },
  ],
  listen: ['Nairaland (nairaland.com) Business, Investment and Agriculture boards', 'X and LinkedIn searches: "agric investment", "where to put money Nigeria", "food prices"', 'Business press: Nairametrics, BusinessDay, TechCabal, Techpoint Africa'],
};

export const PILLARS = [
  { key: 'proof', name: 'Proof from the field', share: 35, shows: 'Harvest Trail photos and updates: buying, weighing, warehouse, delivery' },
  { key: 'lots', name: 'New lots', share: 20, shows: 'Each open lot: commodity, region, buyer type, periods, closing date' },
  { key: 'how', name: 'How it works', share: 20, shows: 'One idea per post: signed buyer, payout date, what happens if a buyer pays late' },
  { key: 'farmers', name: 'Farmers and Kitovu', share: 15, shows: 'Farmer stories, Kitovu since 2018, the team' },
  { key: 'payouts', name: 'Payouts and milestones', share: 10, shows: 'Completed lots, total paid out, Champions count (real numbers only)' },
] as const;
export const WEEKLY_RHYTHM = { monday: 'how', wednesday: 'proof', friday: 'lots', weekend: 'farmers' } as const;

export const GUARDRAILS = {
  use: ['Harvest Champion', 'Trade Lot', 'earnings', 'signed buyer', 'payout date', 'Harvest Trail', 'not a bank deposit, not NDIC-insured'],
  avoid: ['investment', 'invest', 'investor', 'guaranteed', 'guarantee', 'risk-free', 'double your money', 'passive income', 'ROI', 'last chance', 'hurry'],
  rules: [
    'Quote a rate only as shown on a specific open lot, with its period.',
    'Name Kitovu Technology Company Limited and link to the terms and risk page in every public piece.',
    'One idea per post, a real photo or the branded card, one next step.',
    'Email or WhatsApp only people who opted in; organisations get at most 3 emails (day 0, 7, 21) to their official address.',
    'Never post in other people’s groups, never scrape personal profiles, never message individuals who have not opted in.',
    'At most 2 marketing emails a week to anyone; every email has a one-click stop link.',
    'Paid ads need ARCON approval before they run; scale promotion waits for legal sign-off on SEC registration.',
  ],
};

/** Words from the avoid list found in a draft (whole words, case-insensitive). */
export function offMessage(text: string) {
  const t = ` ${String(text).toLowerCase()} `;
  return GUARDRAILS.avoid.filter((w) => new RegExp(`[^a-z]${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^a-z]`).test(t));
}

/** The part of the playbook each agent needs, as plain text for its instructions. */
export function playbookFor(agent: 'social' | 'email' | 'prospector' | 'growth' | 'support' | 'chief') {
  const seg = SEGMENTS.map((s) => `- ${s.name} (${s.who}): want ${s.want.toLowerCase()}; first fear "${s.fear}"; lead with: ${s.message}.`).join('\n');
  const rules = `Rules:\n${GUARDRAILS.rules.map((r) => `- ${r}`).join('\n')}\nNever use: ${GUARDRAILS.avoid.join(', ')}. Prefer: ${GUARDRAILS.use.join(', ')}.`;
  const head = `PLAYBOOK (ComboTrader marketing & sales briefing pack). Core promise: "${PROMISE}"`;
  switch (agent) {
    case 'social': return `${head}\nContent pillars: ${PILLARS.map((p) => `${p.name} ${p.share}% (${p.shows})`).join('; ')}.\nAudiences:\n${seg}\n${rules}`;
    case 'email': return `${head}\nAudiences:\n${seg}\n${rules}`;
    case 'growth': return `${head}\nWrite for these readers:\n${seg}\nPillars: ${PILLARS.map((p) => p.name).join(', ')}.\n${rules}`;
    case 'prospector': return `${head}\nTarget organisations (in this order): ${PROSPECT_SEGMENTS.join('; ')}.\nCities (in this order): ${PROSPECT_REGIONS.join(', ')}.\nWhere to look:\n${SOURCES.prospect.map((s) => `- ${s.type}: ${s.where} (collect ${s.collect})`).join('\n')}\nAudiences:\n${seg}\n${rules}`;
    case 'support': return `${head}\n${rules}`;
    default: return `${head}\nAudiences:\n${seg}\nLocations by phase: ${LOCATIONS.map((l) => `phase ${l.phase}: ${l.places.join(', ')}`).join('; ')}.\n${rules}`;
  }
}

/** Proposed 90-day targets from the briefing pack (the Chief of Staff tracks progress against them). */
export const TARGETS_90 = { leads: 2000, signups: 600, first_trades: 200, circles: 10, prospects_talking: 40 } as const;
