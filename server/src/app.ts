import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { WebSocketServer } from 'ws';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { HUES, LOCK_MODES, ROOM_KINDS, type Room, type User } from '@office/shared';
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
  const db = new Db(join(opts.dataDir, 'office.db'));
  const hub = new Hub(db);
  const tokens = new Tokens(loadSecret(opts.dataDir));
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1024 * 1024 });

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

  // Files

  await app.register(fastifyStatic, {
    root: join(opts.dataDir, 'avatars'),
    prefix: '/avatars/',
    decorateReply: false,
    maxAge: '365d',
    immutable: true,
  });
  if (opts.webDir && existsSync(opts.webDir)) {
    await app.register(fastifyStatic, { root: opts.webDir, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/avatars/')) return reply.code(404).send({ error: 'Not found.' });
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
