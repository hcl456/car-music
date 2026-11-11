// 播放器：播放清單、隨機、循環、鎖定畫面 / 車機控制（Media Session）
import * as db from './db.js';

const STATE_KEY = 'cm.state';
const SILENT = makeSilentWav();
const MIME = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
  flac: 'audio/flac', aif: 'audio/aiff', aiff: 'audio/aiff', caf: 'audio/x-caf', ogg: 'audio/ogg', opus: 'audio/ogg',
};

export function mimeFor(name, fallback = '') {
  if (fallback && fallback !== 'application/octet-stream') return fallback;
  const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
  return MIME[ext] || fallback || 'audio/mpeg';
}

export const displayName = name => name.replace(/\.[a-z0-9]{2,4}$/i, '');

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function loadState() {
  try { return JSON.parse(localStorage.getItem(STATE_KEY)) || {}; } catch { return {}; }
}

export class Player extends EventTarget {
  constructor(audio) {
    super();
    this.audio = audio;
    this.playlist = null;
    this.order = [];      // 播放順序（track id）
    this.pos = -1;
    const s = loadState();
    this.shuffle = !!s.shuffle;
    this.repeat = ['all', 'one', 'off'].includes(s.repeat) ? s.repeat : 'all';
    this.url = null;
    this.isSilent = false;
    this.unlocked = false; // 這個 <audio> 是否已經被使用者點擊「解鎖」過
    this.loadSeq = 0;
    this.failStreak = 0;
    this.lastSave = 0;

    audio.addEventListener('ended', () => { if (!this.isSilent) this.next(true); });
    audio.addEventListener('error', () => {
      if (this.isSilent || !this.current) return;
      this.emit('message', `無法播放「${displayName(this.current.name)}」，跳到下一首`);
      this.skipBroken();
    });
    audio.addEventListener('playing', () => {
      this.unlocked = true;
      if (!this.isSilent) this.failStreak = 0;
    });
    for (const ev of ['play', 'pause', 'timeupdate', 'durationchange', 'loadedmetadata', 'emptied']) {
      audio.addEventListener(ev, () => this.emit('update'));
    }
    audio.addEventListener('play', () => this.setPlaybackState('playing'));
    audio.addEventListener('pause', () => { this.setPlaybackState('paused'); this.saveState(); });
    audio.addEventListener('loadedmetadata', () => this.updatePositionState());
    audio.addEventListener('timeupdate', () => {
      if (Date.now() - this.lastSave > 5000) this.saveState();
    });
    window.addEventListener('pagehide', () => this.saveState());
    this.setupMediaSession();
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  get current() {
    if (!this.playlist || this.pos < 0) return null;
    const id = this.order[this.pos];
    return this.playlist.tracks.find(t => t.id === id) || null;
  }

  get hasSource() { return !!this.url && !this.isSilent; }

  playableIds(pl = this.playlist) {
    return pl ? pl.tracks.filter(t => t.cached).map(t => t.id) : [];
  }

  buildOrder(startId) {
    let ids = this.playableIds();
    if (this.shuffle) {
      ids = shuffled(ids);
      if (startId && ids.includes(startId)) ids = [startId, ...ids.filter(id => id !== startId)];
    }
    this.order = ids;
    this.pos = ids.length ? Math.max(0, startId ? ids.indexOf(startId) : 0) : -1;
  }

  // iOS 規定第一次發聲必須在使用者點擊的同一個事件裡呼叫 play()。
  // 先播一小段無聲音訊「解鎖」這個 <audio>，之後就能在背景自由換歌。
  unlock() {
    if (this.unlocked) return;
    this.isSilent = true;
    this.audio.src = SILENT;
    const p = this.audio.play();
    if (p) p.catch(() => {});
  }

  // 使用者點「播放」某清單（必須在點擊事件裡直接呼叫）
  start(playlist, startTrackId = null) {
    this.unlock();
    this.playlist = playlist;
    this.buildOrder(startTrackId);
    return this.loadCurrent({ autoplay: true });
  }

  // 開啟網頁時恢復上次的位置（不播放）
  async prepare(playlist, trackId, time = 0) {
    this.playlist = playlist;
    this.buildOrder(trackId);
    return this.loadCurrent({ autoplay: false, time });
  }

  async loadCurrent({ autoplay, time = 0 }) {
    const seq = ++this.loadSeq;
    const track = this.current;
    if (!track) { this.emit('track'); return false; }

    let blob = null;
    try { blob = await db.getAudio(track.id); } catch (e) { console.warn(e); }
    if (seq !== this.loadSeq) return false; // 期間又換了歌

    if (!blob) {
      track.cached = false;
      this.emit('missing', track);
      return this.skipBroken(autoplay);
    }
    if (!(blob instanceof Blob)) blob = new Blob([blob]);
    if (!blob.type || blob.type === 'application/octet-stream') blob = new Blob([blob], { type: mimeFor(track.name) });

    const old = this.url;
    this.url = URL.createObjectURL(blob);
    this.isSilent = false;
    this.audio.src = this.url;
    if (old) URL.revokeObjectURL(old);

    if (time > 0) {
      const seek = () => { try { this.audio.currentTime = time; } catch { /* ignore */ } };
      if (this.audio.readyState >= 1) seek(); else this.audio.addEventListener('loadedmetadata', seek, { once: true });
    }
    this.updateMetadata();
    this.saveState();
    this.emit('track');

    if (autoplay) await this.play();
    return true;
  }

  async play() {
    if (!this.hasSource) {
      if (this.playlist && this.order.length) return this.loadCurrent({ autoplay: true });
      return false;
    }
    try {
      await this.audio.play();
      return true;
    } catch (e) {
      if (e.name === 'NotAllowedError') this.emit('blocked');
      else if (e.name !== 'AbortError') console.warn(e);
      return false;
    }
  }

  // 播放/暫停（在點擊事件裡直接呼叫，iOS 才會允許出聲）
  toggle() {
    if (!this.hasSource) return this.play();
    if (this.audio.paused) return this.play();
    this.audio.pause();
  }

  skipBroken(autoplay = true) {
    this.failStreak++;
    if (this.failStreak > this.order.length) {
      this.failStreak = 0;
      this.audio.pause();
      this.emit('message', '這個清單目前沒有可以播放的歌曲，請重新同步');
      return false;
    }
    if (!this.order.length) return false;
    this.pos = (this.pos + 1) % this.order.length;
    return this.loadCurrent({ autoplay });
  }

  next(auto = false) {
    if (!this.playlist || !this.order.length) return;
    if (auto && this.repeat === 'one') {
      this.audio.currentTime = 0;
      this.play();
      return;
    }
    let p = this.pos + 1;
    if (p >= this.order.length) {
      if (auto && this.repeat === 'off') {
        this.emit('message', '清單播放完畢');
        return;
      }
      if (this.shuffle && this.order.length > 1) {
        const last = this.order[this.order.length - 1];
        let ids = shuffled(this.order);
        if (ids[0] === last) ids.push(ids.shift()); // 避免同一首連播兩次
        this.order = ids;
      }
      p = 0;
    }
    this.pos = p;
    return this.loadCurrent({ autoplay: true });
  }

  prev() {
    if (!this.playlist || !this.order.length) return;
    if (this.audio.currentTime > 3) { this.audio.currentTime = 0; return; }
    this.pos = this.pos - 1 < 0 ? this.order.length - 1 : this.pos - 1;
    return this.loadCurrent({ autoplay: true });
  }

  setShuffle(on) {
    this.shuffle = on;
    if (this.playlist) {
      const cur = this.current?.id || null;
      this.buildOrder(cur);
    }
    this.saveState();
    this.emit('update');
  }

  cycleRepeat() {
    this.repeat = { all: 'one', one: 'off', off: 'all' }[this.repeat];
    this.saveState();
    this.emit('update');
  }

  // 清單內容變了（同步 / 加入新歌）時更新播放順序，但不打斷目前這首
  refresh(pl) {
    if (!this.playlist || this.playlist.id !== pl.id) return;
    const curId = this.order[this.pos];
    this.playlist = pl;
    const playable = this.playableIds(pl);
    const set = new Set(playable);
    const order = this.order.filter(id => set.has(id));
    const added = playable.filter(id => !order.includes(id));
    order.push(...(this.shuffle ? shuffled(added) : added));
    this.order = order;
    this.pos = curId ? order.indexOf(curId) : (order.length ? 0 : -1);
    this.emit('track');
  }

  stop() {
    this.loadSeq++;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    this.playlist = null;
    this.order = [];
    this.pos = -1;
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
    this.emit('track');
  }

  saveState() {
    this.lastSave = Date.now();
    const t = this.current;
    const s = {
      playlistId: this.playlist?.id || null,
      trackId: t?.id || null,
      time: t && !this.isSilent ? Math.floor(this.audio.currentTime || 0) : 0,
      shuffle: this.shuffle,
      repeat: this.repeat,
    };
    try { localStorage.setItem(STATE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
  }

  // ---- Media Session：鎖定畫面、控制中心、車機上的歌名與上一首/下一首 ----
  setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const set = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* 不支援 */ } };
    set('play', () => this.play());
    set('pause', () => this.audio.pause());
    set('nexttrack', () => this.next());
    set('previoustrack', () => this.prev());
    set('seekto', d => { if (d.seekTime != null) this.audio.currentTime = d.seekTime; });
    // 設成 null，iOS 才會顯示「上一首/下一首」而不是「倒轉/快轉 10 秒」
    set('seekbackward', null);
    set('seekforward', null);
  }

  updateMetadata() {
    if (!('mediaSession' in navigator) || !this.current) return;
    const icon = new URL('icons/icon-512.png', location.href).href;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: displayName(this.current.name),
      artist: this.playlist.name,
      album: 'Car Music',
      artwork: [{ src: icon, sizes: '512x512', type: 'image/png' }],
    });
  }

  setPlaybackState(state) {
    if ('mediaSession' in navigator && !this.isSilent) navigator.mediaSession.playbackState = state;
  }

  updatePositionState() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState || this.isSilent) return;
    const d = this.audio.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: d, playbackRate: this.audio.playbackRate || 1, position: Math.min(this.audio.currentTime, d),
      });
    } catch { /* ignore */ }
  }
}

function makeSilentWav() {
  const rate = 8000, samples = 800, dataLen = samples * 2;
  const v = new DataView(new ArrayBuffer(44 + dataLen));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, dataLen, true);
  let s = '';
  for (const b of new Uint8Array(v.buffer)) s += String.fromCharCode(b);
  return 'data:audio/wav;base64,' + btoa(s);
}
