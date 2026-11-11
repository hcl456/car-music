// Google Drive API v3（唯讀）
const API = 'https://www.googleapis.com/drive/v3';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|wav|flac|aif|aiff|caf|opus|ogg)$/i;

export class AuthError extends Error {
  constructor(msg) { super(msg); this.name = 'AuthError'; }
}

export const isFolder = f => f.mimeType === FOLDER_MIME;
export const isAudio = f => !isFolder(f) && ((f.mimeType || '').startsWith('audio/') || AUDIO_EXT.test(f.name || ''));

async function get(token, path, params = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (r.status === 401) throw new AuthError('Google 登入已過期');
  if (!r.ok) {
    let msg = String(r.status);
    try { const j = await r.json(); msg = j.error?.message || msg; } catch { /* ignore */ }
    throw new Error('Google Drive 錯誤：' + msg);
  }
  return r;
}

async function listAll(token, q) {
  const out = [];
  let pageToken = '';
  do {
    const params = {
      q,
      fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,md5Checksum)',
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    };
    if (pageToken) params.pageToken = pageToken;
    const j = await (await get(token, '/files', params)).json();
    out.push(...(j.files || []));
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return out;
}

const quote = s => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

// 某資料夾底下的所有項目（資料夾 + 檔案）；id = 'root' 代表「我的雲端硬碟」
export const listChildren = (token, folderId) =>
  listAll(token, `'${quote(folderId)}' in parents and trashed=false`);

// 「與我共用」的資料夾
export const listSharedFolders = token =>
  listAll(token, `sharedWithMe=true and mimeType='${FOLDER_MIME}' and trashed=false`);

export async function downloadFile(token, fileId) {
  const r = await get(token, '/files/' + encodeURIComponent(fileId), { alt: 'media', supportsAllDrives: 'true' });
  return r.blob();
}
