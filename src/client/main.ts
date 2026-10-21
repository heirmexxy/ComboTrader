// Small progressive enhancements. Every page works without this script.
type Boot = {
  lang: string; csrf: string; feed: boolean; vapid: string | null; loggedIn: boolean;
  tawk: { property: string; widget: string; name?: string; email?: string; hash?: string } | null;
  s: Record<string, string>;
};
const boot: Boot = JSON.parse(document.getElementById('boot')?.textContent || '{}');
const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T | null;
const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => Array.from(root.querySelectorAll(sel)) as T[];
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const fmt = (kobo: number) => '₦' + Math.round(kobo / 100).toLocaleString('en');

// ---------- Service worker (install-as-app, offline page) ----------
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));

// ---------- Install prompt ----------
let deferred: any = null;
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent);
function dismissed() { try { return Number(localStorage.getItem('ct-install-dismissed') || 0) > Date.now() - 14 * 864e5; } catch { return false; } }
function showBanner(ios: boolean) {
  const b = $('#install-banner');
  if (!b || dismissed() || isStandalone() || !/(?:^|; )ct_consent=/.test(document.cookie)) return;
  b.innerHTML = '';
  const p = document.createElement('p');
  p.textContent = ios ? `${boot.s.install} ${boot.s.ios1} ${boot.s.ios2}` : boot.s.install;
  b.append(p);
  const actions = document.createElement('div');
  if (!ios) {
    const yes = document.createElement('button');
    yes.className = 'btn btn-gold btn-sm'; yes.textContent = boot.s.installBtn;
    yes.onclick = async () => { b.hidden = true; deferred?.prompt(); await deferred?.userChoice; deferred = null; };
    actions.append(yes);
  }
  const no = document.createElement('button');
  no.className = 'btn btn-ghost btn-sm'; no.textContent = boot.s.later;
  no.onclick = () => { b.hidden = true; try { localStorage.setItem('ct-install-dismissed', String(Date.now())); } catch {} };
  actions.append(no);
  b.append(actions);
  b.hidden = false;
}
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred = e;
  $$('[data-install]').forEach((btn) => { btn.hidden = false; });
  if (boot.loggedIn || location.pathname === '/') setTimeout(() => showBanner(false), 15000);
});
window.addEventListener('appinstalled', () => { $$('[data-installed]').forEach((x) => (x.hidden = false)); $$('[data-install]').forEach((x) => (x.hidden = true)); });
$$('[data-install]').forEach((btn) => btn.addEventListener('click', async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; btn.hidden = true; }));
if (isStandalone()) $$('[data-installed]').forEach((x) => (x.hidden = false));
if (isIos && !isStandalone() && boot.loggedIn) setTimeout(() => showBanner(true), 20000);

// ---------- Ticker pause ----------
const tick = $('.ticker');
const tBtn = $<HTMLButtonElement>('[data-ticker-toggle]');
if (tick && tBtn) {
  if (reduceMotion) tick.classList.add('paused');
  tBtn.addEventListener('click', () => {
    const p = tick.classList.toggle('paused');
    tBtn.setAttribute('aria-label', p ? boot.s.play : boot.s.pause);
    tBtn.innerHTML = p ? '▶' : '❚❚';
  });
}

// ---------- Live activity feed (real events only, shown at natural, uneven gaps) ----------
async function startFeed() {
  const box = $('#feed');
  if (!box || !boot.feed) return;
  let data: { items: { id: number; text: string; ago: string }[]; totals: string | null };
  try { data = await (await fetch('/api/feed', { credentials: 'same-origin' })).json(); } catch { return; }
  let seen: number[] = [];
  try { seen = JSON.parse(sessionStorage.getItem('ct-feed-seen') || '[]'); } catch {}
  const queue = data.items.filter((i) => !seen.includes(i.id)).slice(0, 6);
  let shownTotals = false;
  const show = (text: string, ago?: string) => {
    box.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'feed-card';
    const t = document.createElement('p'); t.textContent = text; card.append(t);
    if (ago) { const a = document.createElement('small'); a.textContent = ago; card.append(a); }
    const x = document.createElement('button'); x.type = 'button'; x.className = 'feed-x'; x.setAttribute('aria-label', boot.s.close); x.textContent = '×';
    x.onclick = () => { box.innerHTML = ''; try { sessionStorage.setItem('ct-feed-off', '1'); } catch {} };
    card.append(x);
    box.append(card);
    setTimeout(() => card.classList.add('out'), 6500);
    setTimeout(() => { if (box.contains(card)) box.innerHTML = ''; }, 7200);
  };
  const next = () => {
    try { if (sessionStorage.getItem('ct-feed-off')) return; } catch {}
    const item = queue.shift();
    if (item) {
      show(item.text, item.ago);
      seen.push(item.id);
      try { sessionStorage.setItem('ct-feed-seen', JSON.stringify(seen.slice(-50))); } catch {}
    } else if (!shownTotals && data.totals) { shownTotals = true; show(data.totals); }
    else return;
    setTimeout(next, 18000 + Math.random() * 42000);
  };
  setTimeout(next, 9000 + Math.random() * 12000);
}
if (getConsentEarly()) startFeed(); else document.addEventListener('ct-consent', () => startFeed(), { once: true });
function getConsentEarly() { return /(?:^|; )ct_consent=(all|essential)/.test(document.cookie) || location.pathname.startsWith('/admin'); }

// ---------- Earnings calculator ----------
function parseAmount(s: string) { return Math.round(Number(String(s).replace(/[^\d.]/g, '')) * 100) || 0; }
function earnings(kobo: number, bps: number, months: number) { return Math.round((kobo * bps * months) / 120000); }
$$('[data-calc]').forEach((root) => {
  const bps = Number(root.dataset.rate || 2000);
  const amt = $<HTMLInputElement>('[data-calc-amount]', root)!;
  const tpl = (document.getElementById('calc-by-tpl') as HTMLTemplateElement | null)?.innerHTML || '{date}';
  const update = () => {
    const k = parseAmount(amt.value);
    const m = Number(($<HTMLInputElement>('[data-calc-period]:checked', root) || { value: '12' }).value);
    const e = earnings(k, bps, m);
    $('[data-calc-earn]', root)!.textContent = fmt(e);
    $('[data-calc-total]', root)!.textContent = fmt(k + e);
    const d = new Date(); d.setMonth(d.getMonth() + m);
    $('[data-calc-by]', root)!.textContent = tpl.replace('{date}', d.toLocaleDateString(document.documentElement.lang, { day: 'numeric', month: 'short', year: 'numeric' }));
  };
  amt.addEventListener('input', update);
  amt.addEventListener('blur', () => { const k = parseAmount(amt.value); if (k) amt.value = (k / 100).toLocaleString('en'); });
  $$('[data-calc-period]', root).forEach((r) => r.addEventListener('change', update));
});
$$<HTMLFormElement>('[data-join]').forEach((f) => {
  const bps = Number(f.dataset.rate), m = Number(f.dataset.months);
  const inp = $<HTMLInputElement>('input[name=amount]', f)!;
  inp.addEventListener('input', () => { $('[data-join-earn]', f)!.textContent = fmt(earnings(parseAmount(inp.value), bps, m)); });
});
// Thousands separators while typing amounts
$$<HTMLInputElement>('input[name=amount][inputmode=numeric]').forEach((i) => i.addEventListener('blur', () => { const k = parseAmount(i.value); if (k) i.value = (k / 100).toLocaleString('en'); }));

// ---------- Copy & share ----------
$$('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(b.dataset.copy || ''); const old = b.textContent; b.textContent = boot.s.copied; setTimeout(() => (b.textContent = old), 1800); } catch {}
}));
$$('[data-share]').forEach((b) => {
  if (!navigator.share) { b.hidden = true; return; }
  b.addEventListener('click', async () => {
    const data: ShareData = { title: b.dataset.title, text: b.dataset.text, url: b.dataset.url };
    try {
      if (b.dataset.file && (navigator as any).canShare) {
        const blob = await (await fetch(b.dataset.file)).blob();
        const file = new File([blob], 'harvest-card.png', { type: 'image/png' });
        if ((navigator as any).canShare({ files: [file] })) (data as any).files = [file];
      }
      await navigator.share(data);
    } catch {}
  });
});

// ---------- Confirm dialogs on risky admin actions ----------
$$<HTMLFormElement>('form[data-confirm]').forEach((f) => f.addEventListener('submit', (e) => { if (!window.confirm(f.dataset.confirm || '')) e.preventDefault(); }));
$$<HTMLInputElement>('[data-check-all]').forEach((all) => all.addEventListener('change', () => {
  $$<HTMLInputElement>('input[type=checkbox][name="ids[]"]', all.closest('form') || document).forEach((x) => (x.checked = all.checked));
}));
// Close <details> menus when clicking elsewhere
document.addEventListener('click', (e) => {
  $$<HTMLDetailsElement>('details.menu[open]').forEach((d) => { if (!d.contains(e.target as Node)) d.open = false; });
});

// ---------- Welcome tour ----------
const tour = $('[data-tour]');
if (tour) $$('[data-tour-next]', tour).forEach((b) => b.addEventListener('click', () => {
  const cur = b.closest('[data-step]') as HTMLElement;
  const nxt = cur.nextElementSibling as HTMLElement | null;
  if (nxt?.dataset.step) { cur.hidden = true; nxt.hidden = false; nxt.querySelector('h1')?.setAttribute('tabindex', '-1'); (nxt.querySelector('h1') as HTMLElement)?.focus(); }
}));

// ---------- Push alerts ----------
const pushBtn = $<HTMLButtonElement>('[data-push]');
if (pushBtn) {
  const status = $('[data-push-status]');
  if (!('PushManager' in window) || !('serviceWorker' in navigator) || !boot.vapid) { pushBtn.disabled = true; if (status) status.textContent = boot.s.pushNo; }
  pushBtn.addEventListener('click', async () => {
    try {
      const reg = await navigator.serviceWorker.ready;
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return;
      const key = Uint8Array.from(atob(boot.vapid!.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((boot.vapid!.length + 3) % 4)), (ch) => ch.charCodeAt(0));
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await fetch('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrf }, body: JSON.stringify(sub) });
      if (status) status.textContent = boot.s.pushOn;
      pushBtn.disabled = true;
    } catch { if (status) status.textContent = boot.s.pushNo; }
  });
}

// ---------- Cookie consent (NDPA / NDP GAID: opt-in before non-essential cookies) ----------
function getConsent(): string | null { const m = document.cookie.match(/(?:^|; )ct_consent=(all|essential)/); return m ? m[1] : null; }
function setConsent(v: 'all' | 'essential') {
  document.cookie = `ct_consent=${v}; Path=/; Max-Age=${365 * 86400}; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
}
let tawkLoaded = false;
function loadTawk() {
  if (!boot.tawk || tawkLoaded) return;
  tawkLoaded = true;
  const w = window as any;
  w.Tawk_API = w.Tawk_API || {};
  w.Tawk_LoadStart = new Date();
  if (boot.tawk.email) w.Tawk_API.visitor = { name: boot.tawk.name, email: boot.tawk.email, ...(boot.tawk.hash ? { hash: boot.tawk.hash } : {}) };
  const s = document.createElement('script');
  s.async = true;
  s.src = `https://embed.tawk.to/${encodeURIComponent(boot.tawk.property)}/${encodeURIComponent(boot.tawk.widget)}`;
  s.charset = 'UTF-8';
  s.setAttribute('crossorigin', '*');
  document.body.append(s);
}
function showCookieBanner() {
  const b = $('#cookie-banner');
  if (!b) return;
  b.innerHTML = '';
  const p = document.createElement('p'); p.textContent = boot.s.cookieText + ' ';
  const a = document.createElement('a'); a.href = '/legal/cookies'; a.textContent = boot.s.cookieMore; p.append(a);
  const row = document.createElement('div');
  const yes = document.createElement('button'); yes.type = 'button'; yes.className = 'btn btn-gold btn-sm'; yes.textContent = boot.s.cookieAccept;
  const no = document.createElement('button'); no.type = 'button'; no.className = 'btn btn-ghost btn-sm'; no.textContent = boot.s.cookieEssential;
  yes.onclick = () => { setConsent('all'); b.hidden = true; loadTawk(); document.dispatchEvent(new Event('ct-consent')); };
  no.onclick = () => { const had = getConsent() === 'all'; setConsent('essential'); b.hidden = true; document.dispatchEvent(new Event('ct-consent')); if (had && tawkLoaded) location.reload(); };
  row.append(yes, no);
  b.append(p, row);
  b.hidden = false;
}
$$('[data-cookie-settings]').forEach((x) => x.addEventListener('click', showCookieBanner));
if (getConsent() === 'all') loadTawk();
else if (!getConsent() && !location.pathname.startsWith('/admin')) showCookieBanner();
