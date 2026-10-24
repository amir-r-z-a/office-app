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

export type KnockOutcome = 'accepted' | 'declined' | 'expired' | 'cancelled' | 'nobody';

export interface Snapshot {
  meId: string;
  floor: Floor;
  users: User[];
  rooms: Room[];
  presence: Presence[];
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
