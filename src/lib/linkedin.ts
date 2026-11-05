// LinkedIn company page posting. An admin connects the page once in Admin → Marketing ("Connect LinkedIn");
// the access token is kept in settings and refreshed when LinkedIn provides a refresh token. Posting as a
// page needs LinkedIn's Community Management API (w_organization_social) on the app in LINKEDIN_CLIENT_ID.
import fs from 'node:fs';
import { config } from './config';
import { settings, setSetting } from './settings';
import { now } from './db';

export const LI_SCOPES = 'r_organization_social w_organization_social rw_organization_admin';
export const liRedirect = () => `${config.baseUrl}/admin/linkedin/callback`;

/** LinkedIn's API is versioned by month; use the one from two months ago unless LINKEDIN_VERSION is set. */
export function liVersion() {
  if (process.env.LINKEDIN_VERSION) return process.env.LINKEDIN_VERSION;
  const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 2);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface LiAuth { access_token: string; expires_at: string; refresh_token?: string; refresh_expires_at?: string; org?: string; org_name?: string; connected_at: string }
export function liAuth(): LiAuth | null {
  const v = settings().linkedin_auth as unknown;
  if (!v) return null;
  try { const a = typeof v === 'string' ? JSON.parse(v) : v; return a?.access_token ? a : null; } catch { return null; }
}
const saveAuth = (a: LiAuth | null) => setSetting('linkedin_auth', a ? JSON.stringify(a) : '');
export const liDisconnect = () => saveAuth(null);

export const liConfigured = () => !!(config.linkedinClientId && config.linkedinClientSecret);
/** A usable token and page: from the admin connection, or from LINKEDIN_TOKEN / LINKEDIN_ORG_URN. */
export function liReady() {
  const a = liAuth();
  if (a?.org && new Date(a.expires_at).getTime() > Date.now()) return true;
  return !!(config.linkedinToken && config.linkedinOrg);
}
export const liDaysLeft = () => { const a = liAuth(); return a ? Math.floor((new Date(a.expires_at).getTime() - Date.now()) / 864e5) : null; };

async function tokenRequest(params: Record<string, string>) {
  const res = await fetch('https://www.linkedin.com/oauth/v2/accessToken', { method: 'POST', signal: AbortSignal.timeout(30_000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, client_id: config.linkedinClientId, client_secret: config.linkedinClientSecret }) });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`LinkedIn sign-in failed: ${j.error_description || j.error || res.status}`);
  const t = Date.now();
  return { access_token: j.access_token, expires_at: new Date(t + (j.expires_in || 5184000) * 1000).toISOString(), refresh_token: j.refresh_token, refresh_expires_at: j.refresh_token_expires_in ? new Date(t + j.refresh_token_expires_in * 1000).toISOString() : undefined };
}

export function liAuthUrl(state: string) {
  return `https://www.linkedin.com/oauth/v2/authorization?${new URLSearchParams({ response_type: 'code', client_id: config.linkedinClientId, redirect_uri: liRedirect(), state, scope: LI_SCOPES })}`;
}
export async function liExchange(code: string) {
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: liRedirect() });
  saveAuth({ ...t, connected_at: now() });
  return t.access_token;
}

/** Current token, refreshed if it expires within 7 days and LinkedIn gave us a refresh token. */
export async function liToken() {
  const a = liAuth();
  if (!a) return config.linkedinToken || '';
  if (a.refresh_token && new Date(a.expires_at).getTime() - Date.now() < 7 * 864e5 && (!a.refresh_expires_at || new Date(a.refresh_expires_at).getTime() > Date.now())) {
    try { const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: a.refresh_token }); saveAuth({ ...a, ...t, refresh_token: t.refresh_token || a.refresh_token }); return t.access_token; } catch { /* fall back to the current token */ }
  }
  return a.access_token;
}
export const liOrg = () => liAuth()?.org || config.linkedinOrg;

async function li(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`https://api.linkedin.com/rest/${path}`, { method, signal: AbortSignal.timeout(60_000),
    headers: { Authorization: `Bearer ${token}`, 'LinkedIn-Version': liVersion(), 'X-Restli-Protocol-Version': '2.0.0', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`LinkedIn ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

/** Pages the connected member can post for (administrator or content admin). */
export async function liAdminPages(token: string) {
  const res = await li('GET', 'organizationAcls?q=roleAssignee&state=APPROVED', token);
  const j: any = await res.json();
  const ids = [...new Set<string>((j.elements || []).filter((e: any) => ['ADMINISTRATOR', 'CONTENT_ADMINISTRATOR', 'DIRECT_SPONSORED_CONTENT_POSTER'].includes(e.role)).map((e: any) => String(e.organization)))];
  const out: { urn: string; name: string }[] = [];
  for (const urn of ids.slice(0, 20)) {
    const id = urn.split(':').pop();
    try { const o: any = await (await li('GET', `organizations/${id}`, token)).json(); out.push({ urn, name: o.localizedName || o.vanityName || urn }); } catch { out.push({ urn, name: urn }); }
  }
  return out;
}
export function liChoosePage(urn: string, name: string) {
  const a = liAuth();
  if (!a) throw new Error('Connect LinkedIn first');
  saveAuth({ ...a, org: urn, org_name: name });
}

/** LinkedIn "little text" needs these characters escaped. */
const littleText = (s: string) => s.replace(/[\\(){}\[\]<>@|~_*#]/g, (m) => `\\${m}`);

/** Posts as the page, with the image when there is one. Returns the post URN. */
export async function liPost(text: string, imagePath: string | null) {
  const token = await liToken(), org = liOrg();
  if (!token || !org) throw new Error('LinkedIn is not connected');
  let media: string | null = null;
  if (imagePath && fs.existsSync(imagePath)) {
    const init: any = await (await li('POST', 'images?action=initializeUpload', token, { initializeUploadRequest: { owner: org } })).json();
    const up = await fetch(init.value.uploadUrl, { method: 'PUT', signal: AbortSignal.timeout(60_000), headers: { Authorization: `Bearer ${token}` }, body: fs.readFileSync(imagePath) });
    if (!up.ok) throw new Error(`LinkedIn image upload ${up.status}`);
    media = init.value.image;
  }
  const res = await li('POST', 'posts', token, {
    author: org, commentary: littleText(text), visibility: 'PUBLIC', lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false,
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    ...(media ? { content: { media: { id: media, altText: 'ComboTrader' } } } : {}),
  });
  return res.headers.get('x-restli-id') || 'ok';
}
