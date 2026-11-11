// Google OAuth 2.0（純前端、重新導向方式，不需要 Client Secret、不用彈出視窗）
import { CLIENT_ID, REDIRECT_URI } from './config.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const TOKEN_KEY = 'cm.token';
const STATE_KEY = 'cm.oauthState';
const AFTER_KEY = 'cm.afterLogin';

export const hasClientId = () => !!CLIENT_ID;

export function redirectUri() {
  if (REDIRECT_URI) return REDIRECT_URI;
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

export function getToken() {
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY));
    if (t && t.exp > Date.now() + 60_000) return t.token;
  } catch { /* ignore */ }
  return null;
}

export function tokenMinutesLeft() {
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY));
    return t ? Math.max(0, Math.floor((t.exp - Date.now()) / 60_000)) : 0;
  } catch { return 0; }
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

function randomState() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}

// 前往 Google 登入頁；after = 登入回來後要自動做的事
export function signIn(after = null) {
  const state = randomState();
  localStorage.setItem(STATE_KEY, state);
  if (after) localStorage.setItem(AFTER_KEY, JSON.stringify(after));
  else localStorage.removeItem(AFTER_KEY);
  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: SCOPE,
    include_granted_scopes: 'true',
    state,
  });
  location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString();
}

// 從 Google 回來時，網址 # 後面會帶 access_token
export function handleRedirect() {
  const hash = location.hash.slice(1);
  if (!/(^|&)(access_token|error)=/.test(hash)) return null;
  const h = new URLSearchParams(hash);
  history.replaceState(null, '', location.pathname + location.search);

  const expected = localStorage.getItem(STATE_KEY);
  localStorage.removeItem(STATE_KEY);
  let after = null;
  try { after = JSON.parse(localStorage.getItem(AFTER_KEY)); } catch { /* ignore */ }
  localStorage.removeItem(AFTER_KEY);

  if (h.get('error')) return { error: h.get('error') };
  if (!expected || h.get('state') !== expected) return { error: 'state 驗證失敗，請再登入一次' };

  const expiresIn = Number(h.get('expires_in')) || 3600;
  localStorage.setItem(TOKEN_KEY, JSON.stringify({ token: h.get('access_token'), exp: Date.now() + expiresIn * 1000 }));
  return { ok: true, after };
}
