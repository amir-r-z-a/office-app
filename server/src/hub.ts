import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  entryBlock,
  KNOCK_TIMEOUT_MS,
  type ClientMessage,
  type Floor,
  type Knock,
  type KnockOutcome,
  type Presence,
  type Room,
  type ServerMessage,
  type User,
  type VoiceState,
} from '@office/shared';
import type { Db } from './db.js';

/** How long someone keeps their place after their last connection drops (a reload, a Wi-Fi blip). */
const DISCONNECT_GRACE_MS = 8_000;

interface PendingKnock extends Knock {
  timer: NodeJS.Timeout;
}

/** Live office state: who is connected, where they are, and doorbells in flight. */
export class Hub {
  private sockets = new Map<string, Set<WebSocket>>();
  private location = new Map<string, string | null>();
  private offlineTimers = new Map<string, NodeJS.Timeout>();
  private knocks = new Map<string, PendingKnock>();
  private voice = new Map<string, VoiceState>();

  constructor(private db: Db) {}

  // Connections

  connect(ws: WebSocket, userId: string): void {
    const pending = this.offlineTimers.get(userId);
    if (pending) {
      clearTimeout(pending);
      this.offlineTimers.delete(userId);
    }
    let set = this.sockets.get(userId);
    const wasOnline = !!set?.size || this.location.has(userId);
    if (!set) this.sockets.set(userId, (set = new Set()));
    set.add(ws);

    if (!wasOnline) {
      // Arriving at the office puts you at your own desk, when you have one.
      const home = this.db.listRooms().find((r) => r.kind === 'personal' && r.ownerId === userId);
      this.location.set(userId, home?.id ?? null);
    }

    this.sendTo(ws, { type: 'snapshot', snapshot: this.snapshot(userId) });
    if (!wasOnline) this.broadcastPresence(userId);
    for (const knock of this.knocks.values()) {
      if (knock.fromUserId === userId) this.sendTo(ws, { type: 'knock.pending', knock: publicKnock(knock) });
      else if (this.answerers(knock.roomId).includes(userId)) this.sendTo(ws, { type: 'knock.incoming', knock: publicKnock(knock) });
    }

    ws.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      this.handle(userId, msg, ws);
    });
    ws.on('close', () => this.disconnect(ws, userId));
  }

  private disconnect(ws: WebSocket, userId: string): void {
    const set = this.sockets.get(userId);
    set?.delete(ws);
    if (set?.size) return;
    this.sockets.delete(userId);
    this.offlineTimers.set(
      userId,
      setTimeout(() => {
        this.offlineTimers.delete(userId);
        this.goOffline(userId);
      }, DISCONNECT_GRACE_MS).unref(),
    );
  }

  /** Drop a person from the office at once: logged out, removed, or the grace period ran out. */
  goOffline(userId: string): void {
    for (const ws of this.sockets.get(userId) ?? []) ws.close();
    this.sockets.delete(userId);
    const roomId = this.location.get(userId);
    this.location.delete(userId);
    for (const knock of [...this.knocks.values()]) {
      if (knock.fromUserId === userId) this.resolveKnock(knock.id, 'cancelled');
    }
    const voice = this.voice.get(userId);
    if (voice?.speaking) this.broadcast({ type: 'voice.state', voice: { ...voice, speaking: false } });
    this.voice.delete(userId);
    this.broadcastPresence(userId);
    if (roomId) this.afterRoomChanged(roomId);
  }

  /** Stop every timer, so a closing server exits at once. */
  close(): void {
    for (const t of this.offlineTimers.values()) clearTimeout(t);
    for (const k of this.knocks.values()) clearTimeout(k.timer);
    this.offlineTimers.clear();
    this.knocks.clear();
  }

  // Messages

  private handle(userId: string, msg: ClientMessage, ws: WebSocket): void {
    const user = this.db.getUser(userId);
    if (!user) return;
    switch (msg.type) {
      case 'ping':
        return this.sendTo(ws, { type: 'pong' });
      case 'status.set': {
        const updated = this.db.updateUser(userId, {
          status: msg.status,
          statusText: msg.statusText?.slice(0, 80),
        });
        if (updated) this.broadcast({ type: 'user.upsert', user: updated });
        return;
      }
      case 'room.enter':
        return this.enter(user, msg.roomId);
      case 'room.leave':
        return this.move(userId, null);
      case 'room.knock':
        return this.knock(user, msg.roomId);
      case 'room.setLock': {
        const room = this.db.getRoom(msg.roomId);
        if (!room) return;
        const allowed =
          user.role === 'admin' ||
          (room.kind === 'personal' ? room.ownerId === userId : this.location.get(userId) === room.id);
        if (!allowed) return this.notice(userId, 'error', 'Only the people inside can change this lock.');
        const updated = this.db.updateRoom(room.id, { lockMode: msg.lockMode });
        if (updated) this.broadcast({ type: 'room.upsert', room: updated });
        return;
      }
      case 'knock.respond': {
        const knock = this.knocks.get(msg.knockId);
        if (!knock || !this.answerers(knock.roomId).includes(userId)) return;
        if (!msg.accept) return this.resolveKnock(knock.id, 'declined', userId);
        const room = this.db.getRoom(knock.roomId);
        if (!room) return this.resolveKnock(knock.id, 'cancelled');
        if (this.occupants(room.id).length >= room.capacity) {
          this.notice(userId, 'error', `${room.name} is full.`);
          return this.resolveKnock(knock.id, 'declined', userId);
        }
        // An owner who opens the door from elsewhere comes home to meet their guest.
        if (room.ownerId === userId && this.location.get(userId) !== room.id) this.move(userId, room.id);
        this.resolveKnock(knock.id, 'accepted', userId);
        this.move(knock.fromUserId, room.id);
        return;
      }
      case 'knock.cancel': {
        const knock = this.knocks.get(msg.knockId);
        if (knock?.fromUserId === userId) this.resolveKnock(knock.id, 'cancelled');
        return;
      }
      case 'voice.set':
        return this.setVoice(userId, { muted: !!msg.muted, deafened: !!msg.deafened });
      case 'voice.speaking':
        return this.setVoice(userId, { speaking: !!msg.speaking });
      case 'rtc.signal': {
        // Calls only happen between people in the same room; anything else is dropped.
        const room = this.location.get(userId);
        if (!room || msg.to === userId || this.location.get(msg.to) !== room) return;
        this.send(msg.to, { type: 'rtc.signal', from: userId, signal: msg.signal });
        return;
      }
    }
  }

  private setVoice(userId: string, patch: Partial<Omit<VoiceState, 'userId'>>): void {
    const before = this.voice.get(userId) ?? { userId, muted: false, deafened: false, speaking: false };
    const next = { ...before, ...patch };
    // Nobody hears a muted person, so they never show as speaking.
    if (next.muted) next.speaking = false;
    this.voice.set(userId, next);
    if (next.muted !== before.muted || next.deafened !== before.deafened || next.speaking !== before.speaking) {
      this.broadcast({ type: 'voice.state', voice: next });
    }
  }

  private enter(user: User, roomId: string): void {
    const room = this.db.getRoom(roomId);
    if (!room || this.location.get(user.id) === roomId) return;
    const owner = room.ownerId ? this.db.getUser(room.ownerId) : undefined;
    const block = entryBlock(room, user, this.occupants(roomId).length, owner);
    if (block === 'full') return this.notice(user.id, 'error', `${room.name} is full.`);
    if (block === 'locked') return this.notice(user.id, 'error', `${room.name} is locked.`);
    if (block === 'knock') return this.knock(user, roomId);
    this.move(user.id, roomId);
  }

  private knock(user: User, roomId: string): void {
    const room = this.db.getRoom(roomId);
    if (!room) return;
    const owner = room.ownerId ? this.db.getUser(room.ownerId) : undefined;
    const block = entryBlock(room, user, this.occupants(roomId).length, owner);
    if (block === 'full') return this.notice(user.id, 'error', `${room.name} is full.`);
    if (block === 'locked') return this.notice(user.id, 'error', `${room.name} is locked.`);
    if (block === null) return this.move(user.id, roomId);

    for (const k of [...this.knocks.values()]) {
      if (k.fromUserId === user.id) this.resolveKnock(k.id, 'cancelled');
    }
    const answerers = this.answerers(roomId).filter((id) => id !== user.id);
    const now = Date.now();
    const knock: Knock = { id: randomUUID(), fromUserId: user.id, roomId, createdAt: now, expiresAt: now + KNOCK_TIMEOUT_MS };
    if (!answerers.length) {
      this.send(user.id, { type: 'knock.resolved', knockId: knock.id, roomId, fromUserId: user.id, outcome: 'nobody' });
      return;
    }
    const timer = setTimeout(() => this.resolveKnock(knock.id, 'expired'), KNOCK_TIMEOUT_MS);
    timer.unref();
    this.knocks.set(knock.id, { ...knock, timer });
    this.send(user.id, { type: 'knock.pending', knock });
    for (const id of answerers) this.send(id, { type: 'knock.incoming', knock });
  }

  private resolveKnock(knockId: string, outcome: KnockOutcome, byUserId?: string): void {
    const knock = this.knocks.get(knockId);
    if (!knock) return;
    clearTimeout(knock.timer);
    this.knocks.delete(knockId);
    const msg: ServerMessage = { type: 'knock.resolved', knockId, roomId: knock.roomId, fromUserId: knock.fromUserId, outcome, byUserId };
    const audience = new Set([knock.fromUserId, ...this.answerers(knock.roomId)]);
    for (const id of audience) this.send(id, msg);
  }

  /** Who can open the door: everyone online inside, and the owner wherever they are. */
  private answerers(roomId: string): string[] {
    const room = this.db.getRoom(roomId);
    const ids = new Set(this.occupants(roomId));
    if (room?.ownerId && this.location.has(room.ownerId)) {
      const owner = this.db.getUser(room.ownerId);
      if (owner && owner.status !== 'dnd') ids.add(room.ownerId);
    }
    return [...ids];
  }

  private move(userId: string, roomId: string | null): void {
    const from = this.location.get(userId) ?? null;
    if (from === roomId) return;
    this.location.set(userId, roomId);
    for (const k of [...this.knocks.values()]) {
      if (k.fromUserId === userId) this.resolveKnock(k.id, 'cancelled');
    }
    this.broadcastPresence(userId);
    if (from) this.afterRoomChanged(from);
  }

  /** Shared rooms open up again once the last person leaves. */
  private afterRoomChanged(roomId: string): void {
    const room = this.db.getRoom(roomId);
    if (!room || room.kind === 'personal' || this.occupants(roomId).length) return;
    if (room.lockMode !== 'open') {
      const updated = this.db.updateRoom(roomId, { lockMode: 'open' });
      if (updated) this.broadcast({ type: 'room.upsert', room: updated });
    }
  }

  occupants(roomId: string): string[] {
    return [...this.location].filter(([, r]) => r === roomId).map(([id]) => id);
  }

  // Changes made through the admin API

  userChanged(user: User): void {
    this.broadcast({ type: 'user.upsert', user });
  }

  userRemoved(userId: string): void {
    this.goOffline(userId);
    this.broadcast({ type: 'user.remove', userId });
  }

  roomChanged(room: Room): void {
    this.broadcast({ type: 'room.upsert', room });
  }

  roomRemoved(roomId: string): void {
    for (const k of [...this.knocks.values()]) if (k.roomId === roomId) this.resolveKnock(k.id, 'cancelled');
    for (const id of this.occupants(roomId)) {
      this.location.set(id, null);
      this.broadcastPresence(id);
    }
    this.broadcast({ type: 'room.remove', roomId });
  }

  floorChanged(floor: Floor): void {
    this.broadcast({ type: 'floor.update', floor });
  }

  // Sending

  presence(userId: string): Presence {
    return { userId, online: this.location.has(userId), roomId: this.location.get(userId) ?? null };
  }

  snapshot(meId: string) {
    const users = this.db.listUsers();
    return {
      meId,
      floor: this.db.getFloor(),
      users,
      rooms: this.db.listRooms(),
      presence: users.map((u) => this.presence(u.id)),
      voice: [...this.voice.values()],
    };
  }

  private broadcastPresence(userId: string): void {
    this.broadcast({ type: 'presence', presence: this.presence(userId) });
  }

  private notice(userId: string, level: 'info' | 'error', message: string): void {
    this.send(userId, { type: 'notice', level, message });
  }

  send(userId: string, msg: ServerMessage): void {
    for (const ws of this.sockets.get(userId) ?? []) this.sendTo(ws, msg);
  }

  broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const set of this.sockets.values()) for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(data);
  }

  private sendTo(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }
}

function publicKnock({ timer: _timer, ...knock }: PendingKnock): Knock {
  return knock;
}
