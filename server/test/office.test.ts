import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import type { ServerMessage } from '@office/shared';
import { buildApp } from '../src/app.js';

async function start() {
  const dataDir = mkdtempSync(join(tmpdir(), 'office-'));
  const built = await buildApp({ dataDir });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const address = built.app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const stop = async () => {
    await built.app.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { ...built, port, call, stop };
}

/** A socket that records every message and can wait for one matching a test. */
function connect(port: number, token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  const seen: ServerMessage[] = [];
  const waiters: { match: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw)) as ServerMessage;
    seen.push(msg);
    for (const w of [...waiters]) if (w.match(msg)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(msg);
    }
  });
  const next = <T extends ServerMessage['type']>(type: T, match: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true) =>
    new Promise<Extract<ServerMessage, { type: T }>>((resolve, reject) => {
      const found = seen.find((m) => m.type === type && match(m as any));
      if (found) return resolve(found as any);
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 2000);
      waiters.push({ match: (m) => m.type === type && match(m as any), resolve: (m) => (clearTimeout(timer), resolve(m as any)) });
    });
  const send = (msg: object) => ws.send(JSON.stringify(msg));
  return { ws, next, send, opened: new Promise((r) => ws.once('open', r)) };
}

test('first run sets up an admin, and nobody can do it twice', async () => {
  const s = await start();
  try {
    assert.equal((await s.call('GET', '/api/setup')).body.needsSetup, true);
    const setup = await s.call('POST', '/api/setup', { username: 'boss', displayName: 'Boss', password: 'secret', officeName: 'HQ', sampleLayout: true });
    assert.equal(setup.status, 200);
    assert.equal(setup.body.user.role, 'admin');
    assert.equal((await s.call('GET', '/api/setup')).body.needsSetup, false);
    assert.equal((await s.call('POST', '/api/setup', { username: 'x', displayName: 'X', password: 'secret', officeName: 'HQ', sampleLayout: false })).status, 409);
    assert.equal((await s.call('POST', '/api/login', { username: 'boss', password: 'wrong' })).status, 401);
    assert.equal((await s.call('POST', '/api/login', { username: 'BOSS', password: 'secret' })).status, 200);
  } finally {
    await s.stop();
  }
});

test('members cannot use the admin API', async () => {
  const s = await start();
  try {
    const admin = (await s.call('POST', '/api/setup', { username: 'boss', displayName: 'Boss', password: 'secret', officeName: 'HQ', sampleLayout: false })).body.token;
    await s.call('POST', '/api/users', { username: 'sam', displayName: 'Sam', password: 'pass1', role: 'member' }, admin);
    const sam = (await s.call('POST', '/api/login', { username: 'sam', password: 'pass1' })).body.token;
    const res = await s.call('POST', '/api/users', { username: 'eve', displayName: 'Eve', password: 'pass1', role: 'admin' }, sam);
    assert.equal(res.status, 403);
  } finally {
    await s.stop();
  }
});

test('ringing the bell: the owner accepts and the guest walks in', async () => {
  const s = await start();
  try {
    const setup = (await s.call('POST', '/api/setup', { username: 'boss', displayName: 'Boss', password: 'secret', officeName: 'HQ', sampleLayout: false })).body;
    const adminToken = setup.token;
    const sam = (await s.call('POST', '/api/users', { username: 'sam', displayName: 'Sam', password: 'pass1', role: 'member' }, adminToken)).body;
    const room = (
      await s.call('POST', '/api/rooms', { name: 'Sam’s Room', kind: 'personal', ownerId: sam.id, hue: 'mint', lockMode: 'knock', capacity: 4, x: 0, y: 0, w: 200, h: 200 }, adminToken)
    ).body;
    const samToken = (await s.call('POST', '/api/login', { username: 'sam', password: 'pass1' })).body.token;

    const samWs = connect(s.port, samToken);
    await samWs.opened;
    // Sam arrives at their own desk.
    await samWs.next('presence', (m) => m.presence.userId === sam.id && m.presence.roomId === room.id).catch(() => null);
    const snap = await samWs.next('snapshot');
    assert.equal(snap.snapshot.presence.find((p) => p.userId === sam.id)?.roomId, room.id);

    const bossWs = connect(s.port, adminToken);
    await bossWs.opened;
    await bossWs.next('snapshot');

    bossWs.send({ type: 'room.enter', roomId: room.id });
    const pending = await bossWs.next('knock.pending');
    const incoming = await samWs.next('knock.incoming');
    assert.equal(incoming.knock.id, pending.knock.id);

    samWs.send({ type: 'knock.respond', knockId: incoming.knock.id, accept: true });
    const resolved = await bossWs.next('knock.resolved');
    assert.equal(resolved.outcome, 'accepted');
    await bossWs.next('presence', (m) => m.presence.userId === setup.user.id && m.presence.roomId === room.id);

    // Locked rooms can't be rung.
    bossWs.send({ type: 'room.leave' });
    await bossWs.next('presence', (m) => m.presence.userId === setup.user.id && m.presence.roomId === null);
    samWs.send({ type: 'room.setLock', roomId: room.id, lockMode: 'locked' });
    await bossWs.next('room.upsert', (m) => m.room.lockMode === 'locked');
    bossWs.send({ type: 'room.knock', roomId: room.id });
    const notice = await bossWs.next('notice');
    assert.match(notice.message, /locked/);

    samWs.ws.close();
    bossWs.ws.close();
  } finally {
    await s.stop();
  }
});
