import { marketOn } from '../lib/market';
import { simulated } from '../lib/paystack';
import type { ReactNode } from 'react';
import { useC, jsonScript } from './render';
import { Logo, Csrf, Flash, Money } from './components';
import { LANGS, langMeta, fmtDate } from '../lib/i18n';
import { config } from '../lib/config';
import { latestPrices } from '../lib/prices';
import { settings } from '../lib/settings';
import { circlesVisibleTo, circlesMode } from '../lib/circles';
import { walletBalance } from '../lib/ledger';
import { q } from '../lib/db';
import crypto from 'node:crypto';
import { FaXTwitter, FaFacebook, FaLinkedin, FaInstagram } from 'react-icons/fa6';
import { LuArrowLeftRight, LuMenu, LuGlobe, LuBell, LuHouse, LuWheat, LuReceipt, LuWallet, LuGift, LuUser, LuLock, LuLifeBuoy, LuUsersRound, LuLogOut, LuSettings, LuDownload, LuPause, LuPiggyBank, LuHeartHandshake, LuArrowLeft } from 'react-icons/lu';

export const ASSET_V = String(Date.now()).slice(-8);

function Head({ title, description, noindex, image }: { title: string; description?: string; noindex?: boolean; image?: string }) {
  const c = useC();
  const desc = description || c.t('home.sub', { rate: 20 });
  const full = title ? `${title} · ComboTrader` : 'ComboTrader · Harvest Champions';
  return (
    <head>
      <meta charSet="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <title>{full}</title>
      <meta name="description" content={desc} />
      {noindex && <meta name="robots" content="noindex" />}
      <meta property="og:title" content={full} />
      <meta property="og:description" content={desc} />
      <meta property="og:type" content="website" />
      <meta property="og:image" content={image || `${config.baseUrl}/icons/og.png`} />
      <meta name="twitter:card" content="summary_large_image" />
      <link rel="canonical" href={config.baseUrl + c.path} />
      <link rel="manifest" href="/manifest.webmanifest" />
      <meta name="theme-color" content="#1F4D2B" />
      <link rel="icon" href="/icons/icon-192.png" />
      <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
      <meta name="apple-mobile-web-app-capable" content="yes" />
      <meta name="mobile-web-app-capable" content="yes" />
      <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
      <meta name="apple-mobile-web-app-title" content="ComboTrader" />
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Inter:wght@400;500;600;700&family=Noto+Sans+Arabic:wght@400;600;700&display=swap" />
      <link rel="stylesheet" href={`/styles.css?v=${ASSET_V}`} />
    </head>
  );
}

function Boot({ withFeed = true }: { withFeed?: boolean }) {
  const c = useC();
  let tawk: Record<string, unknown> | null = null;
  if (config.tawkPropertyId) {
    tawk = { property: config.tawkPropertyId, widget: config.tawkWidgetId };
    if (c.user) {
      tawk.name = `${c.user.first_name} ${c.user.last_name}`;
      tawk.email = c.user.email;
      if (config.tawkApiKey) tawk.hash = crypto.createHmac('sha256', config.tawkApiKey).update(c.user.email).digest('hex');
    }
  }
  const boot = {
    lang: c.lang, csrf: c.csrf, feed: withFeed && settings().feed_enabled, tawk, vapid: config.vapidPublic || null, loggedIn: !!c.user,
    s: { install: c.t('install.banner'), installBtn: c.t('install.button'), later: c.t('install.later'), copied: c.t('ref.copied'), pwShow: c.t('pw.show'), pwHide: c.t('pw.hide'), close: c.t('feed.close'),
      pushOn: c.t('notif.push_on'), pushNo: c.t('notif.push_unsupported'), months: c.t('common.months'), pause: c.t('ticker.pause'), play: c.t('ticker.play'),
      cookieText: c.t('cookie.text'), cookieAccept: c.t('cookie.accept'), cookieEssential: c.t('cookie.essential'), cookieMore: c.t('cookie.more'),
      ios1: c.t('install.ios_1'), ios2: c.t('install.ios_2'), ios3: c.t('install.ios_3'), iosH: c.t('install.ios_h') },
  };
  return <script type="application/json" id="boot" dangerouslySetInnerHTML={{ __html: jsonScript(boot) }} />;
}

export function Ticker() {
  const c = useC();
  const prices = latestPrices();
  if (!prices.length) return null;
  const latest = prices.reduce((a, p) => (p.observed_on > a ? p.observed_on : a), '');
  const items = prices.map((p) => (
    <a key={p.commodity} href={`/prices#${p.commodity}`} className="tick">
      <b>{p.name}</b> <span dir="ltr">₦{(p.price_per_kg / 100).toLocaleString('en', { maximumFractionDigits: 0 })}{c.t('ticker.per_kg')}</span>
      {p.change_pct !== null && <span className={p.change_pct > 0 ? 'up' : p.change_pct < 0 ? 'down' : 'flat'} dir="ltr">{p.change_pct > 0 ? '▲' : p.change_pct < 0 ? '▼' : '■'} {Math.abs(p.change_pct).toFixed(1)}%</span>}
    </a>
  ));
  return (
    <div className="ticker" role="region" aria-label={c.t('ticker.title')}>
      <a className="ticker-label" href="/prices">{c.t('ticker.title')}<small>{c.t('ticker.updated', { date: fmtDate(c.lang, latest, { day: 'numeric', month: 'short' }) })}</small></a>
      <div className="ticker-track"><div className="ticker-move">{items}<span aria-hidden="true" className="ticker-dup">{items}</span></div></div>
      <button type="button" className="ticker-toggle" data-ticker-toggle aria-label={c.t('ticker.pause')}><LuPause aria-hidden /></button>
    </div>
  );
}

function LangMenu() {
  const c = useC();
  const back = encodeURIComponent(c.url.pathname + c.url.search);
  return (
    <details className="menu lang-menu">
      <summary aria-label={c.t('nav.language')}><LuGlobe aria-hidden /> <span>{c.lang.toUpperCase()}</span></summary>
      <ul>
        {LANGS.map((l) => <li key={l.code}><a href={`/lang/${l.code}?back=${back}`} lang={l.code} aria-current={l.code === c.lang ? 'true' : undefined}>{l.label}</a></li>)}
      </ul>
    </details>
  );
}

export function Social() {
  const s = config.social;
  return (
    <ul className="social">
      <li><a href={s.x} rel="noopener" target="_blank" aria-label="X"><FaXTwitter /></a></li>
      <li><a href={s.facebook} rel="noopener" target="_blank" aria-label="Facebook"><FaFacebook /></a></li>
      <li><a href={s.linkedin} rel="noopener" target="_blank" aria-label="LinkedIn"><FaLinkedin /></a></li>
      <li><a href={s.instagram} rel="noopener" target="_blank" aria-label="Instagram"><FaInstagram /></a></li>
    </ul>
  );
}

function Html({ children, title, description, noindex, bodyClass, feed = true, image }: { children: ReactNode; title: string; description?: string; noindex?: boolean; bodyClass?: string; feed?: boolean; image?: string }) {
  const c = useC();
  const m = langMeta(c.lang);
  const banner = settings().maintenance_banner;
  return (
    <html lang={c.lang} dir={m.dir}>
      <Head title={title} description={description} noindex={noindex} image={image} />
      <body className={bodyClass}>
        <a className="skip" href="#main">{c.t('nav.skip')}</a>
        {banner && <div className="site-banner">{banner}</div>}
        {children}
        <div id="feed" className="feed" aria-live="polite" />
        <div id="install-banner" className="install-banner" hidden />
        <div id="cookie-banner" className="cookie-banner" role="dialog" aria-live="polite" hidden />
        <Boot withFeed={feed} />
        <script src={`/app.js?v=${ASSET_V}`} defer />
      </body>
    </html>
  );
}

export function PublicLayout({ title, description, children, noindex, image }: { title: string; description?: string; children: ReactNode; noindex?: boolean; image?: string }) {
  const c = useC();
  const showCircles = circlesMode() !== 'off';
  const nav = [
    ['/how-it-works', 'nav.how'], ['/lots', 'nav.lots'], ...(showCircles ? [['/circles', 'nav.circles']] : []), ['/prices', 'nav.prices'],
    ['/why-kitovu', 'nav.why'], ['/chronicles', 'nav.blog'], ['/faqs', 'nav.faqs'],
  ];
  return (
    <Html title={title} description={description} noindex={noindex} image={image}>
      <header className="site-header">
        <div className="container header-row">
          <a href="/" className="brand"><Logo /></a>
          <nav className="main-nav" aria-label="Main">
            {nav.map(([href, k]) => <a key={href} href={href} aria-current={c.path.startsWith(href) ? 'page' : undefined}>{c.t(k)}</a>)}
          </nav>
          <div className="header-actions">
            <LangMenu />
            {c.user && !c.pending2fa
              ? <a className="btn btn-gold btn-sm" href={c.isAdmin ? '/admin' : '/app'}>{c.t('nav.dashboard')}</a>
              : <>
                  <a className="nav-login" href="/login">{c.t('nav.login')}</a>
                  <a className="btn btn-gold btn-sm hide-sm" href="/signup">{c.t('nav.signup')}</a>
                </>}
            <details className="menu mnav">
              <summary aria-label={c.t('nav.menu')}><LuMenu aria-hidden /></summary>
              <ul>
                {nav.map(([href, k]) => <li key={href}><a href={href}>{c.t(k)}</a></li>)}
                <li><a href="/contact">{c.t('nav.contact')}</a></li>
                <li><a href="/install"><LuDownload aria-hidden /> {c.t('nav.install')}</a></li>
                {!c.user && <li><a href="/signup" className="btn btn-primary btn-block">{c.t('nav.signup')}</a></li>}
              </ul>
            </details>
          </div>
        </div>
      </header>
      <main id="main"><Flash />{children}</main>
      <footer className="site-footer">
        <div className="container footer-grid">
          <div>
            <Logo />
            <p>{c.t('footer.about')}</p>
            <p className="small">{c.t('footer.address')}</p>
            <Social />
          </div>
          <div>
            <h4>{c.t('footer.explore')}</h4>
            <ul>
              {nav.map(([href, k]) => <li key={href}><a href={href}>{c.t(k)}</a></li>)}
              <li><a href="/calculator">{c.t('calc.h')}</a></li>
              <li><a href="/contact">{c.t('nav.contact')}</a></li>
              <li><a href="/install">{c.t('nav.install')}</a></li>
            </ul>
          </div>
          <div>
            <h4>{c.t('footer.legal')}</h4>
            <ul>
              <li><a href="/legal/terms">{c.t('footer.terms')}</a></li>
              <li><a href="/legal/privacy">{c.t('footer.privacy')}</a></li>
              <li><a href="/legal/risk">{c.t('footer.risk')}</a></li>
              <li><a href="/legal/cookies">{c.t('footer.cookies')}</a></li>
              <li><button type="button" className="linklike footer-link" data-cookie-settings>{c.t('footer.cookie_settings')}</button></li>
            </ul>
          </div>
          <div>
            <h4>{c.t('footer.newsletter_title')}</h4>
            <p className="small">{c.t('footer.newsletter_sub')}</p>
            <form method="post" action="/newsletter" className="inline-form">
              <Csrf />
              <label className="sr-only" htmlFor="nl-email">{c.t('footer.email_ph')}</label>
              <input id="nl-email" type="email" name="email" required placeholder={c.t('footer.email_ph')} autoComplete="email" />
              <button className="btn btn-gold" type="submit">{c.t('footer.subscribe')}</button>
            </form>
          </div>
        </div>
        <div className="container footer-base">
          <p className="small">{c.t('footer.risk_note')}</p>
          <p className="small">{c.t('footer.copyright', { year: new Date().getFullYear() })}</p>
        </div>
      </footer>
      <Ticker />
    </Html>
  );
}

const APP_NAV: [string, string, any][] = [
  ['/app', 'app.nav.home', LuHouse], ['/app/lots', 'app.nav.lots', LuWheat], ['/app/market', 'app.nav.market', LuArrowLeftRight], ['/app/trades', 'app.nav.trades', LuReceipt],
  ['/app/circles', 'app.nav.circles', LuUsersRound], ['/app/plans', 'app.nav.plans', LuPiggyBank], ['/app/gifts', 'app.nav.gifts', LuHeartHandshake], ['/app/wallet', 'app.nav.wallet', LuWallet], ['/app/referrals', 'app.nav.refer', LuGift],
  ['/app/profile', 'app.nav.profile', LuUser], ['/app/security', 'app.nav.security', LuLock], ['/app/support', 'app.nav.support', LuLifeBuoy],
];

export function AppLayout({ title, children }: { title: string; children: ReactNode }) {
  const c = useC();
  const u = c.user!;
  const unread = Number(q.val('SELECT COUNT(*) FROM notifications WHERE user_id=? AND read_at IS NULL', u.id) ?? 0);
  const st = settings();
  const nav = APP_NAV.filter(([href]) => (href !== '/app/market' || marketOn()) && (href !== '/app/circles' || circlesVisibleTo(u)) && (href !== '/app/plans' || st.plans_enabled) && (href !== '/app/gifts' || st.gifts_enabled));
  const isActive = (href: string) => (href === '/app' ? c.path === '/app' : c.path.startsWith(href));
  return (
    <Html title={title} noindex bodyClass="app-body">
      <header className="app-header">
        <div className="header-row app-header-row">
          <a href="/app" className="brand"><Logo /></a>
          <div className="header-actions">
            <a href="/app/wallet" className="wallet-pill"><LuWallet aria-hidden /> <Money kobo={walletBalance(u.id)} /></a>
            <a href="/app/notifications" className="icon-btn" aria-label={c.t('app.nav.notifications')}><LuBell aria-hidden />{unread > 0 && <span className="badge">{unread > 9 ? '9+' : unread}</span>}</a>
            <LangMenu />
            <details className="menu user-menu">
              <summary aria-label={u.first_name}><span className="avatar">{u.first_name[0]}{u.last_name[0]}</span></summary>
              <ul>
                <li className="muted small">{u.email}</li>
                {nav.slice(6).map(([href, k, I]) => <li key={href}><a href={href}><I aria-hidden /> {c.t(k)}</a></li>)}
                {c.isAdmin && <li><a href="/admin"><LuSettings aria-hidden /> {c.t('app.nav.admin')}</a></li>}
                <li><a href="/"><LuArrowLeft aria-hidden /> {c.t('app.nav.site')}</a></li>
                <li><form method="post" action="/logout"><Csrf /><button className="linklike" type="submit"><LuLogOut aria-hidden /> {c.t('nav.logout')}</button></form></li>
              </ul>
            </details>
          </div>
        </div>
      </header>
      <div className="app-shell">
        <nav className="app-side" aria-label="Dashboard">
          {nav.map(([href, k, I]) => <a key={href} href={href} aria-current={isActive(href) ? 'page' : undefined}><I aria-hidden /> {c.t(k)}</a>)}
          {c.isAdmin && <a href="/admin"><LuSettings aria-hidden /> {c.t('app.nav.admin')}</a>}
          <a href="/install" className="muted"><LuDownload aria-hidden /> {c.t('nav.install')}</a>
          <a href="/" className="muted"><LuArrowLeft aria-hidden /> {c.t('app.nav.site')}</a>
        </nav>
        <main id="main" className="app-main">
          {simulated() && <div className="demo-banner">{c.t('app.demo_banner')}</div>}
          {!u.email_verified_at && <div className="flash flash-info">{c.t('app.verify_email_banner')} <a href="/verify-email">{c.t('auth.verify_email_title')}</a></div>}
          <Flash />
          {children}
        </main>
      </div>
      <nav className="tabbar" aria-label="Dashboard">
        {[nav[0], nav[1], nav[2], nav.find((n) => n[0] === '/app/wallet')!, nav.find((n) => n[0] === '/app/profile')!].map(([href, k, I]) => (
          <a key={href} href={href} aria-current={isActive(href) ? 'page' : undefined}><I aria-hidden /><span>{c.t(k)}</span></a>
        ))}
      </nav>
      <Ticker />
    </Html>
  );
}

export const ADMIN_NAV: [string, string, string][] = [
  ['/admin', 'Overview', 'any'], ['/admin/lots', 'Trade Lots', 'operations'], ['/admin/trail', 'Harvest Trail', 'operations'],
  ['/admin/treasury', 'Treasury', 'finance'], ['/admin/payouts', 'Payouts', 'finance'], ['/admin/plans', 'Plans & gifts', 'finance'], ['/admin/withdrawals', 'Withdrawals', 'finance'], ['/admin/ledger', 'Wallets & ledger', 'finance'],
  ['/admin/champions', 'Champions', 'support'], ['/admin/verification', 'Verification', 'support'], ['/admin/circles', 'Harvest Circles', 'operations'], ['/admin/marketplace', 'Marketplace', 'operations'],
  ['/admin/prices', 'Prices', 'operations'], ['/admin/feed', 'Activity feed', 'content'], ['/admin/posts', 'Chronicles (blog)', 'content'],
  ['/admin/figures', 'Homepage numbers', 'content'], ['/admin/faqs', 'FAQs & page text', 'content'], ['/admin/newsletter', 'Newsletter', 'content'], ['/admin/referrals', 'Referrals', 'finance'],
  ['/admin/messages', 'Messages & tickets', 'support'], ['/admin/agents', 'AI agents', 'any'], ['/admin/marketing', 'Marketing', 'content'], ['/admin/prospects', 'Prospects', 'content'], ['/admin/whatsapp', 'WhatsApp', 'support'], ['/admin/reports', 'Reports', 'finance'], ['/admin/team', 'Team & roles', 'super'],
  ['/admin/audit', 'Audit log', 'super'], ['/admin/testing', 'Testing', 'super'], ['/admin/settings', 'Settings', 'super'],
];

export function AdminLayout({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  const c = useC();
  return (
    <html lang="en" dir="ltr">
      <Head title={`Admin · ${title}`} noindex />
      <body className="admin-body">
        <header className="admin-header">
          <a href="/admin" className="brand"><Logo /> <span className="admin-tag">Admin</span></a>
          <div className="header-actions">
            {config.paystackDemo && <a href="/admin/testing" className="tag tag-terra">{simulated() ? 'Test mode: payments simulated' : 'Payments not connected'}</a>}
            <a href="/" className="small">View website</a>
            <a href="/app" className="small">Champion view</a>
            <span className="small muted">{c.user!.first_name} · {c.user!.admin_roles}</span>
            <form method="post" action="/logout"><Csrf /><button className="btn btn-ghost btn-sm" type="submit">Log out</button></form>
          </div>
        </header>
        <div className="admin-shell">
          <details className="admin-nav-wrap" open>
            <summary>Menu</summary>
            <nav className="admin-nav">
              {ADMIN_NAV.filter(([, , p]) => p === 'any' || c.can(p)).map(([href, label]) => (
                <a key={href} href={href} aria-current={(href === '/admin' ? c.path === '/admin' : c.path.startsWith(href)) ? 'page' : undefined}>{label}</a>
              ))}
            </nav>
          </details>
          <main id="main" className="admin-main">
            <div className="admin-title"><h1>{title}</h1>{actions && <div className="admin-actions">{actions}</div>}</div>
            <Flash />
            {children}
          </main>
        </div>
        <Boot withFeed={false} />
        <script src={`/app.js?v=${ASSET_V}`} defer />
      </body>
    </html>
  );
}

/** Minimal centered layout for auth pages. */
export function AuthLayout({ title, children }: { title: string; children: ReactNode }) {
  const c = useC();
  return (
    <Html title={title} noindex bodyClass="auth-body" feed={false}>
      <header className="auth-header"><div className="container header-row"><a href="/" className="brand"><Logo /></a><LangMenu /></div></header>
      <main id="main" className="auth-main"><div className="auth-card"><Flash />{children}</div></main>
    </Html>
  );
}

