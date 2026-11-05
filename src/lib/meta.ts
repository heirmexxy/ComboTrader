// Facebook Page + Instagram connection. An admin clicks "Connect Facebook & Instagram" in Admin → Marketing,
// signs in with Facebook and picks the ComboTrader Page; we keep the Page token (it does not expire when it
// comes from a long-lived sign-in) and the linked Instagram professional account, and subscribe the Page
// to our webhook for comments, messages and lead forms. FACEBOOK_PAGE_ID / FACEBOOK_PAGE_TOKEN /
// INSTAGRAM_BUSINESS_ID in the server settings still work and take priority.
import { config } from './config';
import { settings, setSetting } from './settings';
import { now } from './db';

export const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v25.0';
export const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
export const META_SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_manage_metadata', 'pages_messaging', 'pages_read_user_content', 'pages_manage_engagement',
  'instagram_basic', 'instagram_content_publish', 'instagram_manage_comments', 'instagram_manage_messages', 'leads_retrieval', 'business_management'];
export const metaRedirect = () => `${config.baseUrl}/admin/meta/callback`;
export const metaConfigured = () => !!(config.metaAppId && config.metaAppSecret);

export interface MetaAuth { user_token?: string; page_id?: string; page_name?: string; page_token?: string; ig_id?: string; ig_username?: string; connected_at: string; subscribed?: boolean }
export function metaAuth(): MetaAuth | null {
  const v = settings().meta_auth as unknown;
  if (!v) return null;
  try { return typeof v === 'string' ? JSON.parse(v) : (v as MetaAuth); } catch { return null; }
}
const save = (a: MetaAuth | null) => setSetting('meta_auth', a ? JSON.stringify(a) : '');
export const metaDisconnect = () => save(null);

// What the rest of the platform uses: server settings first, then the admin connection.
export const fbPageId = () => config.fbPageId || metaAuth()?.page_id || '';
export const fbPageToken = () => config.fbPageToken || metaAuth()?.page_token || '';
export const igUserId = () => config.igUserId || metaAuth()?.ig_id || '';

async function gget(path: string, params: Record<string, string>) {
  const res = await fetch(`${GRAPH}/${path}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(30_000) });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(`Facebook: ${j?.error?.message || res.status}`);
  return j;
}

export function metaAuthUrl(state: string) {
  const p: Record<string, string> = { client_id: config.metaAppId, redirect_uri: metaRedirect(), state, response_type: 'code' };
  if (config.metaLoginConfigId) p.config_id = config.metaLoginConfigId; else p.scope = META_SCOPES.join(',');
  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${new URLSearchParams(p)}`;
}

/** Code → short token → long-lived token (about 60 days); Page tokens fetched with it do not expire. */
export async function metaExchange(code: string) {
  const short = await gget('oauth/access_token', { client_id: config.metaAppId, client_secret: config.metaAppSecret, redirect_uri: metaRedirect(), code });
  const long = await gget('oauth/access_token', { grant_type: 'fb_exchange_token', client_id: config.metaAppId, client_secret: config.metaAppSecret, fb_exchange_token: short.access_token });
  save({ ...(metaAuth() || {}), user_token: long.access_token, connected_at: now() });
  return long.access_token as string;
}

type MetaPage = { id: string; name: string; token: string; canPost: boolean; ig: { id: string; username: string } | null };
export async function metaPages(userToken = metaAuth()?.user_token || ''): Promise<MetaPage[]> {
  if (!userToken) throw new Error('Connect Facebook first');
  const fields = 'id,name,access_token,tasks,instagram_business_account{id,username}';
  const j = await gget('me/accounts', { access_token: userToken, fields, limit: '50' });
  let rows: any[] = j.data || [];
  // Pages held in a business portfolio don't always show in me/accounts: look there too.
  if (!rows.length) {
    try {
      const biz = await gget('me/businesses', { access_token: userToken, fields: 'id,name', limit: '25' });
      for (const b of biz.data || []) {
        for (const edge of ['owned_pages', 'client_pages']) {
          try { const r = await gget(`${b.id}/${edge}`, { access_token: userToken, fields, limit: '50' }); rows.push(...(r.data || [])); } catch { /* no access to this edge */ }
        }
      }
    } catch { /* business_management not granted */ }
    // A Page found through the business may not carry a token in the list: ask for it directly.
    for (const r of rows) if (!r.access_token) { try { const d = await gget(r.id, { access_token: userToken, fields: 'access_token,tasks' }); r.access_token = d.access_token; r.tasks = d.tasks || r.tasks || (d.access_token ? ['CREATE_CONTENT'] : []); } catch { /* no Page token */ } }
    const seen = new Set<string>(); rows = rows.filter((r) => !seen.has(String(r.id)) && seen.add(String(r.id)));
  }
  return rows.map((p: any) => ({ id: String(p.id), name: String(p.name), token: String(p.access_token || ''), canPost: !!p.access_token && ((p.tasks || []).includes('CREATE_CONTENT') || (p.tasks || []).includes('MANAGE')), ig: p.instagram_business_account ? { id: String(p.instagram_business_account.id), username: String(p.instagram_business_account.username || '') } : null })) as { id: string; name: string; token: string; canPost: boolean; ig: { id: string; username: string } | null }[];
}

/** Saves the Page (and its Instagram account) and subscribes the Page to our webhook. */
export async function metaChoosePage(pageId: string) {
  const a = metaAuth();
  const p = (await metaPages()).find((x) => x.id === pageId);
  if (!a || !p) throw new Error('That Page is not available to this Facebook account.');
  let subscribed = false;
  try {
    const res = await fetch(`${GRAPH}/${p.id}/subscribed_apps`, { method: 'POST', signal: AbortSignal.timeout(30_000), body: new URLSearchParams({ subscribed_fields: 'feed,messages,leadgen', access_token: p.token }) });
    subscribed = !!((await res.json().catch(() => ({}))) as any).success;
  } catch { /* comments and messages can be subscribed later */ }
  save({ ...a, page_id: p.id, page_name: p.name, page_token: p.token, ig_id: p.ig?.id, ig_username: p.ig?.username, subscribed, connected_at: now() });
  return { page: p.name, instagram: p.ig?.username || null, subscribed };
}

/** Who signed in and which permissions Facebook granted (shown when no Page comes back). */
export async function metaWhoAmI(userToken = metaAuth()?.user_token || '') {
  const me = await gget('me', { access_token: userToken, fields: 'id,name' }).catch(() => ({ name: '?' }));
  const perms = await gget('me/permissions', { access_token: userToken }).catch(() => ({ data: [] }));
  const granted = (perms.data || []).filter((p: any) => p.status === 'granted').map((p: any) => p.permission);
  const declined = (perms.data || []).filter((p: any) => p.status !== 'granted').map((p: any) => p.permission);
  return { name: String(me.name || '?'), granted, missing: META_SCOPES.filter((s) => !granted.includes(s)), declined };
}
