import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Floor, Hue, LockMode, Role, Room, RoomKind, Status, User } from '@office/shared';

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: Role;
  title: string;
  hue: Hue;
  emoji: string;
  avatar_version: number | null;
  status: Status;
  status_text: string;
}

interface RoomRow {
  id: string;
  name: string;
  kind: RoomKind;
  owner_id: string | null;
  hue: Hue;
  lock_mode: LockMode;
  capacity: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  title TEXT NOT NULL DEFAULT '',
  hue TEXT NOT NULL DEFAULT 'violet',
  emoji TEXT NOT NULL DEFAULT '',
  avatar_version INTEGER,
  status TEXT NOT NULL DEFAULT 'available',
  status_text TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  hue TEXT NOT NULL DEFAULT 'violet',
  lock_mode TEXT NOT NULL DEFAULT 'knock',
  capacity INTEGER NOT NULL DEFAULT 4,
  x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export class Db {
  private db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  // Users

  userCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  listUsers(): User[] {
    return (this.db.prepare('SELECT * FROM users ORDER BY display_name').all() as unknown as UserRow[]).map(toUser);
  }

  getUser(id: string): User | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row && toUser(row);
  }

  findCredentials(username: string): { id: string; passwordHash: string } | undefined {
    const row = this.db.prepare('SELECT id, password_hash FROM users WHERE username = ?').get(username) as
      | { id: string; password_hash: string }
      | undefined;
    return row && { id: row.id, passwordHash: row.password_hash };
  }

  insertUser(u: Omit<User, 'avatarUrl' | 'status' | 'statusText'> & { passwordHash: string }): User {
    this.db
      .prepare(
        `INSERT INTO users (id, username, display_name, password_hash, role, title, hue, emoji, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(u.id, u.username, u.displayName, u.passwordHash, u.role, u.title, u.hue, u.emoji, Date.now());
    return this.getUser(u.id)!;
  }

  updateUser(
    id: string,
    patch: Partial<Pick<User, 'username' | 'displayName' | 'role' | 'title' | 'hue' | 'emoji' | 'status' | 'statusText'>> & {
      passwordHash?: string;
      avatarVersion?: number | null;
    },
  ): User | undefined {
    const columns: Record<string, string> = {
      username: 'username',
      displayName: 'display_name',
      role: 'role',
      title: 'title',
      hue: 'hue',
      emoji: 'emoji',
      status: 'status',
      statusText: 'status_text',
      passwordHash: 'password_hash',
      avatarVersion: 'avatar_version',
    };
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || !columns[key]) continue;
      sets.push(`${columns[key]} = ?`);
      values.push(value as string | number | null);
    }
    if (sets.length) this.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    return this.getUser(id);
  }

  deleteUser(id: string): void {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }

  adminCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).get() as { n: number }).n;
  }

  // Rooms

  listRooms(): Room[] {
    return (this.db.prepare('SELECT * FROM rooms ORDER BY name').all() as unknown as RoomRow[]).map(toRoom);
  }

  getRoom(id: string): Room | undefined {
    const row = this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as RoomRow | undefined;
    return row && toRoom(row);
  }

  insertRoom(r: Room): Room {
    this.db
      .prepare(
        `INSERT INTO rooms (id, name, kind, owner_id, hue, lock_mode, capacity, x, y, w, h)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.id, r.name, r.kind, r.ownerId, r.hue, r.lockMode, r.capacity, r.x, r.y, r.w, r.h);
    return this.getRoom(r.id)!;
  }

  updateRoom(id: string, patch: Partial<Omit<Room, 'id'>>): Room | undefined {
    const columns: Record<string, string> = {
      name: 'name',
      kind: 'kind',
      ownerId: 'owner_id',
      hue: 'hue',
      lockMode: 'lock_mode',
      capacity: 'capacity',
      x: 'x',
      y: 'y',
      w: 'w',
      h: 'h',
    };
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || !columns[key]) continue;
      sets.push(`${columns[key]} = ?`);
      values.push(value as string | number | null);
    }
    if (sets.length) this.db.prepare(`UPDATE rooms SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    return this.getRoom(id);
  }

  deleteRoom(id: string): void {
    this.db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
  }


  // Settings

  getSetting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  getFloor(): Floor {
    const raw = this.getSetting('floor');
    return raw ? (JSON.parse(raw) as Floor) : { name: 'Our Office', width: 1600, height: 1000 };
  }

  setFloor(floor: Floor): void {
    this.setSetting('floor', JSON.stringify(floor));
  }
}

function toUser(r: UserRow): User {
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    role: r.role,
    title: r.title,
    hue: r.hue,
    emoji: r.emoji,
    avatarUrl: r.avatar_version ? `/avatars/${r.id}.webp?v=${r.avatar_version}` : null,
    status: r.status,
    statusText: r.status_text,
  };
}

function toRoom(r: RoomRow): Room {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    ownerId: r.owner_id,
    hue: r.hue,
    lockMode: r.lock_mode,
    capacity: r.capacity,
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.h,
  };
}
