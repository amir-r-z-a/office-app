import { create } from 'zustand';
import type { ClientMessage, Floor, Knock, Presence, Room, RoomMusic, RtcSignal, ServerMessage, Track, User, VoiceState } from '@office/shared';
import { api, ApiError, getToken, setToken } from './api';
import { desktop } from './desktop';
import { playDecline, playDoorbell, playLeave, playPop } from './sound';

export type Phase = 'loading' | 'unreachable' | 'setup' | 'login' | 'ready';
export type View = 'office' | 'admin';

export interface Toast {
  id: string;
  tone: 'info' | 'success' | 'error';
  title: string;
  body?: string;
  userId?: string;
}

interface State {
  phase: Phase;
  officeName: string;
  connection: 'connecting' | 'online' | 'reconnecting';
  meId: string | null;
  floor: Floor;
  users: Record<string, User>;
  rooms: Record<string, Room>;
  presence: Record<string, Presence>;
  voice: Record<string, VoiceState>;
  library: Record<string, Track>;
  music: Record<string, RoomMusic>;
  incoming: Knock[];
  outgoing: Knock | null;
  toasts: Toast[];
  view: View;
  selectedRoomId: string | null;
  profileOpen: boolean;

  boot: () => Promise<void>;
  signedIn: (token: string, user: User) => void;
  signOut: () => void;
  send: (msg: ClientMessage) => void;
  toast: (t: Omit<Toast, 'id'>) => void;
  dismissToast: (id: string) => void;
  setView: (view: View) => void;
  selectRoom: (id: string | null) => void;
  setProfileOpen: (open: boolean) => void;
  /** Apply an admin change at once, before the server's echo arrives. */
  putUser: (user: User) => void;
  putRoom: (room: Room) => void;
}

let socket: WebSocket | null = null;
let retry = 0;
let retryTimer: number | undefined;
let pingTimer: number | undefined;
let wanted = false;
let rtcHandler: ((from: string, signal: RtcSignal) => void) | null = null;

let timeSyncHandler: ((t0: number, server: number) => void) | null = null;

/** The voice engine takes call signals from here; set once at startup. */
export function onRtcSignal(handler: (from: string, signal: RtcSignal) => void) {
  rtcHandler = handler;
}

/** The music player takes clock-sync replies from here. */
export function onTimeSync(handler: (t0: number, server: number) => void) {
  timeSyncHandler = handler;
}

export const useStore = create<State>((set, get) => ({
  phase: 'loading',
  officeName: '',
  connection: 'connecting',
  meId: null,
  floor: { name: '', width: 1600, height: 1000 },
  users: {},
  rooms: {},
  presence: {},
  voice: {},
  library: {},
  music: {},
  incoming: [],
  outgoing: null,
  toasts: [],
  view: 'office',
  selectedRoomId: null,
  profileOpen: false,

  boot: async () => {
    set({ phase: 'loading' });
    try {
      const { needsSetup, floorName } = await api.setupState();
      set({ officeName: floorName });
      if (needsSetup) return set({ phase: 'setup' });
      if (!getToken()) return set({ phase: 'login' });
      const me = await api.me();
      get().signedIn(getToken()!, me);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setToken(null);
        return set({ phase: 'login' });
      }
      set({ phase: 'unreachable' });
    }
  },

  signedIn: (token, user) => {
    setToken(token);
    set({ meId: user.id, users: { ...get().users, [user.id]: user }, phase: 'ready' });
    wanted = true;
    openSocket();
  },

  signOut: () => {
    wanted = false;
    setToken(null);
    socket?.close();
    socket = null;
    set({ phase: 'login', meId: null, users: {}, rooms: {}, presence: {}, voice: {}, library: {}, music: {}, incoming: [], outgoing: null, view: 'office', selectedRoomId: null });
  },

  send: (msg) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
    else get().toast({ tone: 'error', title: 'You’re offline', body: 'Reconnecting to the office…' });
  },

  toast: (t) => {
    const id = Math.random().toString(36).slice(2);
    set({ toasts: [...get().toasts, { ...t, id }].slice(-4) });
    window.setTimeout(() => get().dismissToast(id), t.tone === 'error' ? 6000 : 4200);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  setView: (view) => set({ view, selectedRoomId: null }),
  selectRoom: (selectedRoomId) => set({ selectedRoomId }),
  setProfileOpen: (profileOpen) => set({ profileOpen }),
  putUser: (user) => set({ users: { ...get().users, [user.id]: user } }),
  putRoom: (room) => set({ rooms: { ...get().rooms, [room.id]: room } }),
}));

function openSocket() {
  window.clearTimeout(retryTimer);
  const token = getToken();
  if (!token || !wanted) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
  socket = ws;
  useStore.setState({ connection: retry ? 'reconnecting' : 'connecting' });

  ws.onmessage = (e) => handle(JSON.parse(e.data) as ServerMessage);
  ws.onopen = () => {
    retry = 0;
    window.clearInterval(pingTimer);
    pingTimer = window.setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('{"type":"ping"}'), 20_000);
  };
  ws.onclose = (e) => {
    window.clearInterval(pingTimer);
    if (socket !== ws || !wanted) return;
    if (e.code === 1006 && retry > 3) {
      // Maybe the token is no longer valid (the person was removed): check before retrying forever.
      api.me().catch((err) => err instanceof ApiError && err.status === 401 && useStore.getState().signOut());
    }
    useStore.setState({ connection: 'reconnecting' });
    retry++;
    retryTimer = window.setTimeout(openSocket, Math.min(10_000, 400 * 2 ** Math.min(retry, 5)));
  };
}

function name(userId: string): string {
  return useStore.getState().users[userId]?.displayName ?? 'Someone';
}

function handle(msg: ServerMessage) {
  const s = useStore.getState();
  const set = useStore.setState;
  switch (msg.type) {
    case 'snapshot': {
      const { snapshot } = msg;
      set({
        connection: 'online',
        meId: snapshot.meId,
        floor: snapshot.floor,
        officeName: snapshot.floor.name,
        users: Object.fromEntries(snapshot.users.map((u) => [u.id, u])),
        rooms: Object.fromEntries(snapshot.rooms.map((r) => [r.id, r])),
        presence: Object.fromEntries(snapshot.presence.map((p) => [p.userId, p])),
        voice: Object.fromEntries(snapshot.voice.map((v) => [v.userId, v])),
        library: Object.fromEntries(snapshot.library.map((t) => [t.id, t])),
        music: Object.fromEntries(snapshot.music.map((m) => [m.roomId, m])),
        incoming: [],
        outgoing: null,
      });
      return;
    }
    case 'user.upsert':
      return set({ users: { ...s.users, [msg.user.id]: msg.user } });
    case 'user.remove': {
      const { [msg.userId]: _u, ...users } = s.users;
      const { [msg.userId]: _p, ...presence } = s.presence;
      return set({ users, presence });
    }
    case 'room.upsert':
      return set({ rooms: { ...s.rooms, [msg.room.id]: msg.room } });
    case 'room.remove': {
      const { [msg.roomId]: _r, ...rooms } = s.rooms;
      return set({ rooms, selectedRoomId: s.selectedRoomId === msg.roomId ? null : s.selectedRoomId });
    }
    case 'floor.update':
      return set({ floor: msg.floor, officeName: msg.floor.name });
    case 'presence': {
      const before = s.presence[msg.presence.userId];
      set({ presence: { ...s.presence, [msg.presence.userId]: msg.presence } });
      const myRoom = s.meId ? s.presence[s.meId]?.roomId : null;
      if (msg.presence.userId !== s.meId && myRoom && msg.presence.roomId === myRoom && before?.roomId !== myRoom) {
        playPop();
        s.toast({ tone: 'info', title: `${name(msg.presence.userId)} came in`, userId: msg.presence.userId });
      } else if (msg.presence.userId !== s.meId && myRoom && before?.roomId === myRoom && msg.presence.roomId !== myRoom) {
        playLeave();
      }
      return;
    }
    case 'voice.state':
      return set({ voice: { ...s.voice, [msg.voice.userId]: msg.voice } });
    case 'rtc.signal':
      rtcHandler?.(msg.from, msg.signal);
      return;
    case 'time.sync':
      timeSyncHandler?.(msg.t0, msg.server);
      return;
    case 'library.upsert':
      return set({ library: { ...s.library, [msg.track.id]: msg.track } });
    case 'library.remove': {
      const { [msg.trackId]: _t, ...library } = s.library;
      return set({ library });
    }
    case 'music.state': {
      const before = s.music[msg.music.roomId];
      set({ music: { ...s.music, [msg.music.roomId]: msg.music } });
      const myRoom = s.meId ? s.presence[s.meId]?.roomId : null;
      // Tell people in the room when someone starts sharing their computer's audio.
      if (myRoom === msg.music.roomId && msg.music.streamerId && msg.music.streamerId !== before?.streamerId && msg.music.streamerId !== s.meId) {
        s.toast({ tone: 'info', title: `${name(msg.music.streamerId)} is sharing their audio`, userId: msg.music.streamerId });
      }
      return;
    }
    case 'knock.incoming':
      if (!s.incoming.some((k) => k.id === msg.knock.id)) {
        set({ incoming: [...s.incoming, msg.knock] });
        playDoorbell();
        desktop?.attention();
        notifyIfHidden(`${name(msg.knock.fromUserId)} is at your door`, `Ringing ${s.rooms[msg.knock.roomId]?.name ?? 'your room'}`);
      }
      return;
    case 'knock.pending':
      return set({ outgoing: msg.knock });
    case 'knock.resolved': {
      set({ incoming: s.incoming.filter((k) => k.id !== msg.knockId), outgoing: s.outgoing?.id === msg.knockId ? null : s.outgoing });
      if (msg.fromUserId !== s.meId) return;
      const room = s.rooms[msg.roomId]?.name ?? 'the room';
      const by = msg.byUserId ? name(msg.byUserId) : 'Someone';
      if (msg.outcome === 'accepted') {
        playPop();
        s.toast({ tone: 'success', title: `${by} let you in`, body: `Welcome to ${room}.`, userId: msg.byUserId });
      } else if (msg.outcome === 'declined') {
        playDecline();
        s.toast({ tone: 'info', title: `${by} can’t talk right now`, body: 'Try a message instead, or ring later.', userId: msg.byUserId });
      } else if (msg.outcome === 'expired') {
        s.toast({ tone: 'info', title: 'No answer', body: `Nobody opened the door to ${room}.` });
      } else if (msg.outcome === 'nobody') {
        s.toast({ tone: 'info', title: 'Nobody’s around', body: `There’s no one in ${room} to open the door.` });
      }
      return;
    }
    case 'notice':
      return s.toast({ tone: msg.level === 'error' ? 'error' : 'info', title: msg.message });
    case 'pong':
      return;
  }
}

function notifyIfHidden(title: string, body: string) {
  if (!document.hidden || !('Notification' in window)) return;
  if (Notification.permission === 'granted') new Notification(title, { body, icon: '/icon.svg' });
  else if (Notification.permission === 'default') void Notification.requestPermission();
}

// Derived values

export function useMe(): User | undefined {
  return useStore((s) => (s.meId ? s.users[s.meId] : undefined));
}

export function occupantsOf(presence: Record<string, Presence>, roomId: string): string[] {
  return Object.values(presence)
    .filter((p) => p.online && p.roomId === roomId)
    .map((p) => p.userId);
}

// For troubleshooting from the developer console.
(window as unknown as { __send: State['send'] }).__send = (msg) => useStore.getState().send(msg);
