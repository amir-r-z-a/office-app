import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  const upload = async (file: string, token: string) => {
    const res = await fetch(base + '/api/music', {
      method: 'POST',
      headers: { 'content-type': 'audio/mpeg', 'x-filename': encodeURIComponent(file), authorization: `Bearer ${token}` },
      body: readFileSync(new URL(`./fixtures/${file}`, import.meta.url)),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { ...built, port, base, call, upload, stop };
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
  const next = <T extends ServerMessage['type']>(type: T, match: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true, timeout = 2000) =>
    new Promise<Extract<ServerMessage, { type: T }>>((resolve, reject) => {
      const found = seen.find((m) => m.type === type && match(m as any));
      if (found) return resolve(found as any);
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeout);
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

test('call signals pass only between people in the same room', async () => {
  const s = await start();
  try {
    const setup = (await s.call('POST', '/api/setup', { username: 'boss', displayName: 'Boss', password: 'secret', officeName: 'HQ', sampleLayout: false })).body;
    const admin = setup.token;
    const lounge = (await s.call('POST', '/api/rooms', { name: 'Lounge', kind: 'lounge', ownerId: null, hue: 'amber', lockMode: 'open', capacity: 10, x: 0, y: 0, w: 300, h: 300 }, admin)).body;
    const sam = (await s.call('POST', '/api/users', { username: 'sam', displayName: 'Sam', password: 'pass1', role: 'member' }, admin)).body;
    const samToken = (await s.call('POST', '/api/login', { username: 'sam', password: 'pass1' })).body.token;

    const bossWs = connect(s.port, admin);
    const samWs = connect(s.port, samToken);
    await Promise.all([bossWs.opened, samWs.opened, bossWs.next('snapshot'), samWs.next('snapshot')]);

    // Both in the hallway: the signal is dropped.
    const signal = { description: { type: 'offer', sdp: 'v=0' } };
    bossWs.send({ type: 'rtc.signal', to: sam.id, signal });
    await assert.rejects(samWs.next('rtc.signal'));

    bossWs.send({ type: 'room.enter', roomId: lounge.id });
    samWs.send({ type: 'room.enter', roomId: lounge.id });
    await bossWs.next('presence', (m) => m.presence.userId === sam.id && m.presence.roomId === lounge.id);
    await samWs.next('presence', (m) => m.presence.userId === setup.user.id && m.presence.roomId === lounge.id);
    bossWs.send({ type: 'rtc.signal', to: sam.id, signal });
    const got = await samWs.next('rtc.signal');
    assert.equal(got.from, setup.user.id);
    assert.deepEqual(got.signal, signal);

    // Voice state reaches everyone, and a muted person never shows as speaking.
    samWs.send({ type: 'voice.set', muted: true, deafened: false });
    samWs.send({ type: 'voice.speaking', speaking: true });
    const state = await bossWs.next('voice.state', (m) => m.voice.userId === sam.id);
    assert.equal(state.voice.muted, true);
    assert.equal(state.voice.speaking, false);

    samWs.ws.close();
    bossWs.ws.close();
  } finally {
    await s.stop();
  }
});

test('songs upload with their tags and art, and only the uploader or an admin can remove them', async () => {
  const s = await start();
  try {
    const admin = (await s.call('POST', '/api/setup', { username: 'boss', displayName: 'Boss', password: 'secret', officeName: 'HQ', sampleLayout: false })).body.token;
    await s.call('POST', '/api/users', { username: 'sam', displayName: 'Sam', password: 'pass1', role: 'member' }, admin);
    await s.call('POST', '/api/users', { username: 'kim', displayName: 'Kim', password: 'pass1', role: 'member' }, admin);
    const sam = (await s.call('POST', '/api/login', { username: 'sam', password: 'pass1' })).body.token;
    const kim = (await s.call('POST', '/api/login', { username: 'kim', password: 'pass1' })).body.token;

    const up = await s.upload('tone.mp3', sam);
    assert.equal(up.status, 200);
    assert.equal(up.body.title, 'Test Tone');
    assert.equal(up.body.artist, 'Office Band');
    assert.ok(Math.abs(up.body.duration - 3) < 0.3, `duration ${up.body.duration}`);
    assert.ok(up.body.coverUrl);

    // Players seek with range requests.
    const ranged = await fetch(s.base + up.body.url, { headers: { range: 'bytes=0-99' } });
    assert.equal(ranged.status, 206);
    assert.equal((await ranged.arrayBuffer()).byteLength, 100);
    assert.equal((await fetch(s.base + up.body.coverUrl)).status, 200);

    const notAudio = await fetch(s.base + '/api/music', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-filename': 'notes.txt', authorization: `Bearer ${sam}` },
      body: 'hello',
    });
    assert.equal(notAudio.status, 415);

    assert.equal((await s.call('DELETE', `/api/music/${up.body.id}`, undefined, kim)).status, 403);
    assert.equal((await s.call('DELETE', `/api/music/${up.body.id}`, undefined, admin)).status, 200);
    assert.equal((await fetch(s.base + up.body.url)).status, 404);
  } finally {
    await s.stop();
  }
});

test('a room plays its queue in step, moves on when a song ends, and pauses when everyone leaves', async () => {
  const s = await start();
  try {
    const setup = (await s.call('POST', '/api/setup', { username: 'boss', displayName: 'Boss', password: 'secret', officeName: 'HQ', sampleLayout: false })).body;
    const admin = setup.token;
    const lounge = (await s.call('POST', '/api/rooms', { name: 'Lounge', kind: 'lounge', ownerId: null, hue: 'amber', lockMode: 'open', capacity: 10, x: 0, y: 0, w: 300, h: 300 }, admin)).body;
    const track = (await s.upload('tone.mp3', admin)).body;

    const ws = connect(s.port, admin);
    await ws.opened;
    await ws.next('snapshot');

    // Music needs a room.
    ws.send({ type: 'music.add', trackIds: [track.id] });
    assert.match((await ws.next('notice')).message, /room/);

    ws.send({ type: 'room.enter', roomId: lounge.id });
    await ws.next('presence', (m) => m.presence.roomId === lounge.id);
    ws.send({ type: 'music.add', trackIds: [track.id, track.id] });
    const started = await ws.next('music.state', (m) => m.music.playing);
    assert.equal(started.music.index, 0);
    assert.equal(started.music.queue.length, 2);

    // The clock check answers with server time.
    const t0 = Date.now();
    ws.send({ type: 'time.sync', t0 });
    const sync = await ws.next('time.sync');
    assert.equal(sync.t0, t0);
    assert.ok(Math.abs(sync.server - Date.now()) < 1000);

    // About three seconds later the first song ends and the second starts.
    const second = await ws.next('music.state', (m) => m.music.index === 1, 6000);
    assert.equal(second.music.playing, true);
    assert.equal(second.music.position, 0);

    ws.send({ type: 'room.leave' });
    const paused = await ws.next('music.state', (m) => !m.music.playing && m.music.index === 1);
    assert.ok(paused.music.position >= 0);
    ws.ws.close();
  } finally {
    await s.stop();
  }
});

test('one screen share per room: it can be taken over and ends when the sharer leaves', async () => {
  const s = await start();
  try {
    const setup = (await s.call('POST', '/api/setup', { username: 'boss', displayName: 'Boss', password: 'secret', officeName: 'HQ', sampleLayout: false })).body;
    const admin = setup.token;
    const lounge = (await s.call('POST', '/api/rooms', { name: 'Lounge', kind: 'lounge', ownerId: null, hue: 'amber', lockMode: 'open', capacity: 10, x: 0, y: 0, w: 300, h: 300 }, admin)).body;
    const sam = (await s.call('POST', '/api/users', { username: 'sam', displayName: 'Sam', password: 'pass1', role: 'member' }, admin)).body;
    const samToken = (await s.call('POST', '/api/login', { username: 'sam', password: 'pass1' })).body.token;
    const boss = connect(s.port, admin);
    const samWs = connect(s.port, samToken);
    await Promise.all([boss.opened, samWs.opened, boss.next('snapshot'), samWs.next('snapshot')]);

    boss.send({ type: 'screen.share', on: true });
    assert.match((await boss.next('notice')).message, /room/);

    boss.send({ type: 'room.enter', roomId: lounge.id });
    samWs.send({ type: 'room.enter', roomId: lounge.id });
    await boss.next('presence', (m) => m.presence.userId === sam.id && m.presence.roomId === lounge.id);
    boss.send({ type: 'screen.share', on: true });
    await samWs.next('screen.state', (m) => m.userId === setup.user.id);
    samWs.send({ type: 'screen.share', on: true });
    await boss.next('screen.state', (m) => m.userId === sam.id);
    samWs.send({ type: 'room.leave' });
    const ended = await boss.next('screen.state', (m) => m.userId === null);
    assert.equal(ended.roomId, lounge.id);
    boss.ws.close();
    samWs.ws.close();
  } finally {
    await s.stop();
  }
});
