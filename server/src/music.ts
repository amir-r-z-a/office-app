import { randomUUID } from 'node:crypto';
import type { ClientMessage, RoomMusic, ServerMessage } from '@office/shared';
import type { Db } from './db.js';

type MusicMessage = Extract<ClientMessage, { type: `music.${string}` }>;

/** Songs end a beat late on the server, so every app finishes the last note before the next starts. */
const END_GRACE_MS = 300;

/** The play queue of every room, and the one true playback position each app follows. */
export class MusicRooms {
  private rooms = new Map<string, RoomMusic>();
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private db: Db,
    private broadcast: (msg: ServerMessage) => void,
  ) {}

  all(): RoomMusic[] {
    return [...this.rooms.values()];
  }

  private get(roomId: string): RoomMusic {
    let m = this.rooms.get(roomId);
    if (!m) {
      m = { roomId, queue: [], index: -1, playing: false, position: 0, anchorAt: Date.now(), repeat: 'off', streamerId: null, streamSource: null };
      this.rooms.set(roomId, m);
    }
    return m;
  }

  handle(userId: string, roomId: string, msg: MusicMessage): string | void {
    const m = this.get(roomId);
    switch (msg.type) {
      case 'music.add': {
        const ids = msg.trackIds.filter((id) => this.db.getTrack(id)).slice(0, 200);
        if (!ids.length) return 'That song is no longer in the library.';
        const items = ids.map((trackId) => ({ id: randomUUID(), trackId, addedBy: userId }));
        const at = msg.playNext && m.index >= 0 ? m.index + 1 : m.queue.length;
        m.queue.splice(at, 0, ...items);
        if (m.index === -1 && !m.streamerId) this.startAt(m, at);
        break;
      }
      case 'music.playNow': {
        if (!this.db.getTrack(msg.trackId)) return 'That song is no longer in the library.';
        const at = m.index >= 0 ? m.index + 1 : m.queue.length;
        m.queue.splice(at, 0, { id: randomUUID(), trackId: msg.trackId, addedBy: userId });
        m.streamerId = null;
        m.streamSource = null;
        this.startAt(m, at);
        break;
      }
      case 'music.jump': {
        const i = m.queue.findIndex((q) => q.id === msg.itemId);
        if (i < 0) return;
        m.streamerId = null;
        m.streamSource = null;
        this.startAt(m, i);
        break;
      }
      case 'music.remove': {
        const i = m.queue.findIndex((q) => q.id === msg.itemId);
        if (i < 0) return;
        m.queue.splice(i, 1);
        if (i < m.index) m.index--;
        else if (i === m.index) {
          // The current song was removed: the next one takes its place, or the music stops.
          if (m.index < m.queue.length) this.startAt(m, m.index, m.playing);
          else this.stop(m);
        }
        break;
      }
      case 'music.move': {
        const i = m.queue.findIndex((q) => q.id === msg.itemId);
        if (i < 0) return;
        const current = m.queue[m.index]?.id;
        const [item] = m.queue.splice(i, 1);
        m.queue.splice(Math.max(0, Math.min(m.queue.length, msg.toIndex)), 0, item);
        m.index = current ? m.queue.findIndex((q) => q.id === current) : -1;
        break;
      }
      case 'music.clear':
        // Keep what's playing; drop what has played and what's coming.
        m.queue = m.index >= 0 ? [m.queue[m.index]] : [];
        m.index = m.queue.length ? 0 : -1;
        break;
      case 'music.toggle': {
        if (m.streamerId) return;
        if (msg.playing && m.index === -1) {
          if (!m.queue.length) return 'Add a song to the queue first.';
          this.startAt(m, 0);
          break;
        }
        this.anchor(m, this.position(m));
        m.playing = msg.playing;
        break;
      }
      case 'music.seek': {
        const track = this.current(m);
        if (!track) return;
        this.anchor(m, Math.max(0, Math.min(track.duration - 0.5, msg.position)));
        break;
      }
      case 'music.next':
        this.advance(m, true);
        break;
      case 'music.prev':
        // Like a car stereo: back to the start first, then the previous song.
        if (this.position(m) > 3 || m.index <= 0) this.anchor(m, 0);
        else this.startAt(m, m.index - 1, m.playing);
        break;
      case 'music.repeat':
        m.repeat = msg.mode;
        break;
      case 'music.stream':
        if (msg.on) {
          // Streaming takes over the room; the queue waits where it was.
          this.anchor(m, this.position(m));
          m.playing = false;
          m.streamerId = userId;
          m.streamSource = msg.source ?? 'system';
        } else if (m.streamerId === userId) {
          m.streamerId = null;
          m.streamSource = null;
        } else return;
        break;
    }
    this.commit(m);
  }

  /** Someone left a room: their stream ends, and an empty room pauses until someone's back. */
  left(userId: string, roomId: string, roomIsEmpty: boolean): void {
    const m = this.rooms.get(roomId);
    if (!m) return;
    let changed = false;
    if (m.streamerId === userId) {
      m.streamerId = null;
      m.streamSource = null;
      changed = true;
    }
    if (roomIsEmpty && m.playing) {
      this.anchor(m, this.position(m));
      m.playing = false;
      changed = true;
    }
    if (changed) this.commit(m);
  }

  trackRemoved(trackId: string): void {
    for (const m of this.rooms.values()) {
      if (!m.queue.some((q) => q.trackId === trackId)) continue;
      const currentGone = m.queue[m.index]?.trackId === trackId;
      const currentId = m.queue[m.index]?.id;
      const wasPlaying = m.playing;
      m.queue = m.queue.filter((q) => q.trackId !== trackId);
      if (currentGone) {
        const next = Math.min(m.index, m.queue.length);
        if (next < m.queue.length) this.startAt(m, next, wasPlaying);
        else this.stop(m);
      } else {
        m.index = currentId ? m.queue.findIndex((q) => q.id === currentId) : -1;
      }
      this.commit(m);
    }
  }

  roomRemoved(roomId: string): void {
    clearTimeout(this.timers.get(roomId));
    this.timers.delete(roomId);
    this.rooms.delete(roomId);
  }

  close(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  // Helpers

  private current(m: RoomMusic) {
    const item = m.queue[m.index];
    return item ? this.db.getTrack(item.trackId) : undefined;
  }

  private position(m: RoomMusic): number {
    return m.playing ? m.position + (Date.now() - m.anchorAt) / 1000 : m.position;
  }

  private anchor(m: RoomMusic, position: number) {
    m.position = position;
    m.anchorAt = Date.now();
  }

  private startAt(m: RoomMusic, index: number, playing = true) {
    m.index = index;
    m.playing = playing;
    this.anchor(m, 0);
  }

  private stop(m: RoomMusic) {
    m.index = -1;
    m.playing = false;
    this.anchor(m, 0);
  }

  private advance(m: RoomMusic, manual: boolean) {
    if (!manual && m.repeat === 'one') return this.anchor(m, 0);
    if (m.index + 1 < m.queue.length) this.startAt(m, m.index + 1, true);
    else if (m.repeat === 'all' && m.queue.length) this.startAt(m, 0, true);
    else this.stop(m);
  }

  /** Publish the new state and wake up when the current song ends. */
  private commit(m: RoomMusic) {
    clearTimeout(this.timers.get(m.roomId));
    this.timers.delete(m.roomId);
    const track = this.current(m);
    if (m.playing && track && !m.streamerId) {
      const remaining = Math.max(0, track.duration - this.position(m));
      const timer = setTimeout(() => {
        this.timers.delete(m.roomId);
        this.advance(m, false);
        this.commit(m);
      }, remaining * 1000 + END_GRACE_MS);
      timer.unref();
      this.timers.set(m.roomId, timer);
    }
    this.broadcast({ type: 'music.state', music: { ...m, queue: [...m.queue] } });
  }
}
