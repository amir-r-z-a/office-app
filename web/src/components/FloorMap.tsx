import { AnimatePresence, motion } from 'framer-motion';
import { Armchair, Bell, DoorOpen, HeadphoneOff, Lock, Maximize, MicOff, Minus, Plus, Presentation, Sofa } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Floor, Room, RoomKind, User } from '@office/shared';
import { useStore } from '../lib/store';
import { Avatar } from './Avatar';
import { RoomNowPlaying } from './Music';

export const KIND_ICON: Record<RoomKind, typeof Sofa> = { personal: Armchair, meeting: Presentation, lounge: Sofa };
export const KIND_LABEL: Record<RoomKind, string> = { personal: 'Personal room', meeting: 'Meeting room', lounge: 'Lounge' };

const AVATAR = 46;
const CELL_W = 64;
const CELL_H = 74;
const HEADER = 56;
const HALLWAY_H = 96;
const SNAP = 10;
const MIN_SCALE = 0.25;
const MAX_SCALE = 2.5;

interface Camera {
  x: number;
  y: number;
  scale: number;
}

interface Slot {
  userId: string;
  x: number;
  y: number;
}

type Edit = { roomId: string; mode: 'move' | 'resize'; startX: number; startY: number; orig: Room };

export interface FloorMapProps {
  mode: 'live' | 'edit';
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Live mode: double-click a room to walk in or ring. */
  onActivate?: (room: Room) => void;
  /** Edit mode: a room was dragged or resized, with its new geometry. */
  onChangeRoom?: (room: Room) => void;
  /** Pan the camera to this room whenever the value changes. */
  focus?: { roomId: string; nonce: number } | null;
  /** Width covered by an overlay on the left, kept clear when fitting. */
  insetLeft?: number;
  /** Height covered by an overlay at the bottom (the voice dock), kept clear when fitting. */
  insetBottom?: number;
}

export function FloorMap({ mode, selectedId, onSelect, onActivate, onChangeRoom, focus, insetLeft = 0, insetBottom = 0 }: FloorMapProps) {
  const floor = useStore((s) => s.floor);
  const rooms = useStore((s) => s.rooms);
  const users = useStore((s) => s.users);
  const presence = useStore((s) => s.presence);
  const meId = useStore((s) => s.meId);
  const incoming = useStore((s) => s.incoming);
  const outgoing = useStore((s) => s.outgoing);
  const voiceStates = useStore((s) => s.voice);

  const viewport = useRef<HTMLDivElement>(null);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: 0.6 });
  const [smooth, setSmooth] = useState(false);
  const fitted = useRef(false);
  const pan = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);
  const dragged = useRef(false);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [draft, setDraft] = useState<Room | null>(null);

  const roomList = useMemo(() => {
    const list = Object.values(rooms);
    return draft ? list.map((r) => (r.id === draft.id ? draft : r)) : list;
  }, [rooms, draft]);

  // Camera

  const fit = useCallback(
    (animate: boolean) => {
      const el = viewport.current;
      if (!el) return;
      const { width, height } = el.getBoundingClientRect();
      if (!width || !height) return;
      const pad = 40;
      // Narrow windows ignore the overlay rather than shrink the floor to nothing.
      const left = width - insetLeft > 700 ? insetLeft : 0;
      const usable = width - left;
      const usableH = height - insetBottom;
      const scale = clamp(Math.min((usable - pad * 2) / floor.width, (usableH - pad * 2) / floor.height), MIN_SCALE, 1.2);
      setSmooth(animate);
      setCamera({ scale, x: left + (usable - floor.width * scale) / 2, y: (usableH - floor.height * scale) / 2 });
    },
    [floor.width, floor.height, insetLeft, insetBottom],
  );

  useLayoutEffect(() => {
    if (!fitted.current) {
      fit(false);
      fitted.current = true;
    }
  }, [fit]);

  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const ro = new ResizeObserver(() => !pan.current && fit(false));
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  useEffect(() => {
    if (!focus) return;
    const room = rooms[focus.roomId];
    const el = viewport.current;
    if (!room || !el) return;
    const { width, height } = el.getBoundingClientRect();
    // Center the room in the space between the left overlay and the side panel.
    const left = width - insetLeft > 700 ? insetLeft : 0;
    const right = width - Math.min(390, width * 0.4);
    setSmooth(true);
    setCamera((c) => {
      const scale = Math.max(c.scale, 0.75);
      return { scale, x: (left + right) / 2 - (room.x + room.w / 2) * scale, y: height / 2 - (room.y + room.h / 2) * scale };
    });
  }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps

  const zoomBy = (factor: number, cx?: number, cy?: number) => {
    const el = viewport.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = cx ?? rect.width / 2;
    const py = cy ?? rect.height / 2;
    setCamera((c) => {
      const scale = clamp(c.scale * factor, MIN_SCALE, MAX_SCALE);
      const k = scale / c.scale;
      return { scale, x: px - (px - c.x) * k, y: py - (py - c.y) * k };
    });
  };

  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      setSmooth(false);
      const mouseWheel = e.deltaMode === 1 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY));
      if (e.ctrlKey || mouseWheel) {
        // Mouse wheel or trackpad pinch: zoom around the pointer.
        zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - rect.left, e.clientY - rect.top);
      } else {
        // Two-finger trackpad scroll: pan.
        setCamera((c) => ({ ...c, x: c.x - e.deltaX, y: c.y - e.deltaY }));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    dragged.current = false;
    pan.current = { x: e.clientX, y: e.clientY, cx: camera.x, cy: camera.y, moved: false };
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    if (edit) {
      const dx = (e.clientX - edit.startX) / camera.scale;
      const dy = (e.clientY - edit.startY) / camera.scale;
      const o = edit.orig;
      const next =
        edit.mode === 'move'
          ? { ...o, x: clamp(snap(o.x + dx), 0, floor.width - o.w), y: clamp(snap(o.y + dy), 0, floor.height - o.h) }
          : { ...o, w: clamp(snap(o.w + dx), 120, floor.width - o.x), h: clamp(snap(o.h + dy), 120, floor.height - o.y) };
      setDraft(next);
      return;
    }
    const p = pan.current;
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (!p.moved) {
      if (Math.hypot(dx, dy) < 4) return;
      // Capture only once it's a drag, so a plain click still reaches the room under the pointer.
      viewport.current?.setPointerCapture(e.pointerId);
      p.moved = true;
    }
    dragged.current = true;
    setSmooth(false);
    setCamera((c) => ({ ...c, x: p.cx + dx, y: p.cy + dy }));
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    if (edit) {
      if (draft && (draft.x !== edit.orig.x || draft.y !== edit.orig.y || draft.w !== edit.orig.w || draft.h !== edit.orig.h)) {
        onChangeRoom?.(draft);
      }
      setEdit(null);
      setDraft(null);
      return;
    }
    const onRoom = (e.target as HTMLElement).closest('.room, .map__controls');
    if (pan.current && !pan.current.moved && !onRoom) onSelect(null);
    pan.current = null;
  };

  const startEdit = (e: ReactPointerEvent, room: Room, editMode: Edit['mode']) => {
    if (mode !== 'edit' || e.button !== 0) return;
    e.stopPropagation();
    onSelect(room.id);
    setEdit({ roomId: room.id, mode: editMode, startX: e.clientX, startY: e.clientY, orig: room });
    viewport.current?.setPointerCapture(e.pointerId);
  };

  // Where everyone stands

  const slots = useMemo(() => (mode === 'live' ? layoutPeople(roomList, presence, users, floor) : { slots: [], overflow: {} }), [
    mode,
    roomList,
    presence,
    users,
    floor,
  ]);
  const hallwayCount = Object.values(presence).filter((p) => p.online && !p.roomId).length;
  const myRoomId = meId ? presence[meId]?.roomId ?? null : null;
  const ringingIds = new Set(incoming.map((k) => k.roomId));

  return (
    <div
      ref={viewport}
      className={`map map--${mode} ${pan.current?.moved ? 'is-panning' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div
        className={`map__canvas ${smooth ? 'is-smooth' : ''}`}
        style={{
          width: floor.width,
          height: floor.height,
          transform: `translate3d(${camera.x}px, ${camera.y}px, 0) scale(${camera.scale})`,
        }}
        onTransitionEnd={() => setSmooth(false)}
      >
        {mode === 'live' && (
          <div className={`hallway ${hallwayCount ? 'has-people' : ''}`} style={{ height: HALLWAY_H }}>
            <span>Hallway</span>
          </div>
        )}

        <AnimatePresence>
          {roomList.map((room) => (
            <RoomTile
              key={room.id}
              room={room}
              mode={mode}
              owner={room.ownerId ? users[room.ownerId] : undefined}
              ownerOnline={!!(room.ownerId && presence[room.ownerId]?.online)}
              selected={selectedId === room.id}
              here={myRoomId === room.id}
              ringing={ringingIds.has(room.id)}
              knocking={outgoing?.roomId === room.id}
              occupied={slots.slots.some((s) => s.roomId === room.id)}
              overflow={slots.overflow[room.id] ?? 0}
              editing={edit?.roomId === room.id}
              onClick={() => {
                if (dragged.current) return;
                onSelect(room.id);
              }}
              onDoubleClick={() => mode === 'live' && onActivate?.(room)}
              onStartMove={(e) => startEdit(e, room, 'move')}
              onStartResize={(e) => startEdit(e, room, 'resize')}
            />
          ))}
        </AnimatePresence>

        <AnimatePresence>
          {slots.slots.map((slot) => {
            const user = users[slot.userId];
            if (!user) return null;
            const v = voiceStates[slot.userId];
            return (
              <motion.div
                key={slot.userId}
                className={`map-person ${slot.userId === meId ? 'is-me' : ''} ${v?.speaking ? 'is-speaking' : ''}`}
                data-hue={user.hue}
                initial={{ x: slot.x, y: slot.y, scale: 0, opacity: 0 }}
                animate={{ x: slot.x, y: slot.y, scale: 1, opacity: 1 }}
                exit={{ scale: 0, opacity: 0, transition: { duration: 0.25 } }}
                transition={{ type: 'spring', stiffness: 170, damping: 22, mass: 0.9 }}
              >
                <Avatar user={user} size={AVATAR} showStatus ring={slot.userId === meId} />
                {(v?.muted || v?.deafened) && (
                  <span className="map-person__muted" title={v.deafened ? 'Sound off' : 'Muted'}>
                    {v.deafened ? <HeadphoneOff size={11} strokeWidth={2.6} /> : <MicOff size={11} strokeWidth={2.6} />}
                  </span>
                )}
                <span className="map-person__name">{slot.userId === meId ? 'You' : user.displayName.split(' ')[0]}</span>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      <div className="map__controls" onPointerDown={(e) => e.stopPropagation()}>
        <button aria-label="Zoom in" title="Zoom in" onClick={() => (setSmooth(true), zoomBy(1.25))}>
          <Plus size={16} />
        </button>
        <button aria-label="Zoom out" title="Zoom out" onClick={() => (setSmooth(true), zoomBy(0.8))}>
          <Minus size={16} />
        </button>
        <button aria-label="Fit the whole floor" title="Fit the whole floor" onClick={() => fit(true)}>
          <Maximize size={15} />
        </button>
      </div>
    </div>
  );
}

interface RoomTileProps {
  room: Room;
  mode: 'live' | 'edit';
  owner?: User;
  ownerOnline: boolean;
  selected: boolean;
  here: boolean;
  ringing: boolean;
  knocking: boolean;
  occupied: boolean;
  overflow: number;
  editing: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
  onStartMove: (e: ReactPointerEvent) => void;
  onStartResize: (e: ReactPointerEvent) => void;
}

function RoomTile(p: RoomTileProps) {
  const { room, owner } = p;
  const Icon = KIND_ICON[room.kind];
  const lock = room.kind === 'personal' && owner?.status === 'dnd' ? 'locked' : room.lockMode;
  const away = room.kind === 'personal' && owner && !p.ownerOnline;
  return (
    <motion.div
      className={[
        'room',
        `room--${room.kind}`,
        `room--${lock}`,
        p.selected && 'is-selected',
        p.here && 'is-here',
        p.ringing && 'is-ringing',
        p.editing && 'is-editing',
        away && 'is-away',
      ]
        .filter(Boolean)
        .join(' ')}
      data-hue={room.hue}
      style={{ left: room.x, top: room.y, width: room.w, height: room.h }}
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ type: 'spring', stiffness: 300, damping: 28 }}
      onClick={p.onClick}
      onDoubleClick={p.onDoubleClick}
      onPointerDown={p.mode === 'edit' ? p.onStartMove : undefined}
    >
      <div className="room__surface" />
      <header className="room__header">
        <span className="room__icon">
          <Icon size={17} strokeWidth={2.2} />
        </span>
        <span className="room__title">
          <strong>{room.name}</strong>
          <small>
            {room.kind === 'personal'
              ? owner
                ? p.ownerOnline
                  ? owner.statusText || owner.title || 'At their desk'
                  : 'Away from the office'
                : 'No owner yet'
              : `${KIND_LABEL[room.kind]} · up to ${room.capacity}`}
          </small>
        </span>
        <span className={`room__door room__door--${lock}`} title={lock === 'open' ? 'Open: walk in' : lock === 'knock' ? 'Knock first' : 'Locked'}>
          {lock === 'open' ? <DoorOpen size={14} /> : lock === 'knock' ? <Bell size={13} /> : <Lock size={13} />}
        </span>
      </header>

      {p.mode === 'live' && !p.occupied && (
        <div className="room__empty">
          <Icon size={Math.min(room.w, room.h) * 0.22} strokeWidth={1.2} />
        </div>
      )}
      {p.overflow > 0 && <span className="room__overflow">+{p.overflow}</span>}
      {p.mode === 'live' && <RoomNowPlaying roomId={room.id} />}
      <span className="room__doorway" />

      {p.knocking && (
        <span className="room__ripple" aria-hidden>
          <i />
          <i />
          <i />
        </span>
      )}

      {p.mode === 'edit' && (
        <>
          <span className="room__size">
            {Math.round(room.w)} × {Math.round(room.h)}
          </span>
          <span className="room__resize" onPointerDown={p.onStartResize} title="Drag to resize" />
        </>
      )}
    </motion.div>
  );
}

/** Seats for everyone online: the owner first, then everyone else in the order they're listed. */
function layoutPeople(
  rooms: Room[],
  presence: Record<string, { online: boolean; roomId: string | null; userId: string }>,
  users: Record<string, User>,
  floor: Floor,
): { slots: (Slot & { roomId: string | null })[]; overflow: Record<string, number> } {
  const slots: (Slot & { roomId: string | null })[] = [];
  const overflow: Record<string, number> = {};
  const byRoom = new Map<string | null, string[]>();
  for (const p of Object.values(presence)) {
    if (!p.online || !users[p.userId]) continue;
    const key = p.roomId && rooms.some((r) => r.id === p.roomId) ? p.roomId : null;
    byRoom.set(key, [...(byRoom.get(key) ?? []), p.userId]);
  }
  const byName = (a: string, b: string) => users[a].displayName.localeCompare(users[b].displayName);

  for (const room of rooms) {
    const ids = (byRoom.get(room.id) ?? []).sort((a, b) => (a === room.ownerId ? -1 : b === room.ownerId ? 1 : byName(a, b)));
    if (!ids.length) continue;
    const cols = Math.max(1, Math.floor((room.w - 24) / CELL_W));
    const rows = Math.max(1, Math.floor((room.h - HEADER - 16) / CELL_H));
    const fit = cols * rows;
    const shown = ids.length > fit ? ids.slice(0, fit - 1) : ids;
    if (ids.length > fit) overflow[room.id] = ids.length - shown.length;
    const usedCols = Math.min(cols, shown.length);
    const usedRows = Math.ceil(shown.length / cols);
    const left = room.x + (room.w - usedCols * CELL_W) / 2 + (CELL_W - AVATAR) / 2;
    const bodyTop = room.y + HEADER;
    const top = bodyTop + Math.max(8, (room.h - HEADER - usedRows * CELL_H) / 2);
    shown.forEach((id, i) => {
      slots.push({ userId: id, roomId: room.id, x: left + (i % cols) * CELL_W, y: top + Math.floor(i / cols) * CELL_H });
    });
  }

  const hall = (byRoom.get(null) ?? []).sort(byName);
  const hallTop = floor.height - HALLWAY_H + 14;
  const start = floor.width / 2 - (hall.length * CELL_W) / 2 + (CELL_W - AVATAR) / 2;
  hall.forEach((id, i) => slots.push({ userId: id, roomId: null, x: start + i * CELL_W, y: hallTop }));
  return { slots, overflow };
}

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

function snap(v: number) {
  return Math.round(v / SNAP) * SNAP;
}
