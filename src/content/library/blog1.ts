// Blog library, part 1 of 4: guides to how ComboTrader works.
import type { LibraryPost } from './types';

export const BLOG_1: LibraryPost[] = [
  { slug: 'how-a-trade-lot-works', title: 'How a Trade Lot works, step by step', category: 'guides', excerpt: 'From a buyer’s signed order to your payout: the whole journey of a ComboTrader Trade Lot.',
    body: `A Trade Lot is the heart of ComboTrader. It is one purchase of one commodity, made to fill an order that a buyer has already signed. Here is the whole journey.

## 1. A buyer signs an order
A feed mill, food processor or exporter agrees to buy a set quantity of a commodity, for example soybean, at an agreed price and quality, for delivery by a certain date.

## 2. Kitovu opens a lot
To fill that order, Kitovu needs working capital to buy from farmers now. We open a Trade Lot that shows the commodity, the sourcing region, the type of buyer, the periods available, the rate for each period and the date the lot closes.

## 3. Champions fund it
Harvest Champions choose an amount and a period and join the lot from their wallet. Each Champion receives a Trade Certificate with their exact payout date.

## 4. Farmers are paid
Once the lot is funded, our field team buys from farmers and aggregators in the sourcing region. Farmers are paid promptly instead of waiting for the buyer.

## 5. Store, grade, deliver
The goods are weighed, graded and stored, then delivered to the buyer. Every step appears on the lot’s Harvest Trail.

## 6. Everyone is paid
The buyer pays for the goods. On each Champion’s payout date, their money and earnings are paid into their ComboTrader wallet. If a buyer pays late, Kitovu still pays Champions on the date on their certificate.

That’s it: real goods, a real buyer and a trail you can follow. Before you join any lot, read our [risk page](/legal/risk): trades are not bank deposits and are not NDIC-insured.` },

  { slug: 'what-a-signed-buyer-means', title: 'What “a signed buyer” means, and why it matters', category: 'guides', excerpt: 'Every ComboTrader lot starts with demand that already exists. Here is why that changes everything.',
    body: `Many agricultural schemes start with a farm and hope a buyer turns up at harvest. ComboTrader starts the other way round: with a buyer who has already agreed to buy.

## What the buyer signs
An offtake agreement or purchase order sets out the commodity, the quantity, the quality, the price or price formula, and the delivery window. It is a commercial commitment, not a promise of interest.

## Why it matters to Champions
- **The demand is known.** We are not guessing who will buy the goods or at what price.
- **The timeline is shorter.** We are buying harvested produce to deliver, not waiting for a crop to grow.
- **The risk is different.** Farming risks such as drought and pests largely sit before harvest. A trade lot still carries risks, such as a buyer paying late or quality disputes, but they are different and more manageable.

## What we show you
Each lot shows the buyer type (for example “feed mill” or “food processor”) rather than the company’s name, because buyers’ commercial terms are confidential. The commodity, region, quantity and dates are shown in full.

## What if the buyer pays late?
Kitovu pays Champions on their payout date from its own balance sheet, then recovers the money from the buyer. That depends on Kitovu remaining able to pay, which is why we never describe trades as risk-free.` },

  { slug: 'the-harvest-trail-explained', title: 'The Harvest Trail, explained', category: 'guides', excerpt: 'See exactly where your money goes: what each step on the Harvest Trail means.',
    body: `Our promise is simple: **you can see exactly where your money goes.** The Harvest Trail is how we keep it.

Every Trade Lot has its own trail, a timeline that moves as the goods move. When a step is added, every Champion in the lot gets a notification.

## The steps
1. **Funded.** The lot has reached its target and closes.
2. **Bought from farmers.** The commodity has been purchased in the sourcing region, with notes such as the number of farmers and locations.
3. **In the warehouse.** Goods are weighed, graded and stored. You may see weighbridge tickets or warehouse photos.
4. **Delivered to the buyer.** The goods arrive and are signed for.
5. **Buyer paid.** The buyer settles the invoice.
6. **Champions paid.** On each payout date, money and earnings land in Champions’ wallets.

## Photos and notes
Our field team adds photos and short notes at each stage. Some steps take days, others weeks, depending on the commodity and the buyer’s delivery window.

## Why we do this
Agricultural platforms in Nigeria have lost people’s trust by asking them to believe without showing. The Harvest Trail exists so you never have to take our word for it.` },

  { slug: 'how-payout-dates-work', title: 'How payout dates work, and why yours doesn’t move', category: 'guides', excerpt: 'Your payout date is fixed the moment you join a lot. Here is what that means.',
    body: `When you join a Trade Lot, you choose a period. Your Trade Certificate then shows your **payout date**: the day your money and earnings are paid into your wallet.

## Fixed when you join
The date is calculated from when you join and the period you chose. It is printed on your certificate and shown in the app.

## What if the trade finishes early or late?
Trades don’t always finish on the same day as your period ends. Buyers may pay earlier or later. Your payout date does not move with them. If a buyer pays late, Kitovu pays you on your date from its own balance sheet and recovers the money from the buyer afterwards.

## What happens on the day
Your principal and earnings are credited to your ComboTrader wallet. You get a notification and an email. From there you can:
- withdraw to your Nigerian bank account,
- join another lot, or
- leave it in your wallet for later.

## A reminder before the date
About a week before your payout, we send a reminder so you can plan what to do next.

Fixed dates make planning easier, but they rely on Kitovu remaining able to pay. Please read the [risk page](/legal/risk) so you understand that before taking part.` },

  { slug: 'what-if-a-buyer-pays-late', title: 'What happens if a buyer pays late?', category: 'guides', excerpt: 'The most important question about any trade, answered plainly.',
    body: `It’s the right question to ask. In commodity trade, buyers sometimes pay later than agreed: a delayed shipment, a quality query or their own cash timing.

## What Kitovu does
Champions are paid on the payout date on their Trade Certificate **whether or not the buyer has paid**. Kitovu covers the gap from its own balance sheet, using its cash, credit lines and money due from other buyers, and then recovers the money from the late buyer.

## How we manage the risk
- We work with buyers whose payment history and contracts we know.
- Each lot is sized against a specific order.
- Our Treasury team tracks every payment due against every payout due, weeks ahead.

## What this does not mean
It does not mean trades are risk-free. Kitovu’s ability to pay depends on Kitovu remaining financially sound. Trades are not bank deposits and are not insured by the NDIC. If Kitovu itself got into difficulty, payouts could be affected.

We say this plainly because we would rather you join knowing it. Read the full [risk page](/legal/risk).` },

  { slug: 'choosing-a-period', title: 'Choosing a period: shorter or longer?', category: 'guides', excerpt: 'Lots offer several periods, each with its own rate. How to think about which suits you.',
    body: `Most Trade Lots let you choose how long your money stays in the trade. Each period has its own rate, shown on the lot before you commit; longer periods earn a higher rate.

## Questions to ask yourself
- **When might I need this money?** Choose a period that ends before then. Money in a trade stays there until the payout date.
- **Do I want to review regularly?** Shorter periods give you more frequent chances to decide again.
- **Am I building towards something?** Longer periods suit money you won’t need for a while.

## Mixing periods
Some Champions split their amount across periods, for example part on a shorter period and part on a longer one, so that money comes back at different times.

## What stays the same
Whatever period you choose, you get a Trade Certificate with a fixed payout date, and you can follow the lot on the Harvest Trail.

## Use the calculator
Our [calculator](/calculator) shows what an amount would earn over each period, using the current rate card. The rate that applies to you is the one shown on the lot when you join.` },

  { slug: 'not-a-bank-deposit', title: 'Not a bank deposit: understanding the risks', category: 'guides', excerpt: 'What ComboTrader is, what it isn’t, and the risks you should understand first.',
    body: `We want every Harvest Champion to take part with their eyes open. Here is what you should understand.

## It is a commercial trade
When you join a Trade Lot, your money funds the purchase of goods for a buyer. You earn when the trade completes. That is different from a savings account.

## It is not a bank deposit
ComboTrader is not a bank. Your money is not a deposit and **is not insured by the NDIC**.

## The main risks
- **Kitovu’s ability to pay.** Kitovu pays Champions on their payout date even if a buyer is late. That depends on Kitovu remaining financially sound.
- **Buyer risk.** A buyer may pay late, dispute quality or fail to pay. Kitovu absorbs this, which links back to the first risk.
- **Operational risk.** Goods can be delayed or damaged in transport or storage.
- **Liquidity.** Your money stays in the trade until the payout date.

## How to manage your own risk
- Only use money you won’t need before the payout date.
- Don’t put all your savings in one place.
- Read each lot’s details and follow its Harvest Trail.

Our [risk page](/legal/risk) and [terms](/legal/terms) explain this in full.` },

  { slug: 'red-flags-agric-schemes', title: 'Seven red flags of agric schemes, and how to check any platform', category: 'guides', excerpt: 'Use this checklist on any agricultural platform, including ours.',
    body: `Nigeria has seen agricultural schemes that took people’s money and disappeared. Use this checklist on any platform, including ComboTrader.

## 1. “Guaranteed” returns
Real trade has risks. Anyone promising guaranteed, risk-free returns is either mistaken or misleading you.

## 2. Returns that are too high
Very high returns in short periods should make you ask what activity could possibly produce them.

## 3. Pressure to decide now
Countdown timers and “last chance” messages are designed to stop you thinking.

## 4. Earnings from recruiting
If you earn mainly by bringing in others, be careful.

## 5. No visible activity
Can you see what your money is doing? Photos, documents, named commodities and regions?

## 6. No real company
Look for a registered company, a physical address and people you can call.

## 7. Vague answers
Ask what happens if a buyer doesn’t pay. A real operator gives a real answer.

## How we try to pass this test
No guarantees, rates shown per lot, no pressure tactics, a Harvest Trail for every lot, and a registered company, Kitovu Technology Company Limited, with an address and a team you can reach. Check the regulator’s public notices too: the SEC publishes warnings about unregistered schemes.` },

  { slug: 'harvest-circles-guide', title: 'Harvest Circles: joining a lot as a group', category: 'guides', excerpt: 'How friends, families and groups take part together, with each person in their own name.',
    body: `Harvest Circles let a group join a Trade Lot together: friends, family, a cooperative, an alumni set or a welfare group.

## How it works
1. Someone creates a Circle for a lot and invites the group with a link.
2. Each member signs up, verifies their identity and funds **their own share** from their own wallet.
3. Each member receives their own Trade Certificate.
4. The group follows the lot together on the Harvest Trail.
5. On the payout date, each member is paid into their own wallet.

## Why groups like it
- **No pooling.** Nobody collects money for the group, so there’s no treasurer risk.
- **One view.** Organisers see how the Circle is filling.
- **Shared proof.** Trail updates make a natural agenda item at group meetings.

## For cooperatives and committees
We can brief your committee and members, and provide the documents committees usually ask for. See our [guide for committees](/chronicles/guide-for-cooperative-committees).

Circles fill before the lot closes; any member who doesn’t fund in time simply isn’t included.` },

  { slug: 'guide-for-cooperative-committees', title: 'A guide for cooperative and society committees', category: 'guides', excerpt: 'What committees should ask, and what ComboTrader provides, before recommending a lot to members.',
    body: `If you serve on a cooperative, thrift society or welfare committee, members trust you to check before you recommend anything. Here is how to assess ComboTrader.

## Questions to ask us
- Who runs the platform, and where are they based?
- What exactly does a lot finance?
- What happens if a buyer pays late?
- Who holds members’ money, and in whose name?
- How do members withdraw?
- What are the risks, in writing?

## What we provide
- Company details for Kitovu Technology Company Limited.
- Our [terms](/legal/terms) and [risk page](/legal/risk).
- For each lot: commodity, region, buyer type, rates, periods, payout date.
- A briefing for the committee, then a short session for members.
- A named contact for your group.

## How members take part
Through a [Harvest Circle](/chronicles/harvest-circles-guide). Each member funds their own share in their own name; the committee never collects or pools money. That keeps it simple for the treasurer and clear for members.

## A sensible approach
Many committees start by sharing one lot with interested members, then review after the first payout. To arrange a briefing, [contact us](/contact).` },

  { slug: 'taking-part-from-abroad', title: 'For Nigerians abroad: taking part from overseas', category: 'guides', excerpt: 'Funding, verification, withdrawals and following your trade from the UK, US, Canada and beyond.',
    body: `Many Champions live outside Nigeria. Here is how ComboTrader works for you.

## Everything is in naira
Lots, wallets and payouts are in naira. You can fund by card through Paystack, our payment partner.

## Verifying your identity
Verify with your BVN if you have one, or upload a passport or other ID for our team to check.

## Withdrawals
Withdrawals go to a Nigerian bank account in your name. If you need to receive payouts abroad, contact us before you start so we can explain what’s possible.

## Following your trade
The Harvest Trail works the same from anywhere: photos and notes from the field, and a notification at each step. Add ComboTrader to your phone’s home screen to get alerts.

## Groups and chapters
Diaspora associations and alumni chapters can join lots together through Harvest Circles. We run evening webinars timed for your time zone; [ask us](/contact).

## Before you start
Read the [risk page](/legal/risk). Trades are not bank deposits and are not NDIC-insured.` },

  { slug: 'verifying-your-identity', title: 'Verifying your identity: BVN or ID, and why we ask', category: 'guides', excerpt: 'Why verification is required, how it works, and what happens to your BVN.',
    body: `Before your total funding passes the limit shown in your wallet, we ask you to verify your identity; you also need it to withdraw. Here’s why and how.

## Why
Nigerian financial rules require platforms that handle money to know who their customers are. Verification also protects you: it stops someone else opening an account in your name or withdrawing your money.

## Option 1: BVN (instant for most people)
Enter your BVN and the bank account you’ll use for withdrawals. It is checked securely by Paystack, our payment partner, against bank records. Most checks finish within minutes. **ComboTrader never stores your BVN.**

## Option 2: Upload an ID
Upload a clear photo of an approved ID document. A member of our team reviews it, usually within one working day.

## Common reasons a check fails
- The name on your ComboTrader profile doesn’t match the name on your BVN or bank account.
- The bank account isn’t in your name.

Fix the detail in your profile and try again, or contact us.

We will never ask for your BVN, password or codes by chat, email or WhatsApp.` },

  { slug: 'funding-and-withdrawing', title: 'Funding your wallet and withdrawing: a walkthrough', category: 'guides', excerpt: 'How money gets into your wallet, into a lot, and back to your bank.',
    body: `Your ComboTrader wallet is where money arrives and leaves. Here’s the flow.

## Funding
1. Go to **Wallet → Fund wallet**.
2. Enter an amount and continue to Paystack.
3. Pay by card, bank transfer or USSD.
4. You’re returned to ComboTrader and your wallet shows the money, usually immediately.

## Joining a lot
From an open lot, choose your amount and period and confirm. The money moves from your wallet into the trade, and your Trade Certificate is issued.

## Payout
On your payout date, your money and earnings return to your wallet.

## Withdrawing
1. Add your bank account in your profile (in your own name).
2. Go to **Wallet → Withdraw**, enter the amount and the code we email you.
3. Once it’s approved, the transfer is sent to your bank. The app shows its status at each step.

## Security
We email a code for every withdrawal and every change of bank account, so nobody else can move your money even if they learn your password.` },
];
