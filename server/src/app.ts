import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { WebSocketServer } from 'ws';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { parseBuffer } from 'music-metadata';
import { join } from 'node:path';
import { z } from 'zod';
import { HUES, LOCK_MODES, MAX_UPLOAD_MB, ROOM_KINDS, type Room, type User } from '@office/shared';
import { Db } from './db.js';
import { Hub } from './hub.js';
import { hashPassword, Tokens, verifyPassword } from './auth.js';

export interface AppOptions {
  dataDir: string;
  /** The built web app to serve, when there is one. */
  webDir?: string;
  logger?: boolean;
}

const hue = z.enum(HUES);
const username = z
  .string()
  .trim()
  .min(2)
  .max(32)
  .regex(/^[a-zA-Z0-9._-]+$/, 'Use letters, numbers, dots, dashes or underscores.');
const password = z.string().min(4).max(128);
const displayName = z.string().trim().min(1).max(48);

const roomFields = z.object({
  name: z.string().trim().min(1).max(40),
  kind: z.enum(ROOM_KINDS),
  ownerId: z.string().nullable(),
  hue,
  lockMode: z.enum(LOCK_MODES),
  capacity: z.number().int().min(1).max(50),
  x: z.number().min(0).max(10_000),
  y: z.number().min(0).max(10_000),
  w: z.number().min(80).max(4_000),
  h: z.number().min(80).max(4_000),
});

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
  }
}

export async function buildApp(opts: AppOptions) {
  mkdirSync(join(opts.dataDir, 'avatars'), { recursive: true });
  const musicDir = join(opts.dataDir, 'music', 'files');
  const coverDir = join(opts.dataDir, 'music', 'covers');
  mkdirSync(musicDir, { recursive: true });
  mkdirSync(coverDir, { recursive: true });
  const db = new Db(join(opts.dataDir, 'office.db'));
  const hub = new Hub(db);
  const tokens = new Tokens(loadSecret(opts.dataDir));
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1024 * 1024 });

  for (const type of [/^audio\//, 'application/octet-stream']) {
    app.addContentTypeParser(type, { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_MB * 1024 * 1024 }, (_req, body, done) => done(null, body));
  }
  app.addContentTypeParser(['image/webp', 'image/png', 'image/jpeg'], { parseAs: 'buffer' }, (_req, body, done) =>
    done(null, body),
  );

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) {
      const issue = err.issues[0];
      return reply.code(400).send({ error: `${issue.path.join('.') || 'input'}: ${issue.message}` });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.code(status).send({ error: status >= 500 ? 'Something went wrong on the server.' : (err as Error).message });
  });

  const authenticate = async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    const userId = tokens.verify(header?.startsWith('Bearer ') ? header.slice(7) : undefined);
    const user = userId ? db.getUser(userId) : undefined;
    if (!user) return reply.code(401).send({ error: 'Please sign in again.' });
    req.user = user;
  };
  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    await authenticate(req, reply);
    if (reply.sent) return;
    if (req.user?.role !== 'admin') return reply.code(403).send({ error: 'Only admins can do that.' });
  };

  // Setup and sign in

  app.get('/api/setup', async () => ({ needsSetup: db.userCount() === 0, floorName: db.getFloor().name }));

  app.post('/api/setup', async (req, reply) => {
    if (db.userCount() > 0) return reply.code(409).send({ error: 'This office is already set up.' });
    const body = z
      .object({ username, displayName, password, officeName: z.string().trim().min(1).max(48), sampleLayout: z.boolean() })
      .parse(req.body);
    const user = db.insertUser({
      id: randomUUID(),
      username: body.username,
      displayName: body.displayName,
      passwordHash: await hashPassword(body.password),
      role: 'admin',
      title: 'Admin',
      hue: 'violet',
      emoji: '',
    });
    db.setFloor({ ...db.getFloor(), name: body.officeName });
    if (body.sampleLayout) seedLayout(db, user.id);
    return { token: tokens.issue(user.id), user };
  });

  app.post('/api/login', async (req, reply) => {
    const body = z.object({ username: z.string(), password: z.string() }).parse(req.body);
    const creds = db.findCredentials(body.username.trim());
    if (!creds || !(await verifyPassword(body.password, creds.passwordHash))) {
      return reply.code(401).send({ error: 'That username and password don’t match.' });
    }
    return { token: tokens.issue(creds.id), user: db.getUser(creds.id) };
  });

  // Your own profile

  app.get('/api/me', { preHandler: authenticate }, async (req) => req.user);

  app.patch('/api/me', { preHandler: authenticate }, async (req, reply) => {
    const body = z
      .object({
        displayName: displayName.optional(),
        title: z.string().trim().max(48).optional(),
        hue: hue.optional(),
        emoji: z.string().max(8).optional(),
        currentPassword: z.string().optional(),
        newPassword: password.optional(),
      })
      .parse(req.body);
    let passwordHash: string | undefined;
    if (body.newPassword) {
      const creds = db.findCredentials(req.user!.username)!;
      if (!(await verifyPassword(body.currentPassword ?? '', creds.passwordHash))) {
        return reply.code(400).send({ error: 'Your current password isn’t right.' });
      }
      passwordHash = await hashPassword(body.newPassword);
    }
    const user = db.updateUser(req.user!.id, {
      displayName: body.displayName,
      title: body.title,
      hue: body.hue,
      emoji: body.emoji,
      passwordHash,
    })!;
    hub.userChanged(user);
    return user;
  });

  app.put('/api/me/avatar', { preHandler: authenticate, bodyLimit: 600 * 1024 }, async (req, reply) => {
    const body = req.body;
    if (!Buffer.isBuffer(body) || !body.length) return reply.code(400).send({ error: 'Send the picture as an image.' });
    writeFileSync(join(opts.dataDir, 'avatars', `${req.user!.id}.webp`), body);
    const user = db.updateUser(req.user!.id, { avatarVersion: Date.now() })!;
    hub.userChanged(user);
    return user;
  });

  app.delete('/api/me/avatar', { preHandler: authenticate }, async (req) => {
    rmSync(join(opts.dataDir, 'avatars', `${req.user!.id}.webp`), { force: true });
    const user = db.updateUser(req.user!.id, { avatarVersion: null })!;
    hub.userChanged(user);
    return user;
  });

  // People (admin)

  app.post('/api/users', { preHandler: requireAdmin }, async (req, reply) => {
    const body = z
      .object({
        username,
        displayName,
        password,
        role: z.enum(['admin', 'member']),
        title: z.string().trim().max(48).default(''),
        hue: hue.default('violet'),
      })
      .parse(req.body);
    if (db.findCredentials(body.username)) return reply.code(409).send({ error: 'That username is taken.' });
    const { password: pw, ...rest } = body;
    const user = db.insertUser({ ...rest, id: randomUUID(), emoji: '', passwordHash: await hashPassword(pw) });
    hub.userChanged(user);
    return user;
  });

  app.patch<{ Params: { id: string } }>('/api/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const target = db.getUser(req.params.id);
    if (!target) return reply.code(404).send({ error: 'No such person.' });
    const body = z
      .object({
        username: username.optional(),
        displayName: displayName.optional(),
        password: password.optional(),
        role: z.enum(['admin', 'member']).optional(),
        title: z.string().trim().max(48).optional(),
        hue: hue.optional(),
      })
      .parse(req.body);
    if (body.username && body.username.toLowerCase() !== target.username.toLowerCase() && db.findCredentials(body.username)) {
      return reply.code(409).send({ error: 'That username is taken.' });
    }
    if (body.role === 'member' && target.role === 'admin' && db.adminCount() === 1) {
      return reply.code(400).send({ error: 'The office needs at least one admin.' });
    }
    const { password: pw, ...rest } = body;
    const user = db.updateUser(target.id, { ...rest, passwordHash: pw ? await hashPassword(pw) : undefined })!;
    hub.userChanged(user);
    return user;
  });

  app.delete<{ Params: { id: string } }>('/api/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const target = db.getUser(req.params.id);
    if (!target) return reply.code(404).send({ error: 'No such person.' });
    if (target.id === req.user!.id) return reply.code(400).send({ error: 'You can’t remove yourself.' });
    db.deleteUser(target.id);
    rmSync(join(opts.dataDir, 'avatars', `${target.id}.webp`), { force: true });
    hub.userRemoved(target.id);
    // Their personal rooms stay on the map, now without an owner.
    for (const room of db.listRooms()) if (room.ownerId === null && room.kind === 'personal') hub.roomChanged(room);
    return { ok: true };
  });

  // Rooms and the floor (admin)

  app.post('/api/rooms', { preHandler: requireAdmin }, async (req) => {
    const body = roomFields.parse(req.body);
    const room = db.insertRoom({ ...body, id: randomUUID() });
    hub.roomChanged(room);
    return room;
  });

  app.patch<{ Params: { id: string } }>('/api/rooms/:id', { preHandler: requireAdmin }, async (req, reply) => {
    if (!db.getRoom(req.params.id)) return reply.code(404).send({ error: 'No such room.' });
    const body = roomFields.partial().parse(req.body);
    if (body.ownerId && !db.getUser(body.ownerId)) return reply.code(400).send({ error: 'No such person.' });
    const room = db.updateRoom(req.params.id, body)!;
    hub.roomChanged(room);
    return room;
  });

  app.delete<{ Params: { id: string } }>('/api/rooms/:id', { preHandler: requireAdmin }, async (req) => {
    db.deleteRoom(req.params.id);
    hub.roomRemoved(req.params.id);
    return { ok: true };
  });

  app.put('/api/floor', { preHandler: requireAdmin }, async (req) => {
    const floor = z
      .object({
        name: z.string().trim().min(1).max(48),
        width: z.number().int().min(600).max(10_000),
        height: z.number().int().min(400).max(10_000),
      })
      .parse(req.body);
    db.setFloor(floor);
    hub.floorChanged(floor);
    return floor;
  });

  // Music library

  app.post('/api/music', { preHandler: authenticate, bodyLimit: MAX_UPLOAD_MB * 1024 * 1024 }, async (req, reply) => {
    const body = req.body;
    if (!Buffer.isBuffer(body) || !body.length) return reply.code(400).send({ error: 'Send the song as an audio file.' });
    const filename = decodeURIComponent(String(req.headers['x-filename'] ?? 'Untitled'));
    const ext = audioExtension(filename, String(req.headers['content-type'] ?? ''));
    if (!ext) return reply.code(415).send({ error: `${filename}: use MP3, M4A, AAC, OGG, Opus, FLAC, WAV or WebM.` });

    let meta;
    try {
      meta = await parseBuffer(body, { mimeType: String(req.headers['content-type'] ?? ''), size: body.length }, { duration: true });
    } catch {
      return reply.code(415).send({ error: `${filename} doesn’t look like a song this server can read.` });
    }
    const duration = meta.format.duration;
    if (!duration || !Number.isFinite(duration)) return reply.code(415).send({ error: `Couldn’t work out how long ${filename} is.` });

    const id = randomUUID();
    writeFileSync(join(musicDir, `${id}${ext}`), body);
    let cover: string | null = null;
    const picture = meta.common.picture?.[0];
    if (picture?.data?.length) {
      const coverExt = picture.format.includes('png') ? '.png' : picture.format.includes('webp') ? '.webp' : '.jpg';
      cover = `${id}${coverExt}`;
      writeFileSync(join(coverDir, cover), picture.data);
    }
    const fallbackTitle = filename.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim() || 'Untitled';
    const track = db.insertTrack({
      id,
      title: (meta.common.title || fallbackTitle).slice(0, 120),
      artist: (meta.common.artist || meta.common.albumartist || '').slice(0, 120),
      album: (meta.common.album || '').slice(0, 120),
      duration,
      file: `${id}${ext}`,
      cover,
      uploadedBy: req.user!.id,
    });
    hub.libraryChanged(track);
    return track;
  });

  const canEditTrack = (user: User, uploadedBy: string | null) => user.role === 'admin' || uploadedBy === user.id;

  app.patch<{ Params: { id: string } }>('/api/music/:id', { preHandler: authenticate }, async (req, reply) => {
    const track = db.getTrack(req.params.id);
    if (!track) return reply.code(404).send({ error: 'No such song.' });
    if (!canEditTrack(req.user!, track.uploadedBy)) return reply.code(403).send({ error: 'Only the person who added this song, or an admin, can change it.' });
    const body = z.object({ title: z.string().trim().min(1).max(120).optional(), artist: z.string().trim().max(120).optional() }).parse(req.body);
    const updated = db.updateTrack(track.id, body)!;
    hub.libraryChanged(updated);
    return updated;
  });

  app.delete<{ Params: { id: string } }>('/api/music/:id', { preHandler: authenticate }, async (req, reply) => {
    const track = db.getTrack(req.params.id);
    if (!track) return reply.code(404).send({ error: 'No such song.' });
    if (!canEditTrack(req.user!, track.uploadedBy)) return reply.code(403).send({ error: 'Only the person who added this song, or an admin, can remove it.' });
    db.deleteTrack(track.id);
    rmSync(join(musicDir, track.file), { force: true });
    if (track.cover) rmSync(join(coverDir, track.cover), { force: true });
    hub.libraryRemoved(track.id);
    return { ok: true };
  });

  // Files

  await app.register(fastifyStatic, {
    root: join(opts.dataDir, 'avatars'),
    prefix: '/avatars/',
    decorateReply: false,
    maxAge: '365d',
    immutable: true,
  });
  // Song files are served with range requests, so players can seek without downloading everything.
  await app.register(fastifyStatic, { root: musicDir, prefix: '/music/files/', decorateReply: false, maxAge: '365d', immutable: true });
  await app.register(fastifyStatic, { root: coverDir, prefix: '/music/covers/', decorateReply: false, maxAge: '365d', immutable: true });
  if (opts.webDir && existsSync(opts.webDir)) {
    await app.register(fastifyStatic, { root: opts.webDir, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/avatars/') || req.url.startsWith('/music/')) return reply.code(404).send({ error: 'Not found.' });
      return reply.type('text/html').send(readFileSync(join(opts.webDir!, 'index.html')));
    });
  }

  // Realtime

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  app.server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://office');
    if (url.pathname !== '/ws') return socket.destroy();
    const userId = tokens.verify(url.searchParams.get('token') ?? undefined);
    if (!userId || !db.getUser(userId)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => hub.connect(ws, userId));
  });
  app.addHook('onClose', async () => {
    for (const client of wss.clients) client.terminate();
    wss.close();
    hub.close();
  });

  return { app, db, hub, tokens };
}

const AUDIO_TYPES: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
  'audio/webm': '.webm',
};
const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.wav', '.webm']);

/** The file extension to store a song under, from its name or its type; null if it isn't audio we play. */
function audioExtension(filename: string, contentType: string): string | null {
  const fromName = filename.match(/\.[a-z0-9]+$/i)?.[0].toLowerCase();
  if (fromName && AUDIO_EXTENSIONS.has(fromName)) return fromName;
  return AUDIO_TYPES[contentType.split(';')[0].trim().toLowerCase()] ?? null;
}

function loadSecret(dataDir: string): string {
  const file = join(dataDir, 'secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const secret = randomBytes(32).toString('base64url');
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

/** A starter floor so a new office isn't an empty grid: the admin's desk and three shared spaces. */
function seedLayout(db: Db, adminId: string): void {
  const rooms: Omit<Room, 'id'>[] = [
    { name: 'Admin’s Office', kind: 'personal', ownerId: adminId, hue: 'violet', lockMode: 'knock', capacity: 4, x: 80, y: 80, w: 300, h: 240 },
    { name: 'The Lounge', kind: 'lounge', ownerId: null, hue: 'amber', lockMode: 'open', capacity: 15, x: 460, y: 80, w: 520, h: 300 },
    { name: 'Big Meeting Room', kind: 'meeting', ownerId: null, hue: 'sky', lockMode: 'open', capacity: 15, x: 1060, y: 80, w: 460, h: 300 },
    { name: 'Focus Booth', kind: 'meeting', ownerId: null, hue: 'mint', lockMode: 'open', capacity: 3, x: 1060, y: 460, w: 220, h: 200 },
  ];
  for (const room of rooms) db.insertRoom({ ...room, id: randomUUID() });
}
