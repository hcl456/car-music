import * as db from './db.js';
import * as auth from './auth.js';
import * as drive from './drive.js';
import { Player, loadState, mimeFor, displayName } from './player.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const collator = new Intl.Collator('zh-Hant', { numeric: true, sensitivity: 'base' });
const byName = (a, b) => collator.compare(a.name, b.name);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const params = new URLSearchParams(location.search);

const audio = $('#audio');
const player = new Player(audio);
let playlists = [];
const syncStatus = new Map();       // playlistId -> 狀態文字
const openTracks = new Set();       // 展開曲目的清單
let localTarget = null;             // 加入檔案到哪個清單（null = 新清單）

// ---------- 小工具 ----------
let toastTimer;
function toast(msg, ms = 3200) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function fmtTime(s) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function fmtSize(b) {
  if (!b) return '0 MB';
  if (b > 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b < 1e7) return (b / 1e6).toFixed(1) + ' MB';
  return Math.round(b / 1e6) + ' MB';
}

async function requestPersist() {
  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch { /* ignore */ }
}

function savePlaylist(pl) { return db.putPlaylist(pl); }

// 刪除不再被任何清單使用的音樂檔
async function purgeAudio(ids, exceptPlaylistId = null) {
  const used = new Set();
  for (const p of playlists) if (p.id !== exceptPlaylistId) p.tracks.forEach(t => used.add(t.id));
  for (const id of ids) if (!used.has(id)) await db.deleteAudio(id).catch(() => {});
}

// ---------- Google 登入 ----------
function ensureToken(after) {
  const t = auth.getToken();
  if (t) return t;
  if (!auth.hasClientId()) {
    toast('尚未設定 Google Client ID（config.js），目前只能使用手機檔案', 5000);
    return null;
  }
  const playing = !audio.paused;
  if (confirm('需要登入 Google 才能讀取雲端硬碟。' + (playing ? '\n（音樂會暫停）' : '') + '\n現在前往登入？')) {
    player.saveState();
    auth.signIn(after);
  }
  return null;
}

function renderAuth() {
  const el = $('#auth');
  if (!auth.hasClientId()) {
    el.innerHTML = '<span>未設定 Client ID</span>';
    return;
  }
  if (auth.getToken()) {
    el.innerHTML = `<span><span class="dot"></span> Google（${auth.tokenMinutesLeft()} 分）</span>
      <button class="ghost small" data-act="logout">登出</button>`;
  } else {
    el.innerHTML = '<button class="small" data-act="login">登入 Google</button>';
  }
}

$('#auth').addEventListener('click', e => {
  const act = e.target.closest('button')?.dataset.act;
  if (act === 'login') auth.signIn();
  if (act === 'logout') { auth.clearToken(); renderAuth(); toast('已登出（已下載的歌仍可播放）'); }
});

// ---------- 正在播放 ----------
let seeking = false;

function renderNow() {
  const t = player.current;
  $('#npTitle').textContent = t ? displayName(t.name) : '尚未選擇歌曲';
  $('#npSub').textContent = player.playlist
    ? `${player.playlist.name} · ${player.pos + 1} / ${player.order.length}`
    : '選一個播放清單開始';
  const playing = !audio.paused && !player.isSilent;
  $('#btnPlay').classList.toggle('playing', playing);
  $('#btnPlay').setAttribute('aria-label', playing ? '暫停' : '播放');

  const dur = player.isSilent ? 0 : audio.duration;
  const seek = $('#seek');
  seek.max = Number.isFinite(dur) ? Math.floor(dur) : 0;
  if (!seeking) seek.value = player.isSilent ? 0 : Math.floor(audio.currentTime || 0);
  $('#tCur').textContent = fmtTime(seeking ? Number(seek.value) : (player.isSilent ? 0 : audio.currentTime));
  $('#tDur').textContent = fmtTime(dur);

  const sh = $('#btnShuffle');
  sh.classList.toggle('on', player.shuffle);
  sh.setAttribute('aria-pressed', String(player.shuffle));
  const rp = $('#btnRepeat');
  rp.classList.toggle('on', player.repeat !== 'off');
  rp.classList.toggle('one-on', player.repeat === 'one');
  rp.setAttribute('aria-label', { all: '循環：整個清單', one: '循環：單曲', off: '循環：關閉' }[player.repeat]);
  $('#modeText').textContent = `${player.shuffle ? '隨機' : '依順序'} · ${{ all: '清單循環', one: '單曲循環', off: '不循環' }[player.repeat]}`;
}

player.addEventListener('update', renderNow);
player.addEventListener('track', () => { renderNow(); renderPlaylists(); });
player.addEventListener('message', e => toast(e.detail));
player.addEventListener('blocked', showOverlay);
player.addEventListener('missing', async e => {
  const pl = playlists.find(p => p.tracks.some(t => t.id === e.detail.id));
  if (pl) { await savePlaylist(pl); renderPlaylists(); }
});

$('#btnPlay').addEventListener('click', () => {
  if (!player.playlist) {
    const pl = playlists.find(p => p.tracks.some(t => t.cached));
    if (pl) player.start(pl);
    else toast('還沒有可以播放的歌曲，請先新增播放清單');
    return;
  }
  player.toggle();
});
$('#btnNext').addEventListener('click', () => { player.unlock(); player.next(); });
$('#btnPrev').addEventListener('click', () => { player.unlock(); player.prev(); });
$('#btnShuffle').addEventListener('click', () => player.setShuffle(!player.shuffle));
$('#btnRepeat').addEventListener('click', () => player.cycleRepeat());

const seekEl = $('#seek');
seekEl.addEventListener('input', () => { seeking = true; renderNow(); });
seekEl.addEventListener('change', () => {
  if (player.hasSource) audio.currentTime = Number(seekEl.value);
  seeking = false;
  renderNow();
});

// 自動播放被擋時的大按鈕
function showOverlay() {
  if (!player.playlist) return;
  $('#overlay').hidden = false;
}
$('#overlayPlay').addEventListener('click', () => {
  $('#overlay').hidden = true;
  player.play();
});

// ---------- 播放清單 ----------
function renderPlaylists() {
  const box = $('#playlists');
  if (!playlists.length) {
    box.innerHTML = '<div class="empty">還沒有播放清單。<br>用下面的按鈕加入 Google Drive 資料夾或手機上的檔案。</div>';
    return;
  }
  const curPl = player.playlist?.id;
  const curTrack = player.current?.id;
  box.innerHTML = playlists.map(pl => {
    const total = pl.tracks.length;
    const cached = pl.tracks.filter(t => t.cached).length;
    const size = pl.tracks.reduce((s, t) => s + (t.cached ? t.size || 0 : 0), 0);
    const status = syncStatus.get(pl.id);
    const meta = status
      ? `<span class="busy">${esc(status)}</span>`
      : (pl.type === 'drive'
        ? `${cached}/${total} 首已下載 · ${fmtSize(size)}${pl.syncedAt ? ' · ' + new Date(pl.syncedAt).toLocaleDateString('zh-TW') + ' 同步' : ''}`
        : `${total} 首 · ${fmtSize(size)}`);
    const open = openTracks.has(pl.id);
    const tracks = open
      ? `<ol class="tracks">${pl.tracks.map((t, i) => `
          <li data-track="${esc(t.id)}" class="${t.cached ? '' : 'missing'} ${curPl === pl.id && curTrack === t.id ? 'playing' : ''}">
            <span class="n">${i + 1}</span><span class="t">${esc(displayName(t.name))}</span>
          </li>`).join('') || '<li class="missing"><span class="t">（空的）</span></li>'}</ol>`
      : '';
    return `<div class="pl ${curPl === pl.id ? 'current' : ''}" data-id="${esc(pl.id)}">
      <div class="pl-row">
        <div class="pl-main">
          <div class="pl-name">${esc(pl.name)}<span class="badge">${pl.type === 'drive' ? 'Drive' : '手機'}</span></div>
          <div class="pl-meta">${meta}</div>
        </div>
      </div>
      <div class="pl-actions">
        <button class="play" data-act="play">播放</button>
        ${pl.type === 'drive'
          ? `<button data-act="sync" ${status ? 'disabled' : ''}>同步</button>`
          : '<button data-act="addfiles">加入檔案</button>'}
        ${pl.type === 'drive' && cached
          ? `<button data-act="clear" ${status ? 'disabled' : ''}>清除下載</button>`
          : ''}
        <button data-act="tracks">${open ? '收起' : '曲目'}</button>
        <button class="ghost danger" data-act="delete" ${status ? 'disabled' : ''}>刪除</button>
      </div>
      ${tracks}
    </div>`;
  }).join('');
}

$('#playlists').addEventListener('click', e => {
  const plEl = e.target.closest('.pl');
  if (!plEl) return;
  const pl = playlists.find(p => p.id === plEl.dataset.id);
  if (!pl) return;

  const li = e.target.closest('li[data-track]');
  if (li) {
    const t = pl.tracks.find(x => x.id === li.dataset.track);
    if (!t?.cached) { toast(pl.type === 'drive' ? '這首還沒下載，請先按「同步」' : '找不到這個檔案'); return; }
    player.start(pl, t.id);
    return;
  }

  const act = e.target.closest('button')?.dataset.act;
  if (act === 'play') {
    if (!pl.tracks.some(t => t.cached)) {
      toast(pl.type === 'drive' ? '這個清單還沒有下載任何歌曲，請先按「同步」' : '這個清單是空的');
      return;
    }
    player.start(pl);
  } else if (act === 'sync') {
    syncPlaylist(pl);
  } else if (act === 'addfiles') {
    localTarget = pl.id;
    $('#filePick').click();
  } else if (act === 'tracks') {
    openTracks.has(pl.id) ? openTracks.delete(pl.id) : openTracks.add(pl.id);
    renderPlaylists();
  } else if (act === 'clear') {
    clearDownloads(pl);
  } else if (act === 'delete') {
    deletePlaylist(pl);
  }
});

// 刪掉這個清單下載到手機的歌，但保留清單和曲目；之後按「同步」可重新下載
async function clearDownloads(pl) {
  const cached = pl.tracks.filter(t => t.cached);
  const size = cached.reduce((s, t) => s + (t.size || 0), 0);
  if (!confirm(`清除「${pl.name}」已下載的 ${cached.length} 首歌（約 ${fmtSize(size)}）？\n播放清單會保留，之後按「同步」可以重新下載。`)) return;
  if (player.playlist?.id === pl.id) player.stop();
  await purgeAudio(cached.map(t => t.id), pl.id);
  pl.tracks.forEach(t => { t.cached = false; });
  await savePlaylist(pl);
  renderPlaylists();
  updateStorage();
  toast(`已清除「${pl.name}」的下載`);
}

async function deletePlaylist(pl) {
  if (!confirm(`刪除播放清單「${pl.name}」？\n手機上下載的音樂檔也會一併刪除（雲端硬碟上的檔案不受影響）。`)) return;
  if (player.playlist?.id === pl.id) player.stop();
  await purgeAudio(pl.tracks.map(t => t.id), pl.id);
  await db.deletePlaylist(pl.id);
  playlists = playlists.filter(p => p.id !== pl.id);
  renderPlaylists();
  updateStorage();
}

// ---------- 手機 / iCloud 檔案 ----------
$('#btnAddLocal').addEventListener('click', () => {
  localTarget = null;
  $('#filePick').click();
});

$('#filePick').addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  let pl = playlists.find(p => p.id === localTarget);
  if (!pl) {
    const name = (prompt('播放清單名稱', '手機音樂') || '').trim() || '手機音樂';
    pl = { id: 'loc-' + uid(), type: 'local', name, createdAt: Date.now(), tracks: [] };
    playlists.push(pl);
  }
  await importFiles(pl, files);
});

async function importFiles(pl, files) {
  await requestPersist();
  syncStatus.set(pl.id, '匯入中…');
  renderPlaylists();
  let ok = 0;
  try {
    for (const [i, f] of files.entries()) {
      syncStatus.set(pl.id, `匯入中 ${i + 1}/${files.length}：${f.name}`);
      renderPlaylists();
      // 複製一份內容存起來，不依賴原始檔案還在不在
      const blob = new Blob([await f.arrayBuffer()], { type: mimeFor(f.name, f.type) });
      const id = 'loc-' + uid();
      await db.putAudio(id, blob);
      pl.tracks.push({ id, name: f.name, size: f.size, version: 'local', cached: true });
      ok++;
    }
  } catch (err) {
    toast(err.name === 'QuotaExceededError' ? '手機儲存空間不足，部分檔案沒有匯入' : '匯入失敗：' + err.message, 5000);
  } finally {
    pl.tracks.sort(byName);
    await savePlaylist(pl);
    syncStatus.delete(pl.id);
    player.refresh(pl);
    renderPlaylists();
    updateStorage();
  }
  if (ok) toast(`已加入 ${ok} 首到「${pl.name}」`);
}

// ---------- Google Drive 同步 ----------
async function syncPlaylist(pl) {
  if (syncStatus.has(pl.id)) return;
  const token = ensureToken({ action: 'sync', id: pl.id });
  if (!token) return;
  await requestPersist();
  syncStatus.set(pl.id, '讀取雲端資料夾…');
  renderPlaylists();
  let downloaded = 0;
  try {
    const files = (await drive.listChildren(token, pl.folderId)).filter(drive.isAudio).sort(byName);
    const old = new Map(pl.tracks.map(t => [t.id, t]));
    const tracks = files.map(f => {
      const version = f.md5Checksum || f.modifiedTime || '';
      const o = old.get(f.id);
      return { id: f.id, name: f.name, size: Number(f.size) || 0, version, cached: !!(o && o.cached && o.version === version) };
    });
    const keep = new Set(tracks.map(t => t.id));
    const removed = pl.tracks.filter(t => !keep.has(t.id)).map(t => t.id);
    pl.tracks = tracks;
    await savePlaylist(pl);
    await purgeAudio(removed, pl.id);
    player.refresh(pl);

    const todo = tracks.filter(t => !t.cached);
    for (const [i, t] of todo.entries()) {
      syncStatus.set(pl.id, `下載中 ${i + 1}/${todo.length}：${displayName(t.name)}`);
      renderPlaylists();
      const raw = await drive.downloadFile(token, t.id);
      const blob = new Blob([raw], { type: mimeFor(t.name, raw.type) });
      await db.putAudio(t.id, blob);
      t.cached = true;
      downloaded++;
      await savePlaylist(pl);
      player.refresh(pl);
    }
    pl.syncedAt = Date.now();
    await savePlaylist(pl);
    toast(`「${pl.name}」同步完成：共 ${tracks.length} 首，新下載 ${downloaded} 首`);
  } catch (err) {
    console.error(err);
    if (err instanceof drive.AuthError) {
      auth.clearToken();
      toast('Google 登入已過期，請重新登入後再按「同步」（已下載的會保留）', 6000);
    } else if (err.name === 'QuotaExceededError') {
      toast('手機儲存空間不足，同步中止', 6000);
    } else {
      toast('同步失敗：' + err.message, 6000);
    }
  } finally {
    syncStatus.delete(pl.id);
    renderAuth();
    renderPlaylists();
    updateStorage();
  }
}

// ---------- 選擇 Google Drive 資料夾 ----------
const dlg = $('#folderDlg');
const browse = { mode: 'my', stack: [], items: [] };

function resetBrowse(mode) {
  browse.mode = mode;
  browse.stack = [mode === 'my' ? { id: 'root', name: '我的雲端硬碟' } : { id: null, name: '與我共用' }];
  dlg.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
}

$('#btnAddDrive').addEventListener('click', () => {
  const token = ensureToken({ action: 'addDrive' });
  if (!token) return;
  openFolderDialog();
});

function openFolderDialog() {
  resetBrowse('my');
  dlg.showModal();
  loadFolder();
}

async function loadFolder() {
  const token = auth.getToken();
  if (!token) { dlg.close(); ensureToken({ action: 'addDrive' }); return; }
  const top = browse.stack.at(-1);
  const list = $('#folderList');
  list.innerHTML = '<p class="muted">載入中…</p>';
  $('#btnChoose').disabled = true;
  $('#folderInfo').textContent = '';
  renderCrumbs();
  try {
    let folders, audioCount = 0;
    if (top.id === null) {
      folders = await drive.listSharedFolders(token);
    } else {
      const items = await drive.listChildren(token, top.id);
      folders = items.filter(drive.isFolder);
      audioCount = items.filter(drive.isAudio).length;
    }
    if (browse.stack.at(-1) !== top) return; // 使用者已經切換到別的資料夾
    folders.sort(byName);
    browse.items = folders;
    list.innerHTML = folders.length
      ? folders.map((f, i) => `<button data-i="${i}">${esc(f.name)}</button>`).join('')
      : '<p class="muted">（沒有子資料夾）</p>';
    if (top.id !== null) {
      $('#folderInfo').textContent = `這個資料夾有 ${audioCount} 首歌`;
      $('#btnChoose').disabled = audioCount === 0;
    }
  } catch (err) {
    if (err instanceof drive.AuthError) {
      auth.clearToken();
      dlg.close();
      ensureToken({ action: 'addDrive' });
      return;
    }
    list.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
}

function renderCrumbs() {
  $('#crumbs').innerHTML = browse.stack
    .map((c, i) => i === browse.stack.length - 1
      ? `<span>${esc(c.name)}</span>`
      : `<button data-i="${i}">${esc(c.name)}</button><span>›</span>`)
    .join('');
}

$('#folderList').addEventListener('click', e => {
  const b = e.target.closest('button[data-i]');
  if (!b) return;
  const f = browse.items[Number(b.dataset.i)];
  browse.stack.push({ id: f.id, name: f.name });
  loadFolder();
});
$('#crumbs').addEventListener('click', e => {
  const b = e.target.closest('button[data-i]');
  if (!b) return;
  browse.stack = browse.stack.slice(0, Number(b.dataset.i) + 1);
  loadFolder();
});
dlg.querySelector('.tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-mode]');
  if (!b || b.dataset.mode === browse.mode) return;
  resetBrowse(b.dataset.mode);
  loadFolder();
});
$('#dlgClose').addEventListener('click', () => dlg.close());
$('#btnChoose').addEventListener('click', async () => {
  const top = browse.stack.at(-1);
  if (!top.id) return;
  dlg.close();
  const pl = { id: 'drv-' + uid(), type: 'drive', name: top.name, folderId: top.id, createdAt: Date.now(), tracks: [] };
  playlists.push(pl);
  await savePlaylist(pl);
  renderPlaylists();
  syncPlaylist(pl);
});

// ---------- 儲存空間 ----------
const helpDlg = $('#helpDlg');
$('#btnHelp').addEventListener('click', () => helpDlg.showModal());
$('#helpClose').addEventListener('click', () => helpDlg.close());
helpDlg.addEventListener('click', e => { if (e.target === helpDlg) helpDlg.close(); }); // 點背景關閉

async function updateStorage() {
  const el = $('#storageText');
  try {
    const est = await navigator.storage?.estimate?.();
    const persisted = await navigator.storage?.persisted?.();
    el.textContent = est
      ? `已使用 ${fmtSize(est.usage)}${est.quota ? ' / 可用約 ' + fmtSize(est.quota) : ''}${persisted ? ' · 已設為持久儲存' : ''}`
      : '';
  } catch { el.textContent = ''; }
}

// ---------- 啟動 ----------
async function init() {
  const redirect = auth.handleRedirect();
  if (redirect?.error) toast('Google 登入失敗：' + redirect.error, 6000);
  renderAuth();
  setInterval(renderAuth, 60_000);

  playlists = (await db.getAllPlaylists()).sort((a, b) => a.createdAt - b.createdAt);
  renderPlaylists();
  renderNow();

  // 恢復上次播放的位置
  const st = loadState();
  let pl = playlists.find(p => p.id === st.playlistId && p.tracks.some(t => t.cached));
  const resume = !!pl;
  if (!pl) pl = playlists.find(p => p.tracks.some(t => t.cached));
  if (pl) await player.prepare(pl, resume ? st.trackId : null, resume ? st.time : 0);

  if (redirect?.ok) {
    toast('已登入 Google');
    const after = redirect.after;
    if (after?.action === 'sync') {
      const target = playlists.find(p => p.id === after.id);
      if (target) syncPlaylist(target);
    } else if (after?.action === 'addDrive') {
      openFolderDialog();
    }
  }

  // 捷徑用 ?autoplay=1 開啟：嘗試直接播放，被 iOS 擋下就顯示大按鈕
  if (params.has('autoplay') && player.hasSource) {
    const ok = await player.play();
    if (!ok) showOverlay();
  }

  updateStorage();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(err => console.warn('SW', err));
}

init().catch(err => {
  console.error(err);
  toast('啟動失敗：' + err.message, 8000);
});

// 方便除錯
window.carMusic = { player, get playlists() { return playlists; }, importFiles, syncPlaylist };
