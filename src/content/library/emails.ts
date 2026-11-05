// ComboTrader email library: sequences for contacts who opted in, extra Champion lifecycle emails,
// partnership outreach by organisation type, and ready answers for the Support agent.
// Placeholders: {name} first name (falls back to "there"), {site} website, plus the ones listed per email.
// Bodies are Markdown; a button with the CTA is added under each email, and every email has a stop link.
// Follows the playbook: no "invest"/"guaranteed", rates only as shown on a lot.

export interface Step { key: string; day: number; subject: string; preview: string; body: string; cta: { label: string; path: string } }
export interface Sequence { name: string; audience: string; steps: Step[] }

export const SEQUENCES: Record<string, Sequence> = {
  nurture: {
    name: 'Getting to know ComboTrader',
    audience: 'Individuals who asked to hear from us and have not signed up yet (waitlist, events, website, imported opt-in lists)',
    steps: [
      { key: 'n1', day: 0, subject: 'Welcome to ComboTrader, {name}', preview: 'Here is exactly how a Trade Lot works.',
        body: `Hello {name},\n\nThank you for your interest in ComboTrader. Over the next few weeks we’ll send you a handful of short emails so you can decide, in your own time, whether being a Harvest Champion is for you.\n\nHere is the idea in one line: **you fund real agricultural trades that already have a buyer waiting, and you can see exactly where your money goes.**\n\nA Trade Lot is one purchase of a commodity, for example soybean from Benue or maize from Oyo, bought from farmers to fill an order that a buyer has already signed. Champions fund the purchase. Kitovu buys, stores and delivers. When the trade completes, Champions are paid back with earnings on the payout date shown before they commit.\n\nNo jargon, no pressure. Just real trade you can follow.\n\nWarm regards,\nThe ComboTrader team at Kitovu`,
        cta: { label: 'See how a trade works', path: '/how-it-works' } },
      { key: 'n2', day: 2, subject: 'The question everyone asks first', preview: '“Is this another agric scheme?” A fair question.',
        body: `Hello {name},\n\nWhen people first hear about ComboTrader, the first question is usually: *“Is this another agric scheme?”*\n\nIt’s the right question. Several platforms that promised returns from farming disappointed people badly. So here is what is different, plainly:\n\n- **We don’t fund farming.** We fund the *purchase* of harvested commodities to fill a buyer’s signed order. The crop already exists; the buyer already exists.\n- **You see the lot before you join.** Commodity, sourcing region, buyer type, rate, period and payout date are all shown up front.\n- **You follow it on the Harvest Trail.** Photos and updates as the goods are bought, weighed, stored and delivered.\n- **Your payout date doesn’t move.** If a buyer pays late, Kitovu still pays Champions on the date on their Trade Certificate.\n\nTrades are not bank deposits and are not NDIC-insured, and we say so clearly. Read our risk page before you take part.\n\nThe ComboTrader team`,
        cta: { label: 'Read the risk page', path: '/legal/risk' } },
      { key: 'n3', day: 5, subject: 'Who is behind ComboTrader?', preview: 'Kitovu has worked with Nigerian farmers since 2018.',
        body: `Hello {name},\n\nComboTrader is run by **Kitovu Technology Company Limited**, an agri-infrastructure company headquartered in Oyo State.\n\nSince 2018 Kitovu has worked with farmers on inputs, storage, aggregation and getting produce to market. ComboTrader grows out of that work: we kept seeing good trades go unfilled because there wasn’t enough working capital to buy from farmers quickly, and farmers waiting weeks to be paid.\n\nComboTrader connects that capital to real, contracted demand. Farmers are paid promptly, buyers get what they ordered, and Champions earn for making it happen.\n\nYou are welcome to call us, visit, or ask anything on WhatsApp.\n\nThe ComboTrader team`,
        cta: { label: 'Why Kitovu', path: '/why-kitovu' } },
      { key: 'n4', day: 9, subject: 'Follow a trade from farm to buyer', preview: 'What the Harvest Trail shows you, step by step.',
        body: `Hello {name},\n\nEvery Trade Lot has a **Harvest Trail**: a timeline of what happens to the goods your money bought.\n\n1. **Funded:** the lot reaches its target.\n2. **Bought from farmers:** the commodity is purchased, with the region and number of farmers.\n3. **In the warehouse:** weighed, graded and stored.\n4. **Delivered to the buyer:** goods arrive and are signed for.\n5. **Buyer paid:** the buyer settles.\n6. **Champions paid:** your money and earnings land in your wallet on the payout date.\n\nEach step comes with photos or notes from the field, and you get a notification when it moves.\n\nThe ComboTrader team`,
        cta: { label: 'See the Trade Lots', path: '/lots' } },
      { key: 'n5', day: 14, subject: 'How earnings and payout dates work', preview: 'Choose your period; see your date before you commit.',
        body: `Hello {name},\n\nOn ComboTrader you choose how long your money stays in a trade. Lots offer set periods, and each period has its own rate, shown on the lot before you commit. Longer periods earn more.\n\nWhen you join a lot you receive a **Trade Certificate** with your amount, rate, period and exact payout date. On that date your money and earnings are paid into your ComboTrader wallet, and you can withdraw to your Nigerian bank account or join the next lot.\n\nThe website has a calculator that shows what a given amount would earn for each period, using the current rate card.\n\nThe ComboTrader team`,
        cta: { label: 'Try the calculator', path: '/calculator' } },
      { key: 'n6', day: 21, subject: 'Better together: Harvest Circles', preview: 'Join a lot with your friends, family or group.',
        body: `Hello {name},\n\nMany Champions don’t join alone. With **Harvest Circles** a group, such as friends, family, a cooperative or an alumni set, joins a lot together. Each person funds their own share from their own wallet and gets their own certificate, but the group follows the lot together.\n\nIt’s a good fit for thrift groups and cooperatives that want a transparent home for part of their savings, with statements the committee can see.\n\nIf you lead a group and would like a short session for your members, just reply to this email.\n\nThe ComboTrader team`,
        cta: { label: 'About Harvest Circles', path: '/circles' } },
      { key: 'n7', day: 30, subject: 'Getting started takes about 10 minutes', preview: 'Sign up, verify, fund your wallet, choose a lot.',
        body: `Hello {name},\n\nIf you’ve been thinking about it, here is what getting started looks like:\n\n1. **Sign up** with your email or Google account.\n2. **Verify your identity** with your BVN, or upload an ID. This protects you and keeps ComboTrader safe.\n3. **Fund your wallet** by card or bank transfer through Paystack.\n4. **Choose a lot** and a period, then confirm. Your Trade Certificate arrives straight away.\n\nThat’s it. You can start with the minimum shown on each lot and do more later.\n\nThe ComboTrader team`,
        cta: { label: 'Create your free account', path: '/signup' } },
      { key: 'n8', day: 45, subject: 'Should we keep in touch, {name}?', preview: 'Our fortnightly newsletter, or nothing at all. Your choice.',
        body: `Hello {name},\n\nThis is our last email in this short series. From here, we’ll only write if you want us to.\n\nOur fortnightly newsletter shares new lots, Harvest Trail updates from the field and plain-English pieces on Nigeria’s food trade. If that sounds useful, you’re already on the list; do nothing. If not, use the stop link below and we won’t email you again.\n\nWhenever you’re ready to become a Harvest Champion, we’ll be here.\n\nThank you for reading,\nThe ComboTrader team`,
        cta: { label: 'See what’s open now', path: '/lots' } },
    ],
  },
  diaspora: {
    name: 'For Nigerians abroad',
    audience: 'Nigerians in the UK, US, Canada, Ireland, UAE and elsewhere who opted in',
    steps: [
      { key: 'd1', day: 0, subject: 'A real stake in home, {name}', preview: 'Back Nigerian food trade you can follow from anywhere.',
        body: `Hello {name},\n\nMany Nigerians abroad want their money at home to do something real, and to be able to check on it without relying on a relative or a promise.\n\nComboTrader lets you fund real agricultural trades in Nigeria, each with a buyer already signed, and follow every step on the Harvest Trail from wherever you are. It’s run by Kitovu Technology Company Limited, which has worked with Nigerian farmers since 2018.\n\nOver the next few weeks we’ll send a few short emails answering the questions people abroad ask most.\n\nThe ComboTrader team`,
        cta: { label: 'See how it works', path: '/how-it-works' } },
      { key: 'd2', day: 3, subject: 'How it works from abroad', preview: 'Naira wallet, card funding, withdrawals to a Nigerian account.',
        body: `Hello {name},\n\nA few practical points for Champions outside Nigeria:\n\n- **Everything is in naira.** Your wallet, the lots and your payouts are in naira.\n- **Funding:** by card or transfer through Paystack, our payment partner.\n- **Withdrawals:** to a Nigerian bank account in your name. If you need payouts sent abroad, contact us first and we’ll explain what’s possible.\n- **Verification:** BVN if you have one, or an ID document.\n\nYou can see your balance, certificates and the Harvest Trail any time in the app.\n\nThe ComboTrader team`,
        cta: { label: 'Read the FAQs', path: '/faqs' } },
      { key: 'd3', day: 7, subject: 'See it before you trust it', preview: 'The Harvest Trail shows every step, with photos.',
        body: `Hello {name},\n\nTrust is hard at a distance, so we don’t ask for it. We show you.\n\nEvery lot names its commodity, sourcing region and buyer type before you commit. Once it’s funded, the **Harvest Trail** shows the purchase from farmers, the warehouse, delivery and the buyer’s payment, with photos and notes from our field team.\n\nYou are welcome to arrange a call with our team, or a visit when you are next home.\n\nThe ComboTrader team`,
        cta: { label: 'Browse the lots', path: '/lots' } },
      { key: 'd4', day: 14, subject: 'Bring your association along', preview: 'Harvest Circles for diaspora groups and chapters.',
        body: `Hello {name},\n\nDiaspora associations, alumni chapters and professional groups can join lots together through **Harvest Circles**. Each member funds their own share and gets their own certificate; the group follows the lot together.\n\nWe’re happy to run a short online session for your chapter, timed for your evening. Just reply with your group’s name and a couple of dates.\n\nThe ComboTrader team`,
        cta: { label: 'About Harvest Circles', path: '/circles' } },
      { key: 'd5', day: 21, subject: 'What to read before you start', preview: 'Our risk page, in plain English.',
        body: `Hello {name},\n\nBefore you take part, please read our risk page. In short: trades are commercial trades, not bank deposits, and are not NDIC-insured. Kitovu pays Champions on their payout date even if a buyer pays late, and that depends on Kitovu remaining able to pay.\n\nWe would rather you join knowing this than join on a promise.\n\nThe ComboTrader team`,
        cta: { label: 'Read the risk page', path: '/legal/risk' } },
      { key: 'd6', day: 35, subject: 'Ready when you are', preview: 'Sign up in about 10 minutes.',
        body: `Hello {name},\n\nThat’s the end of this short series. If and when you’re ready, signing up takes about 10 minutes: create an account, verify your identity, fund your wallet and choose a lot.\n\nYou’ll keep receiving our fortnightly newsletter with new lots and news from the field, unless you stop it with the link below.\n\nThe ComboTrader team`,
        cta: { label: 'Create your account', path: '/signup' } },
    ],
  },
  circle: {
    name: 'For group leaders and committees',
    audience: 'Secretaries, treasurers and committee members of cooperatives, thrift societies, alumni and faith groups who opted in',
    steps: [
      { key: 'c1', day: 0, subject: 'A transparent option for your group’s funds', preview: 'Harvest Circles: one lot, statements for the committee.',
        body: `Hello {name},\n\nThank you for your interest in ComboTrader for your group.\n\n**Harvest Circles** let a cooperative, thrift society, alumni set or welfare group join a Trade Lot together. Each member funds their own share from their own wallet and receives their own Trade Certificate. The committee sees one view of the group’s participation, and every lot has a Harvest Trail you can show members at meetings.\n\nEach lot is a real purchase of a commodity from farmers to fill an order a buyer has already signed.\n\nThe ComboTrader team`,
        cta: { label: 'About Harvest Circles', path: '/circles' } },
      { key: 'c2', day: 4, subject: 'What your committee will want to see', preview: 'The paperwork and reporting, in one place.',
        body: `Hello {name},\n\nCommittees rightly ask for detail before recommending anything to members. Here is what we provide:\n\n- **Company details:** Kitovu Technology Company Limited, registration and address.\n- **Terms and risk page:** in plain English.\n- **For each lot:** commodity, region, buyer type, rate, period, payout date.\n- **For the group:** a summary of members’ participation and payouts.\n- **A named contact** at Kitovu for the group.\n\nWe’re glad to present to your committee in person (Lagos, Abuja, Ibadan) or online.\n\nThe ComboTrader team`,
        cta: { label: 'Read the terms', path: '/legal/terms' } },
      { key: 'c3', day: 10, subject: 'A 20-minute session for your members?', preview: 'In person or online, at your meeting time.',
        body: `Hello {name},\n\nMany groups start with a short session at a regular meeting: 20 minutes on how a lot works, the Harvest Trail and the risks, then questions.\n\nThere’s no obligation, and we never ask members to decide on the day. If that would help, reply with your meeting day and location, or a preferred online time.\n\nThe ComboTrader team`,
        cta: { label: 'Contact the team', path: '/contact' } },
      { key: 'c4', day: 18, subject: 'How a group lot works, step by step', preview: 'From the committee’s decision to members’ payouts.',
        body: `Hello {name},\n\n1. The committee agrees to share a lot with members.\n2. We create the group’s Harvest Circle and send members a link.\n3. Each member signs up, verifies and funds their own share before the lot closes.\n4. The group follows the Harvest Trail together.\n5. On the payout date, each member is paid into their own wallet.\n\nThe group never pools money through Kitovu: each member’s money stays in their own name. That keeps it simple for treasurers.\n\nThe ComboTrader team`,
        cta: { label: 'See open lots', path: '/lots' } },
      { key: 'c5', day: 30, subject: 'We’re here when your group is ready', preview: 'One email from you starts it.',
        body: `Hello {name},\n\nThis is our last note in this series. Whenever your group is ready, reply to this email or message us on WhatsApp, and a member of our team will set up a session.\n\nThank you for considering ComboTrader.\n\nThe ComboTrader team`,
        cta: { label: 'Message us', path: '/contact' } },
    ],
  },
  network: {
    name: 'For Kitovu customers and partners',
    audience: 'Agro-dealers, buyers, partners and past customers of Kitovu who opted in',
    steps: [
      { key: 'k1', day: 0, subject: 'Something new from Kitovu: ComboTrader', preview: 'Fund the trades you already know.',
        body: `Hello {name},\n\nYou know Kitovu from our work with farmers, inputs and storage. We’ve launched **ComboTrader**, where people fund the purchase of commodities from farmers to fill buyers’ signed orders, and earn when the trade completes.\n\nBecause you know how these trades work, we wanted you to hear about it first.\n\nThe Kitovu team`,
        cta: { label: 'See how it works', path: '/how-it-works' } },
      { key: 'k2', day: 4, subject: 'How ComboTrader is different', preview: 'Trade finance against signed orders, not farm funding.',
        body: `Hello {name},\n\nComboTrader does not fund farms or promise returns from planting. Each lot finances the purchase of harvested produce against an order a buyer has already signed. Champions see the commodity, region, buyer type, rate and payout date before they commit, and follow each lot on the Harvest Trail.\n\nPayments run through Paystack, a licensed payment processor, and payout dates are fixed on each Trade Certificate.\n\nThe Kitovu team`,
        cta: { label: 'Browse the lots', path: '/lots' } },
      { key: 'k3', day: 10, subject: 'Tell your network, earn a thank-you', preview: 'Refer friends with your own link.',
        body: `Hello {name},\n\nIf you think ComboTrader would suit people you know, every Champion gets a personal referral link. When someone you invite completes their first trade, a thank-you is added to your wallet (the current amount is shown in the app).\n\nThe Kitovu team`,
        cta: { label: 'Create your account', path: '/signup' } },
      { key: 'k4', day: 21, subject: 'Questions? Talk to us directly', preview: 'Your usual Kitovu contacts can help.',
        body: `Hello {name},\n\nYour usual Kitovu contacts can answer questions about ComboTrader, or you can reach the ComboTrader team on WhatsApp or by replying here.\n\nThank you for working with us.\n\nThe Kitovu team`,
        cta: { label: 'Contact us', path: '/contact' } },
    ],
  },
};

/** Extra emails for Champions at key moments (placeholders as in the existing lifecycle emails). */
export const CHAMPION_EMAILS = {
  verify_reminder: { subject: 'One step left before you can join a lot, {name}', body: 'Hello {name},\n\nYour ComboTrader account is ready. The one step left is verifying your identity. It protects your money and keeps the platform safe.\n\nYou can verify instantly with your BVN, or upload an ID document for our team to check. It takes about two minutes.' },
  fund_reminder: { subject: 'Your account is verified. What next?', body: 'Hello {name},\n\nThank you for verifying your identity. You can now fund your wallet by card or bank transfer and choose a Trade Lot.\n\nEach lot shows its commodity, region, buyer type, rate, period and payout date before you commit.' },
  lot_closing: { subject: '{lot} closes on {date}', body: 'Hello {name},\n\nA quick note: {lot} closes on {date}. If you’d like to take part, you can join from your wallet before then.\n\nAs always, the rate, period and payout date are shown on the lot before you commit.' },
  // Alternative wording for existing lifecycle emails, tested against the built-in versions.
  welcome_1: { subject: 'Welcome aboard, {name}', body: 'Hello {name},\n\nWelcome to ComboTrader. Every lot is a real purchase of a commodity from farmers to fill an order a buyer has already signed, and you can follow each step on the Harvest Trail.\n\nStart with how a trade works, then look at what’s open.' },
  welcome_2: { subject: 'See what’s open this week, {name}', body: 'Hello {name},\n\nThe Trade Lots page shows every open lot with its commodity, sourcing region, buyer type and the rates for each period, from {low}% to {high}% a year on the current rate card. Choose a period that suits you; your payout date is fixed when you join.' },
  welcome_3: { subject: 'Join a lot with friends or your group', body: 'Hello {name},\n\nWith Harvest Circles you can join a lot alongside friends, family or your cooperative. Each person funds their own share and gets their own certificate, and you follow the lot together.' },
  maturity: { subject: 'Your payout from {lot} is on {date}', body: 'Hello {name},\n\nYour trade in {lot} pays out on {date}. Your money and earnings will land in your ComboTrader wallet that day. You can then withdraw to your bank or roll into a new lot.' },
  paid_out: { subject: 'Paid: thank you for backing {lot}', body: 'Hello {name},\n\nYour payout from {lot} is in your wallet. Thank you for helping farmers get paid on time.\n\nIf you’d like to keep your money working, the next lots are open now.' },
  winback: { subject: 'It’s been a while, {name}', body: 'Hello {name},\n\nWe haven’t seen you on ComboTrader for a while. New lots have opened since your last trade, with rates from {low}% to {high}% a year depending on the period. Have a look whenever you’re ready.' },
  new_lot: { subject: 'New Trade Lot: {lot}', body: 'Hello {name},\n\nA new lot is open: {lot}. Periods: {periods}; rates: {rates} a year. Each lot has a signed buyer and its own Harvest Trail.' },
} as const;

/** First-contact and follow-up emails for organisations, by segment (Prospector, rules mode and as AI examples). */
export const ORG_OUTREACH: Record<string, { subject: string; body: string }> = {
  'Staff cooperative societies': { subject: 'A transparent option for {org} members', body: 'Dear {name},\n\nI’m writing from ComboTrader, a platform of Kitovu Technology Company Limited. Members of staff cooperatives use our Harvest Circles to join real agricultural trades together: each lot finances the purchase of a commodity from farmers to fill a buyer’s signed order, and members follow it on the Harvest Trail.\n\nEach member funds their own share and receives their own certificate, so nothing is pooled through us, and the committee gets a clear summary.\n\nWould your committee welcome a 20-minute briefing, in person or online?\n\nKind regards,\nThe ComboTrader team, Kitovu' },
  'Professional associations (state branches)': { subject: 'A member benefit idea for {org}', body: 'Dear {name},\n\nI’m reaching out from ComboTrader (Kitovu Technology Company Limited). We help professionals take part in Nigeria’s food trade transparently: each Trade Lot finances a commodity purchase for a buyer who has already signed, with every step shown on our Harvest Trail.\n\nWe’d be glad to offer {org} members a short session at a branch meeting or webinar, covering how it works and its risks, with no obligation.\n\nKind regards,\nThe ComboTrader team, Kitovu' },
  'University alumni associations': { subject: 'For {org} members: back real Nigerian trade together', body: 'Dear {name},\n\nAlumni groups use ComboTrader’s Harvest Circles to join agricultural Trade Lots together. Each member funds their own share; the group follows the lot on the Harvest Trail, from purchase from farmers to delivery to the buyer.\n\nCould we offer {org} a short online session for members? We’re happy to fit your calendar.\n\nKind regards,\nThe ComboTrader team, Kitovu' },
  'Church and mosque welfare or cooperative arms': { subject: 'Supporting farmers through {org}', body: 'Dear {name},\n\nWelfare and cooperative groups use ComboTrader to support Nigerian farmers while members earn from real trade. Each lot buys produce from farmers to fill a buyer’s signed order; farmers are paid promptly, and members follow every step.\n\nWe’d be honoured to brief your committee, with full information on how it works and its risks.\n\nKind regards,\nThe ComboTrader team, Kitovu' },
  'Thrift and credit societies': { subject: 'A clear, trackable option for {org}', body: 'Dear {name},\n\nThrift and credit societies use ComboTrader’s Harvest Circles so members can take part in agricultural trade with full visibility: commodity, region, buyer type, rate and payout date are shown before anyone commits, and every step is tracked.\n\nWould a short session for your executives be useful?\n\nKind regards,\nThe ComboTrader team, Kitovu' },
  'Nigerian diaspora professional associations': { subject: 'For {org}: a transparent stake in Nigerian food trade', body: 'Dear {name},\n\nMany Nigerians abroad want their money at home to do something real and verifiable. ComboTrader, run by Kitovu Technology Company Limited, lets members fund commodity purchases for buyers who have already signed, and follow each step online.\n\nWe’d be glad to run an evening webinar for {org}’s members at a time that suits your chapter.\n\nKind regards,\nThe ComboTrader team, Kitovu' },
  followup: { subject: 'Following up: ComboTrader for {org}', body: 'Dear {name},\n\nI wanted to follow up on my note about ComboTrader’s Harvest Circles for {org}. If a short session for your members or committee would be useful, simply reply with a date that suits you. If now isn’t the right time, no problem at all; we won’t keep writing.\n\nKind regards,\nThe ComboTrader team, Kitovu' },
};

/** Ready answers for common questions (Support agent; used in rules mode and as reviewed examples for AI). */
export const RESPONSES: { q: string; a: string }[] = [
  { q: 'Is ComboTrader an investment scheme or a Ponzi?', a: 'No. Each Trade Lot finances the purchase of a real commodity from farmers to fill an order a buyer has already signed. You see the commodity, region, buyer type, rate and payout date before you commit, and you can follow every step on the Harvest Trail. Trades are commercial trades, not bank deposits, and are not NDIC-insured; please read our risk page.' },
  { q: 'Who runs ComboTrader?', a: 'ComboTrader is a platform of Kitovu Technology Company Limited, an agri-infrastructure company headquartered in Oyo State that has worked with Nigerian farmers since 2018.' },
  { q: 'What happens if the buyer pays late or does not pay?', a: 'Kitovu still pays Champions on the payout date shown on their Trade Certificate, from its own balance sheet, and then recovers the money from the buyer. This depends on Kitovu remaining able to pay, which is why trades are not described as risk-free.' },
  { q: 'How do I start?', a: 'Sign up with your email or Google account, verify your identity with your BVN or an ID document, fund your wallet by card or bank transfer, then choose a lot and a period. Your Trade Certificate arrives straight away.' },
  { q: 'What is the minimum amount?', a: 'Each lot shows its own minimum on the lot page, together with the rate for each period and the payout date.' },
  { q: 'How do I get paid?', a: 'On your payout date, your money and earnings are paid into your ComboTrader wallet. You can withdraw to your Nigerian bank account in your name, or join another lot.' },
  { q: 'Can I withdraw before the payout date?', a: 'Money in a trade stays in it until the payout date. If the Marketplace is open, you may be able to offer your trade to other Champions before then; the app shows whether that is available.' },
  { q: 'Why do you need my BVN or ID?', a: 'Nigerian rules require us to know who our customers are, and it protects your account and withdrawals. Your BVN is sent securely to our payment partner for checking and is never stored by ComboTrader.' },
  { q: 'Is my money safe?', a: 'Payments go through Paystack, a licensed payment processor, and every Champion’s money is recorded in your own name in our ledger. Trades still carry risk: they are not bank deposits and are not NDIC-insured. Please read our risk page so you understand it before you take part.' },
  { q: 'What is the Harvest Trail?', a: 'It is the timeline of what happens to the goods your money bought: funded, bought from farmers, in the warehouse, delivered to the buyer, buyer paid and Champions paid, with photos and notes from our field team.' },
  { q: 'What is a Harvest Circle?', a: 'A way for a group such as friends, family, a cooperative or an alumni set to join a lot together. Each member funds their own share and gets their own certificate; the group follows the lot together.' },
  { q: 'Can I take part from outside Nigeria?', a: 'Yes. Everything is in naira; you can fund by card through Paystack and withdraw to a Nigerian bank account in your name. If you need payouts sent abroad, contact us first.' },
  { q: 'Are there fees?', a: 'Any fee that applies is shown before you confirm. The rate on a lot is what you earn on your amount for the period you choose.' },
  { q: 'How do I contact a person?', a: 'Reply “talk to a person” in the chat or on WhatsApp, or email hello@combotrader.com.ng, and a member of the team will reply within one working day.' },
  { q: 'How is this different from Farmcrowdy or ThriveAgric?', a: 'We don’t fund farming or promise returns from planting. Each lot finances the purchase of harvested produce against a buyer’s signed order, with the commodity, region, buyer type and payout date shown before you commit, and each step shown on the Harvest Trail.' },
  { q: 'Can I change my bank account?', a: 'Yes, in your profile. For your protection we email you a code to confirm the change, and a new account may be held for a short period before it can receive withdrawals.' },
  { q: 'I forgot my password', a: 'Use “Forgot password” on the sign-in page and we’ll email you a link to set a new one. We will never ask for your password by chat, email or WhatsApp.' },
  { q: 'Do you have an app?', a: 'ComboTrader works in any browser, and you can add it to your phone’s home screen to use it like an app, with notifications.' },
];
