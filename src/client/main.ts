// Small progressive enhancements. Every page works without this script.
type Boot = {
  lang: string; csrf: string; feed: boolean; vapid: string | null; loggedIn: boolean; assistant?: boolean;
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
  // data-rates = {"4":2000,"6":2250,...} (basis points by months); falls back to one rate
  let rates: Record<string, number> = {};
  try { rates = JSON.parse(root.dataset.rates || '{}'); } catch {}
  const rateOf = (m: number) => Number(rates[String(m)] || root.dataset.rate || 2000);
  const amt = $<HTMLInputElement>('[data-calc-amount]', root)!;
  const tpl = (document.getElementById('calc-by-tpl') as HTMLTemplateElement | null)?.innerHTML || '{date}';
  const update = () => {
    const k = parseAmount(amt.value);
    const m = Number(($<HTMLInputElement>('[data-calc-period]:checked', root) || { value: '12' }).value);
    const e = earnings(k, rateOf(m), m);
    $('[data-calc-earn]', root)!.textContent = fmt(e);
    const rateEl = $('[data-calc-rate]', root); if (rateEl) rateEl.textContent = String(rateOf(m) / 100);
    $('[data-calc-total]', root)!.textContent = fmt(k + e);
    const d = new Date(); d.setMonth(d.getMonth() + m);
    $('[data-calc-by]', root)!.textContent = tpl.replace('{date}', d.toLocaleDateString(document.documentElement.lang, { day: 'numeric', month: 'short', year: 'numeric' }));
  };
  amt.addEventListener('input', update);
  amt.addEventListener('blur', () => { const k = parseAmount(amt.value); if (k) amt.value = (k / 100).toLocaleString('en'); });
  $$('[data-calc-period]', root).forEach((r) => r.addEventListener('change', update));
});
$$<HTMLFormElement>('[data-join]').forEach((f) => {
  const inp = $<HTMLInputElement>('input[name=amount]', f)!;
  const update = () => {
    const sel = $<HTMLInputElement>('input[name=months]:checked', f);
    const m = Number(sel?.value || f.dataset.months || 12), bps = Number(sel?.dataset.rate || f.dataset.rate || 2000);
    $('[data-join-earn]', f)!.textContent = fmt(earnings(parseAmount(inp.value), bps, m));
    const dEl = $('[data-join-date]', f);
    if (dEl) { const d = new Date(); d.setMonth(d.getMonth() + m); dEl.textContent = String(dEl.dataset.tpl || '{date}').replace('{date}', d.toLocaleDateString(document.documentElement.lang, { day: 'numeric', month: 'short', year: 'numeric' })); }
  };
  inp.addEventListener('input', update);
  $$('input[name=months]', f).forEach((r) => r.addEventListener('change', update));
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
  const say = (t: string, bad = false) => { if (status) { status.textContent = t; status.classList.toggle('error', bad); } };
  if (!('PushManager' in window) || !('serviceWorker' in navigator) || !('Notification' in window) || !boot.vapid) { pushBtn.disabled = true; say(boot.s.pushNo); }
  else if (Notification.permission === 'denied') say(boot.s.pushBlocked, true);
  pushBtn.addEventListener('click', async () => {
    pushBtn.disabled = true;
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { say(boot.s.pushBlocked, true); return; }
      const reg = (await navigator.serviceWorker.getRegistration()) || (await navigator.serviceWorker.register('/sw.js'));
      await navigator.serviceWorker.ready;
      const key = Uint8Array.from(atob(boot.vapid!.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((boot.vapid!.length + 3) % 4)), (ch) => ch.charCodeAt(0));
      // A subscription made with an older key cannot be reused: replace it.
      const old = await reg.pushManager.getSubscription();
      if (old) await old.unsubscribe().catch(() => false);
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const r = await fetch('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrf }, body: JSON.stringify(sub) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) say(boot.s.pushOn); else say(`${boot.s.pushFail}${j.error ? ` (${j.error})` : ''}`, true);
    } catch (e) { say(`${boot.s.pushFail} (${(e as Error)?.name || 'error'})`, true); }
    finally { pushBtn.disabled = false; }
  });
}

// ---------- Cookie consent (NDPA / NDP GAID: opt-in before non-essential cookies) ----------
function getConsent(): string | null { const m = document.cookie.match(/(?:^|; )ct_consent=(all|essential)/); return m ? m[1] : null; }
function setConsent(v: 'all' | 'essential') {
  document.cookie = `ct_consent=${v}; Path=/; Max-Age=${365 * 86400}; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
}
let tawkLoaded = false;
let tawkReady = false;
const tawkWanted = () => { try { return sessionStorage.getItem('ct-tawk') === '1'; } catch { return false; } };
function loadTawk() {
  if (!boot.tawk || tawkLoaded) return;
  tawkLoaded = true;
  const w = window as any;
  w.Tawk_API = w.Tawk_API || {};
  w.Tawk_LoadStart = new Date();
  if (boot.tawk.email) w.Tawk_API.visitor = { name: boot.tawk.name, email: boot.tawk.email, ...(boot.tawk.hash ? { hash: boot.tawk.hash } : {}) };
  // With the assistant on, the Tawk.to bubble stays hidden until the visitor asks for a person.
  w.Tawk_API.onLoad = () => { tawkReady = true; if (boot.assistant && !tawkWanted()) w.Tawk_API.hideWidget?.(); };
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

// Admin lot form: show the title, code and description that will be generated while those fields are blank.
$$<HTMLElement>('[data-lot-form]').forEach((root) => {
  const prefixes: Record<string, string> = JSON.parse(root.dataset.prefixes || '{}');
  const el = (n: string) => root.querySelector<HTMLInputElement>(`[name="${n}"]`);
  const art = (b: string) => { b = b.trim(); if (!b) return ''; const l = /^[A-Z][a-z]/.test(b) ? b[0].toLowerCase() + b.slice(1) : b; const an = /^[A-Z]{2}/.test(b) ? /^[AEFHILMNORSX]/.test(b) : /^[aeiou]/i.test(l); return `${an ? 'an' : 'a'} ${l}`; };
  const update = () => {
    const sel = el('commodity') as unknown as HTMLSelectElement | null;
    const name = sel?.selectedOptions[0]?.textContent || '';
    const region = el('region')?.value.trim() || '', buyer = el('buyer_type')?.value.trim() || '';
    const tons = Number(el('tonnage')?.value) || 0, farmers = Number(el('farmers')?.value) || 0;
    const d = new Date(el('closes_at')?.value || Date.now());
    const title = region ? `${name} from ${region}` : buyer ? `${name} for ${art(buyer)}` : name;
    const code = `${prefixes[sel?.value || ''] || 'XX'}-${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const desc = `${name} bought from ${farmers > 0 ? `${farmers.toLocaleString('en')} farmers` : 'farmers'}${region ? ` in ${region}` : ''} to fill a signed order${buyer ? ` from ${art(buyer)}` : ''}.${tons > 0 ? ` ${tons.toLocaleString('en')} tons.` : ''}`;
    const t = el('title'), c = el('code'), ds = root.querySelector<HTMLTextAreaElement>('[name="description"]');
    if (t) t.placeholder = title; if (c) c.placeholder = `${code} (or the next free number)`; if (ds) ds.placeholder = desc;
  };
  root.addEventListener('input', update); root.addEventListener('change', update); update();
});

// Admin: selects marked data-autosubmit save as soon as they change.
$$<HTMLSelectElement>('select[data-autosubmit]').forEach((sel) => sel.addEventListener('change', () => sel.form?.requestSubmit()));

// Dashboard tip to add an authenticator: "Later" hides it for 14 days on this device.
$$<HTMLElement>('[data-secure-tip]').forEach((tip) => {
  try { if (Number(localStorage.getItem('ct-secure-later') || 0) > Date.now() - 14 * 864e5) tip.hidden = true; } catch {}
  tip.querySelector('[data-secure-later]')?.addEventListener('click', () => { tip.hidden = true; try { localStorage.setItem('ct-secure-later', String(Date.now())); } catch {} });
});

// Marketplace: live "you receive" while choosing units/discount, and live total while choosing units to buy.
$$<HTMLFormElement>('form[data-sell]').forEach((f) => {
  const unitValue = Number(f.dataset.unitValue) || 0, fee = Number(f.dataset.fee) || 0;
  const out = f.querySelector<HTMLElement>('[data-sell-get]');
  const upd = () => {
    const n = Math.max(1, Number((f.elements.namedItem('units') as HTMLInputElement)?.value) || 1);
    const d = Math.max(0, Number((f.elements.namedItem('discount') as HTMLInputElement)?.value) || 0);
    const price = unitValue * n * (1 - d / 100);
    if (out) out.textContent = fmt(Math.round(price * (1 - fee / 100)));
  };
  f.addEventListener('input', upd); upd();
});
$$<HTMLFormElement>('form[data-buy]').forEach((f) => {
  const unit = Number(f.dataset.unitPrice) || 0;
  const out = f.querySelector<HTMLElement>('[data-buy-total]');
  f.addEventListener('input', () => { const n = Math.max(1, Number((f.elements.namedItem('units') as HTMLInputElement)?.value) || 1); if (out) out.textContent = fmt(unit * n); });
});

// Show/hide password: an eye button inside every password box.
$$<HTMLInputElement>('input[type="password"]').forEach((inp) => {
  if (inp.dataset.eye) return; inp.dataset.eye = '1';
  const wrap = document.createElement('span'); wrap.className = 'pw-wrap';
  inp.parentNode?.insertBefore(wrap, inp); wrap.appendChild(inp);
  const b = document.createElement('button'); b.type = 'button'; b.className = 'pw-eye';
  const eye = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const shut = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.9 17.9A10.4 10.4 0 0 1 12 19c-6.5 0-10-7-10-7a18.5 18.5 0 0 1 5.1-5.9M9.9 4.2A9.6 9.6 0 0 1 12 4c6.5 0 10 7 10 7a18.6 18.6 0 0 1-2.2 3.2M14.1 14.1a3 3 0 1 1-4.2-4.2"/><path d="M2 2l20 20"/></svg>';
  const set = (shown: boolean) => { inp.type = shown ? 'text' : 'password'; b.innerHTML = shown ? shut : eye; b.setAttribute('aria-label', shown ? boot.s.pwHide || 'Hide password' : boot.s.pwShow || 'Show password'); b.setAttribute('aria-pressed', String(shown)); b.title = b.getAttribute('aria-label') || ''; };
  b.addEventListener('click', () => { set(inp.type === 'password'); inp.focus(); });
  // Hide again before the form is sent, so the browser's password manager still recognises it.
  inp.form?.addEventListener('submit', () => set(false));
  set(false); wrap.appendChild(b);
});

// "Email me a code": send without leaving the page, keep what was typed, and move to the code box.
$$<HTMLButtonElement>('[data-send-code]').forEach((b) => b.addEventListener('click', async (e) => {
  e.preventDefault();
  const msg = b.closest('.code-field')?.querySelector<HTMLElement>('[data-code-msg]');
  b.disabled = true;
  try {
    const body = new URLSearchParams({ purpose: b.dataset.sendCode || 'withdraw', _csrf: boot.csrf });
    const r = await fetch('/app/code', { method: 'POST', body, headers: { 'X-Requested-With': 'fetch', 'X-CSRF-Token': boot.csrf } });
    const j = await r.json().catch(() => ({ message: '' }));
    if (msg) { msg.textContent = j.message || ''; msg.classList.toggle('error', !r.ok); }
    b.closest('.code-field')?.querySelector<HTMLInputElement>('input[name=code]')?.focus();
  } catch { if (msg) msg.textContent = boot.s.close || ''; }
  setTimeout(() => { b.disabled = false; }, 20000); // one new code at most every 20 seconds
}));

// ---------- "Ask ComboTrader" assistant ----------
const assist = $('#assist');
if (assist && boot.assistant) {
  assist.hidden = false;
  const panel = $('#assist-panel', assist)!, fab = $<HTMLButtonElement>('[data-assist-open]', assist)!;
  const log = $('[data-assist-log]', assist)!, form = $<HTMLFormElement>('[data-assist-form]', assist)!;
  const personBox = $('[data-assist-person]', assist)!, personForm = $<HTMLFormElement>('[data-assist-person-form]', assist)!;
  const store = { get: (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch { /* private mode */ } } };
  let token = store.get('ct-chat') || '';
  let history: [string, string][] = [];
  try { history = JSON.parse(store.get('ct-chat-log') || '[]'); } catch { history = []; }
  const add = (who: 'me' | 'bot' | 'note', text: string, save = true) => {
    const li = document.createElement('li');
    li.className = `assist-msg ${who}`;
    // Plain text; web addresses become links.
    for (const part of text.split(/(https?:\/\/[^\s)]+)/)) {
      if (/^https?:\/\//.test(part)) { const a = document.createElement('a'); a.href = part; a.textContent = part.replace(/^https?:\/\/(www\.)?/, ''); a.rel = 'noopener'; if (!part.startsWith(location.origin)) a.target = '_blank'; li.append(a); }
      else li.append(document.createTextNode(part));
    }
    log.append(li); log.scrollTop = log.scrollHeight;
    if (save) { history.push([who, text]); store.set('ct-chat-log', JSON.stringify(history.slice(-40))); }
    return li;
  };
  for (const [who, text] of history) add(who as 'me', text, false);
  const open = (on: boolean) => { panel.hidden = !on; fab.setAttribute('aria-expanded', String(on)); assist.classList.toggle('open', on); if (on) (form.elements.namedItem('message') as HTMLInputElement).focus(); store.set('ct-chat-open', on ? '1' : ''); };
  fab.addEventListener('click', () => open(panel.hidden));
  $('[data-assist-close]', assist)?.addEventListener('click', () => open(false));
  if (store.get('ct-chat-open') === '1' && history.length) open(true);
  const post = async (url: string, data: Record<string, string>) => {
    const r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrf }, body: JSON.stringify(data) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || boot.s.chatError);
    return j;
  };
  const askPerson = async () => {
    const w = window as any;
    if (boot.tawk && getConsent() === 'all') {
      store.set('ct-tawk', '1');
      add('note', boot.s.chatLive);
      if (token) post('/api/assistant/handover', { token, via: 'tawk' }).catch(() => {});
      loadTawk();
      const show = () => { try { w.Tawk_API.showWidget(); w.Tawk_API.maximize(); open(false); } catch { /* not ready */ } };
      if (tawkReady) show(); else { const t0 = Date.now(); const iv = setInterval(() => { if (tawkReady || Date.now() - t0 > 15000) { clearInterval(iv); if (tawkReady) show(); else { personBox.hidden = false; form.hidden = true; } } }, 300); }
      return;
    }
    personBox.hidden = false; form.hidden = true;
    (personForm.elements.namedItem(boot.loggedIn ? 'note' : 'email') as HTMLInputElement)?.focus();
  };
  $('[data-assist-person-btn]', assist)?.addEventListener('click', askPerson);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = form.elements.namedItem('message') as HTMLInputElement;
    const text = input.value.trim();
    if (!text) return;
    input.value = ''; add('me', text);
    const wait = add('bot', boot.s.chatThinking, false); wait.classList.add('wait');
    const btn = form.querySelector('button')!; btn.disabled = true;
    try {
      const j = await post('/api/assistant', { message: text, token, page: location.pathname });
      token = j.token || token; store.set('ct-chat', token);
      wait.remove(); add('bot', j.reply);
      if (j.person) { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-ghost btn-sm assist-cta'; b.textContent = (assist.querySelector('[data-assist-person-btn]') as HTMLElement).textContent || ''; b.onclick = askPerson; log.lastElementChild?.append(document.createElement('br'), b); }
    } catch (err) { wait.remove(); add('note', (err as Error).message || boot.s.chatError, false); }
    finally { btn.disabled = false; input.focus(); }
  });
  personForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(personForm);
    const data: Record<string, string> = { via: 'message' };
    fd.forEach((v, k) => { data[k] = String(v); });
    try {
      if (!token) { const j = await post('/api/assistant', { message: data.note || '(asked for a person)', token, page: location.pathname }); token = j.token; store.set('ct-chat', token); }
      const j = await post('/api/assistant/handover', { ...data, token });
      personBox.hidden = true; form.hidden = false; personForm.reset(); add('note', j.message);
    } catch (err) { add('note', (err as Error).message, false); }
  });
}
