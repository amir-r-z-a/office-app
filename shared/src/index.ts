// Domain model and realtime protocol shared by the server and the app.

export type Role = 'admin' | 'member';
export type Status = 'available' | 'busy' | 'away' | 'dnd';
export type RoomKind = 'personal' | 'meeting' | 'lounge';
/** open: walk in. knock: ring the bell and wait. locked: no visitors. */
export type LockMode = 'open' | 'knock' | 'locked';

export const STATUSES: Status[] = ['available', 'busy', 'away', 'dnd'];
export const ROOM_KINDS: RoomKind[] = ['personal', 'meeting', 'lounge'];
export const LOCK_MODES: LockMode[] = ['open', 'knock', 'locked'];
/** Room and avatar tints; the app maps each to a light and a dark color. */
export const HUES = ['violet', 'coral', 'mint', 'sky', 'amber', 'rose', 'lime', 'indigo'] as const;
export type Hue = (typeof HUES)[number];

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  title: string;
  hue: Hue;
  emoji: string;
  /** Path of the uploaded picture, or null to draw initials or the emoji. */
  avatarUrl: string | null;
  status: Status;
  statusText: string;
}

export interface Room {
  id: string;
  name: string;
  kind: RoomKind;
  ownerId: string | null;
  hue: Hue;
  lockMode: LockMode;
  capacity: number;
  /** Position and size on the floor plan, in floor units. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Floor {
  name: string;
  width: number;
  height: number;
}

export interface Presence {
  userId: string;
  online: boolean;
  roomId: string | null;
}

export interface Knock {
  id: string;
  fromUserId: string;
  roomId: string;
  createdAt: number;
  expiresAt: number;
}

/** What everyone can see about a person's voice: shown on the map and in room lists. */
export interface VoiceState {
  userId: string;
  muted: boolean;
  deafened: boolean;
  speaking: boolean;
}

/** WebRTC negotiation, relayed by the server between two people in the same room. */
export type RtcSignal = { session: string } & (
  | { description: { type: 'offer' | 'answer' | 'pranswer' | 'rollback'; sdp?: string } }
  | { candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null; usernameFragment?: string | null } | null }
  /** "I'm here": sent by the answering side when it opens a call. */
  | { hello: true }
);

/** A song in the office library. */
export interface Track {
  id: string;
  title: string;
  artist: string;
  album: string;
  /** Seconds. */
  duration: number;
  uploadedBy: string | null;
  /** Path of the album art, or null to draw a placeholder. */
  coverUrl: string | null;
  url: string;
  createdAt: number;
}

export interface QueueItem {
  id: string;
  trackId: string;
  addedBy: string;
}

export type RepeatMode = 'off' | 'all' | 'one';

/**
 * What's playing in a room. While playing, the position at server time `t` is
 * `position + (t - anchorAt) / 1000`; while paused it is `position`.
 */
export interface RoomMusic {
  roomId: string;
  queue: QueueItem[];
  /** Index into `queue` of the current song, or -1. */
  index: number;
  playing: boolean;
  position: number;
  anchorAt: number;
  repeat: RepeatMode;
  /** Someone sharing their computer's audio instead of the queue. */
  streamerId: string | null;
}

export const MAX_UPLOAD_MB = 60;

export type KnockOutcome = 'accepted' | 'declined' | 'expired' | 'cancelled' | 'nobody';

export interface Snapshot {
  meId: string;
  floor: Floor;
  users: User[];
  rooms: Room[];
  presence: Presence[];
  voice: VoiceState[];
  library: Track[];
  music: RoomMusic[];
}

/** Messages the app sends over the socket. */
export type ClientMessage =
  | { type: 'status.set'; status: Status; statusText?: string }
  | { type: 'room.enter'; roomId: string }
  | { type: 'room.leave' }
  | { type: 'room.knock'; roomId: string }
  | { type: 'room.setLock'; roomId: string; lockMode: LockMode }
  | { type: 'knock.respond'; knockId: string; accept: boolean }
  | { type: 'knock.cancel'; knockId: string }
  | { type: 'voice.set'; muted: boolean; deafened: boolean }
  | { type: 'voice.speaking'; speaking: boolean }
  | { type: 'rtc.signal'; to: string; signal: RtcSignal }
  | { type: 'time.sync'; t0: number }
  /** Music controls act on the room you're in. */
  | { type: 'music.add'; trackIds: string[]; playNext?: boolean }
  | { type: 'music.playNow'; trackId: string }
  | { type: 'music.jump'; itemId: string }
  | { type: 'music.remove'; itemId: string }
  | { type: 'music.move'; itemId: string; toIndex: number }
  | { type: 'music.clear' }
  | { type: 'music.toggle'; playing: boolean }
  | { type: 'music.seek'; position: number }
  | { type: 'music.next' }
  | { type: 'music.prev' }
  | { type: 'music.repeat'; mode: RepeatMode }
  | { type: 'music.stream'; on: boolean }
  | { type: 'ping' };

/** Messages the server sends over the socket. */
export type ServerMessage =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'user.upsert'; user: User }
  | { type: 'user.remove'; userId: string }
  | { type: 'room.upsert'; room: Room }
  | { type: 'room.remove'; roomId: string }
  | { type: 'floor.update'; floor: Floor }
  | { type: 'presence'; presence: Presence }
  /** Sent to the people who can open the door. */
  | { type: 'knock.incoming'; knock: Knock }
  /** Sent to the knocker while they wait. */
  | { type: 'knock.pending'; knock: Knock }
  | { type: 'knock.resolved'; knockId: string; roomId: string; fromUserId: string; outcome: KnockOutcome; byUserId?: string }
  | { type: 'voice.state'; voice: VoiceState }
  | { type: 'time.sync'; t0: number; server: number }
  | { type: 'library.upsert'; track: Track }
  | { type: 'library.remove'; trackId: string }
  | { type: 'music.state'; music: RoomMusic }
  | { type: 'rtc.signal'; from: string; signal: RtcSignal }
  | { type: 'notice'; level: 'info' | 'error'; message: string }
  | { type: 'pong' };

export const KNOCK_TIMEOUT_MS = 30_000;

/** Why a person may not walk straight into a room, or null when they may. */
export function entryBlock(
  room: Room,
  user: User,
  occupants: number,
  owner: User | undefined,
): 'full' | 'locked' | 'knock' | null {
  if (room.ownerId === user.id) return null;
  if (occupants >= room.capacity) return 'full';
  const lock = room.kind === 'personal' && owner?.status === 'dnd' ? 'locked' : room.lockMode;
  if (lock === 'locked') return 'locked';
  if (lock === 'knock') return 'knock';
  return null;
}
