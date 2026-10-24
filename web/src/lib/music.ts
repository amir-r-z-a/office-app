import { create } from 'zustand';
import { MAX_UPLOAD_MB, type RoomMusic, type Track } from '@office/shared';
import { getToken } from './api';
import { onTimeSync, useStore } from './store';
import { useVoice, voice } from './voice';

// Synced playback: the server owns each room's queue and position. Every app estimates the
// server clock, then keeps its own player within a fraction of a second of where the song should be.

interface Upload {
  id: string;
  name: string;
  progress: number;
  error?: string;
}

interface MusicPrefs {
  volume: number;
  /** Lower the music while anyone in the room talks. */
  duck: boolean;
}

const PREFS_KEY = 'office.music';

function loadPrefs(): MusicPrefs {
  try {
    return { volume: 0.7, duck: true, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') };
  } catch {
    return { volume: 0.7, duck: true };
  }
}

interface MusicStore extends MusicPrefs {
  panelOpen: boolean;
  tab: 'queue' | 'library' | 'share';
  uploads: Upload[];
  /** The browser refused to start audio until the person clicks something. */
  blocked: boolean;
  streaming: boolean;
}

export const useMusic = create<MusicStore>(() => ({
  ...loadPrefs(),
  panelOpen: false,
  tab: 'queue',
  uploads: [],
  blocked: false,
  streaming: false,
}));

function savePrefs() {
  const { volume, duck } = useMusic.getState();
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ volume, duck }));
  } catch {
    // Not remembered.
  }
}

/** Where the song should be right now, in seconds, by the server's clock. */
export function positionOf(m: RoomMusic, offset: number): number {
  return m.playing ? m.position + (Date.now() + offset - m.anchorAt) / 1000 : m.position;
}

export function currentTrack(m: RoomMusic | undefined, library: Record<string, Track>): Track | undefined {
  const item = m && m.index >= 0 ? m.queue[m.index] : undefined;
  return item ? library[item.trackId] : undefined;
}

/** My room's music, or undefined in the hallway. */
export function useMyRoomMusic(): RoomMusic | undefined {
  return useStore((s) => {
    const roomId = s.meId ? s.presence[s.meId]?.roomId : null;
    return roomId ? s.music[roomId] : undefined;
  });
}

const HARD_DRIFT = 0.35;
const SOFT_DRIFT = 0.06;
const DUCK_LEVEL = 0.28;

class MusicPlayer {
  private audio = new Audio();
  private offset = 0;
  private bestRtt = Infinity;
  private trackUrl = '';
  private gain = 1;
  private started = false;
  private syncTimer: number | undefined;

  start() {
    if (this.started) return;
    this.started = true;
    this.audio.preload = 'auto';
    onTimeSync((t0, server) => this.onTimeSync(t0, server));
    this.audio.addEventListener('canplay', () => this.align());
    this.audio.addEventListener('playing', () => useMusic.setState({ blocked: false }));

    useStore.subscribe((s, prev) => {
      if (s.music !== prev.music || s.presence !== prev.presence || s.library !== prev.library || s.meId !== prev.meId) this.update();
      if (s.voice !== prev.voice) this.applyVolume();
      if (s.connection === 'online' && prev.connection !== 'online') this.syncClock();
      if (s.phase !== 'ready' && prev.phase === 'ready') this.stop();
    });
    useMusic.subscribe((s, prev) => {
      if (s.volume !== prev.volume || s.duck !== prev.duck) this.applyVolume();
    });
    useVoice.subscribe((s, prev) => {
      if (s.outputId !== prev.outputId || s.deafened !== prev.deafened) this.applyOutput();
    });

    // Drift check and the smooth volume ramp share one timer.
    window.setInterval(() => {
      this.align();
      this.rampVolume();
    }, 250);
    this.applyOutput();
    if (useStore.getState().connection === 'online') this.syncClock();
    this.update();
  }

  // Clock

  /** NTP-style estimate of the server clock: a few round trips, keeping the fastest. */
  private syncClock() {
    this.bestRtt = Infinity;
    let n = 0;
    const ping = () => {
      if (useStore.getState().connection !== 'online') return;
      useStore.getState().send({ type: 'time.sync', t0: Date.now() });
      if (++n < 6) window.setTimeout(ping, 300);
    };
    ping();
    window.clearInterval(this.syncTimer);
    this.syncTimer = window.setInterval(() => {
      n = 4;
      ping();
    }, 60_000);
  }

  onTimeSync(t0: number, server: number) {
    const t1 = Date.now();
    const rtt = t1 - t0;
    if (rtt > this.bestRtt * 1.5 && this.bestRtt !== Infinity) return;
    this.bestRtt = Math.min(this.bestRtt, rtt);
    this.offset = server - (t0 + t1) / 2;
  }

  get clockOffset() {
    return this.offset;
  }

  // Playback

  private state(): { music?: RoomMusic; track?: Track } {
    const s = useStore.getState();
    const roomId = s.meId ? s.presence[s.meId]?.roomId : null;
    const music = roomId ? s.music[roomId] : undefined;
    return { music, track: currentTrack(music, s.library) };
  }

  private update() {
    const { music, track } = this.state();
    const shouldPlay = !!(music && track && music.playing && !music.streamerId);
    if (!track || !music || music.streamerId) {
      this.audio.pause();
      if (!track) {
        this.trackUrl = '';
        this.audio.removeAttribute('src');
        this.audio.load();
      }
      return;
    }
    if (this.trackUrl !== track.url) {
      this.trackUrl = track.url;
      this.audio.src = track.url;
      this.audio.currentTime = Math.max(0, positionOf(music, this.offset));
    }
    if (shouldPlay) this.play();
    else {
      this.audio.pause();
      this.audio.currentTime = Math.max(0, music.position);
    }
    this.align();
  }

  private play() {
    if (!this.audio.paused) return;
    this.audio.play().catch((err: DOMException) => {
      // Autoplay rules: wait for the next click anywhere.
      if (err.name === 'NotAllowedError') {
        useMusic.setState({ blocked: true });
        window.addEventListener('pointerdown', () => this.update(), { once: true });
      }
    });
  }

  /** Keep our player where the server says the song is. */
  private align() {
    const { music, track } = this.state();
    if (!music || !track || !music.playing || music.streamerId || this.audio.paused || this.audio.readyState < 2) {
      this.audio.playbackRate = 1;
      return;
    }
    const target = positionOf(music, this.offset);
    if (target >= track.duration) return;
    const drift = this.audio.currentTime - target;
    if (Math.abs(drift) > HARD_DRIFT) {
      this.audio.currentTime = target;
      this.audio.playbackRate = 1;
    } else if (Math.abs(drift) > SOFT_DRIFT) {
      // Small drift: nudge the speed for a moment instead of an audible jump.
      this.audio.playbackRate = drift > 0 ? 0.97 : 1.03;
    } else {
      this.audio.playbackRate = 1;
    }
  }

  private stop() {
    this.audio.pause();
    this.trackUrl = '';
    this.audio.removeAttribute('src');
  }

  // Volume

  private targetGain(): number {
    const { volume, duck } = useMusic.getState();
    if (!duck) return volume;
    const s = useStore.getState();
    const roomId = s.meId ? s.presence[s.meId]?.roomId : null;
    const talking =
      !!roomId &&
      Object.values(s.voice).some((v) => v.speaking && s.presence[v.userId]?.roomId === roomId && s.presence[v.userId]?.online);
    return talking ? volume * DUCK_LEVEL : volume;
  }

  private applyVolume() {
    this.rampVolume();
  }

  /** Move a step toward the target volume, so ducking fades instead of cutting. */
  private rampVolume() {
    const target = this.targetGain();
    const step = target < this.gain ? 0.12 : 0.05;
    this.gain = Math.abs(target - this.gain) <= step ? target : this.gain + Math.sign(target - this.gain) * step;
    this.audio.volume = Math.max(0, Math.min(1, this.gain));
    voice.setStreamVolume(this.gain);
  }

  private applyOutput() {
    const { outputId, deafened } = useVoice.getState();
    this.audio.muted = deafened;
    const el = this.audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (el.setSinkId) void el.setSinkId(outputId).catch(() => undefined);
  }

  setVolume(volume: number) {
    useMusic.setState({ volume });
    savePrefs();
  }

  setDuck(duck: boolean) {
    useMusic.setState({ duck });
    savePrefs();
  }

  /** For tests: how far our player is from where the song should be. */
  debug() {
    const { music, track } = this.state();
    return {
      track: track?.title ?? null,
      paused: this.audio.paused,
      currentTime: this.audio.currentTime,
      target: music ? positionOf(music, this.offset) : null,
      offset: this.offset,
      volume: this.audio.volume,
    };
  }
}

export const player = new MusicPlayer();
(window as unknown as { __music: MusicPlayer }).__music = player;

// Uploads

const ACCEPT = /\.(mp3|m4a|aac|ogg|oga|opus|flac|wav|webm)$/i;

/** Upload songs one after another, with progress, so a big batch doesn't swamp the Wi-Fi. */
export async function uploadSongs(files: File[]) {
  const list = files.map((f) => ({ id: Math.random().toString(36).slice(2), file: f }));
  useMusic.setState({ uploads: [...useMusic.getState().uploads, ...list.map(({ id, file }) => ({ id, name: file.name, progress: 0 }))] });
  for (const { id, file } of list) {
    const patch = (p: Partial<Upload>) =>
      useMusic.setState({ uploads: useMusic.getState().uploads.map((u) => (u.id === id ? { ...u, ...p } : u)) });
    if (!ACCEPT.test(file.name) && !file.type.startsWith('audio/')) {
      patch({ error: 'Not a song file' });
      continue;
    }
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      patch({ error: `Larger than ${MAX_UPLOAD_MB} MB` });
      continue;
    }
    try {
      await sendFile(file, (progress) => patch({ progress }));
      patch({ progress: 1 });
      window.setTimeout(() => useMusic.setState({ uploads: useMusic.getState().uploads.filter((u) => u.id !== id) }), 1200);
    } catch (err) {
      patch({ error: (err as Error).message });
    }
  }
}

export function dismissUpload(id: string) {
  useMusic.setState({ uploads: useMusic.getState().uploads.filter((u) => u.id !== id) });
}

function sendFile(file: File, onProgress: (p: number) => void): Promise<Track> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/music');
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('x-filename', encodeURIComponent(file.name));
    const token = getToken();
    if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      const data = JSON.parse(xhr.responseText || '{}');
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as Track);
      else reject(new Error(data.error ?? `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Lost the connection to the server'));
    xhr.send(file);
  });
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
