import { AnimatePresence, motion } from 'framer-motion';
import { Bell, BellRing, DoorOpen, Footprints, Home, Lock, LogIn, Search, Users, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { entryBlock, KNOCK_TIMEOUT_MS, type Knock, type LockMode, type Room } from '@office/shared';
import { occupantsOf, useMe, useStore } from '../lib/store';
import { Avatar, statusLabel } from '../components/Avatar';
import { FloorMap, KIND_ICON, KIND_LABEL } from '../components/FloorMap';
import { Badge, Button, IconButton, Segmented } from '../components/ui';
import { SpeakingAvatar, VoiceDock, VolumeControl } from '../components/Voice';

export function Office() {
  const selectedRoomId = useStore((s) => s.selectedRoomId);
  const selectRoom = useStore((s) => s.selectRoom);
  const send = useStore((s) => s.send);
  const [focus, setFocus] = useState<{ roomId: string; nonce: number } | null>(null);

  const flyTo = (roomId: string) => {
    selectRoom(roomId);
    setFocus({ roomId, nonce: Date.now() });
  };

  return (
    <div className="office">
      <FloorMap mode="live" selectedId={selectedRoomId} onSelect={selectRoom} onActivate={(room) => send({ type: 'room.enter', roomId: room.id })} focus={focus} insetLeft={300} insetBottom={70} />
      <PeopleRail onFlyTo={flyTo} />
      <AnimatePresence>{selectedRoomId && <RoomPanel key={selectedRoomId} roomId={selectedRoomId} onClose={() => selectRoom(null)} />}</AnimatePresence>
      <OutgoingKnock />
      <VoiceDock />
    </div>
  );
}

function PeopleRail({ onFlyTo }: { onFlyTo: (roomId: string) => void }) {
  const users = useStore((s) => s.users);
  const presence = useStore((s) => s.presence);
  const rooms = useStore((s) => s.rooms);
  const meId = useStore((s) => s.meId);
  const send = useStore((s) => s.send);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(true);

  const people = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(users)
      .filter((u) => !q || u.displayName.toLowerCase().includes(q) || u.title.toLowerCase().includes(q))
      .sort((a, b) => {
        const oa = presence[a.id]?.online ? 0 : 1;
        const ob = presence[b.id]?.online ? 0 : 1;
        if (a.id === meId) return -1;
        if (b.id === meId) return 1;
        return oa - ob || a.displayName.localeCompare(b.displayName);
      });
  }, [users, presence, query, meId]);
  const onlineCount = Object.values(presence).filter((p) => p.online).length;
  const homeRoom = Object.values(rooms).find((r) => r.kind === 'personal' && r.ownerId === meId);
  const myRoomId = meId ? presence[meId]?.roomId : null;

  return (
    <motion.aside
      className={`rail glass ${open ? '' : 'is-collapsed'}`}
      layout
      transition={{ type: 'spring', stiffness: 400, damping: 36 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <header className="rail__header">
        <button className="rail__toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          <Users size={17} />
          {open && (
            <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              People
            </motion.span>
          )}
          <span className="rail__count">{onlineCount}</span>
        </button>
      </header>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="rail__body" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
            <label className="rail__search">
              <Search size={15} />
              <input placeholder="Find someone" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            {homeRoom && myRoomId !== homeRoom.id && (
              <button className="rail__home" onClick={() => send({ type: 'room.enter', roomId: homeRoom.id })}>
                <Home size={15} /> Back to my room
              </button>
            )}
            <ul className="rail__list">
              <AnimatePresence initial={false}>
                {people.map((u) => {
                  const p = presence[u.id];
                  const room = p?.roomId ? rooms[p.roomId] : undefined;
                  const where = !p?.online ? 'Offline' : room ? room.name : 'In the hallway';
                  return (
                    <motion.li key={u.id} layout initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}>
                      <button
                        className={`person-row ${p?.online ? '' : 'is-offline'}`}
                        onClick={() => {
                          const target = room ?? Object.values(rooms).find((r) => r.kind === 'personal' && r.ownerId === u.id);
                          if (target) onFlyTo(target.id);
                        }}
                      >
                        <Avatar user={u} size={34} showStatus online={!!p?.online} />
                        <span className="person-row__text">
                          <strong>
                            {u.displayName}
                            {u.id === meId && <em> (you)</em>}
                          </strong>
                          <span>{p?.online && u.statusText ? u.statusText : where}</span>
                        </span>
                      </button>
                    </motion.li>
                  );
                })}
              </AnimatePresence>
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.aside>
  );
}

function RoomPanel({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const room = useStore((s) => s.rooms[roomId]) as Room | undefined;
  const users = useStore((s) => s.users);
  const presence = useStore((s) => s.presence);
  const outgoing = useStore((s) => s.outgoing);
  const send = useStore((s) => s.send);
  const me = useMe();
  if (!room || !me) return null;

  const owner = room.ownerId ? users[room.ownerId] : undefined;
  const occupants = occupantsOf(presence, room.id).sort((a, b) => (a === room.ownerId ? -1 : b === room.ownerId ? 1 : 0));
  const here = presence[me.id]?.roomId === room.id;
  const block = entryBlock(room, me, occupants.length, owner);
  const ownerDnd = room.kind === 'personal' && owner?.status === 'dnd';
  const lock: LockMode = ownerDnd ? 'locked' : room.lockMode;
  const canLock = me.role === 'admin' || (room.kind === 'personal' ? room.ownerId === me.id : here);
  const knocking = outgoing?.roomId === room.id;
  const Icon = KIND_ICON[room.kind];
  const ownerOnline = owner && presence[owner.id]?.online;

  return (
    <motion.aside
      className="panel glass"
      data-hue={room.hue}
      initial={{ opacity: 0, x: 40, scale: 0.98 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 30, scale: 0.98, transition: { duration: 0.18 } }}
      transition={{ type: 'spring', stiffness: 380, damping: 34 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="panel__banner">
        <span className="panel__banner-icon">
          <Icon size={26} strokeWidth={1.8} />
        </span>
        <IconButton label="Close" className="panel__close" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </div>
      <div className="panel__content">
        <div className="panel__heading">
          <h2>{room.name}</h2>
          <div className="panel__badges">
            <Badge>{KIND_LABEL[room.kind]}</Badge>
            <Badge tone={lock === 'open' ? 'success' : lock === 'knock' ? 'warning' : 'danger'} icon={lock === 'open' ? <DoorOpen size={12} /> : lock === 'knock' ? <Bell size={12} /> : <Lock size={12} />}>
              {lock === 'open' ? 'Open door' : lock === 'knock' ? 'Knock first' : ownerDnd ? 'Do not disturb' : 'Locked'}
            </Badge>
            <Badge>
              {occupants.length}/{room.capacity}
            </Badge>
          </div>
        </div>

        {owner && (
          <div className="owner-card">
            <Avatar user={owner} size={46} showStatus online={!!ownerOnline} />
            <div>
              <strong>{owner.id === me.id ? 'Your room' : owner.displayName}</strong>
              <span>
                {ownerOnline ? statusLabel(owner.status) : 'Offline'}
                {owner.title && ` · ${owner.title}`}
              </span>
              {ownerOnline && owner.statusText && <em>“{owner.statusText}”</em>}
            </div>
          </div>
        )}

        <div className="panel__actions">
          {here ? (
            <Button variant="secondary" size="lg" block icon={<Footprints size={18} />} onClick={() => send({ type: 'room.leave' })}>
              Step out to the hallway
            </Button>
          ) : knocking ? (
            <Button variant="secondary" size="lg" block icon={<X size={18} />} onClick={() => outgoing && send({ type: 'knock.cancel', knockId: outgoing.id })}>
              Stop ringing
            </Button>
          ) : block === 'knock' ? (
            <Button variant="gradient" size="lg" block icon={<BellRing size={18} />} onClick={() => send({ type: 'room.knock', roomId: room.id })}>
              Ring the bell
            </Button>
          ) : block === 'locked' ? (
            <Button variant="secondary" size="lg" block disabled icon={<Lock size={18} />}>
              {ownerDnd ? `${owner?.displayName.split(' ')[0]} is not to be disturbed` : 'This room is locked'}
            </Button>
          ) : block === 'full' ? (
            <Button variant="secondary" size="lg" block disabled icon={<Users size={18} />}>
              This room is full
            </Button>
          ) : (
            <Button variant="gradient" size="lg" block icon={<LogIn size={18} />} onClick={() => send({ type: 'room.enter', roomId: room.id })}>
              {room.ownerId === me.id ? 'Go to my room' : 'Walk in'}
            </Button>
          )}
        </div>

        {canLock && (
          <section className="panel__section">
            <h3>Door</h3>
            <Segmented<LockMode>
              layoutId={`lock-${room.id}`}
              value={room.lockMode}
              onChange={(lockMode) => send({ type: 'room.setLock', roomId: room.id, lockMode })}
              options={[
                { value: 'open', label: 'Open', icon: <DoorOpen size={14} />, title: 'Anyone can walk in' },
                { value: 'knock', label: 'Knock', icon: <Bell size={14} />, title: 'Visitors ring the bell' },
                { value: 'locked', label: 'Locked', icon: <Lock size={14} />, title: 'No visitors' },
              ]}
            />
            {room.kind !== 'personal' && <p className="panel__note">Shared rooms open up again when everyone leaves.</p>}
            {ownerDnd && room.ownerId === me.id && <p className="panel__note">Your status is Do not disturb, so your door stays locked.</p>}
          </section>
        )}

        <section className="panel__section">
          <h3>Inside now</h3>
          {occupants.length ? (
            <ul className="occupants">
              <AnimatePresence initial={false}>
                {occupants.map((id) => {
                  const u = users[id];
                  if (!u) return null;
                  return (
                    <motion.li key={id} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95 }}>
                      <SpeakingAvatar userId={id} size={34} />
                      <span className="occupants__text">
                        <strong>{id === me.id ? 'You' : u.displayName}</strong>
                        <small>{id === room.ownerId ? 'Owner' : u.title || statusLabel(u.status)}</small>
                      </span>
                      {here && id !== me.id && <VolumeControl userId={id} />}
                    </motion.li>
                  );
                })}
              </AnimatePresence>
            </ul>
          ) : (
            <p className="panel__empty">Nobody’s here right now.</p>
          )}
        </section>
      </div>
    </motion.aside>
  );
}

function OutgoingKnock() {
  const outgoing = useStore((s) => s.outgoing);
  const rooms = useStore((s) => s.rooms);
  const send = useStore((s) => s.send);
  return (
    <AnimatePresence>
      {outgoing && (
        <motion.div
          className="ringing glass"
          initial={{ opacity: 0, y: 30, x: '-50%', scale: 0.9 }}
          animate={{ opacity: 1, y: 0, x: '-50%', scale: 1 }}
          exit={{ opacity: 0, y: 20, x: '-50%', scale: 0.95 }}
          transition={{ type: 'spring', stiffness: 420, damping: 30 }}
        >
          <span className="ringing__bell">
            <BellRing size={18} />
          </span>
          <span className="ringing__text">
            Ringing <strong>{rooms[outgoing.roomId]?.name ?? 'the room'}</strong>…
          </span>
          <Countdown knock={outgoing} />
          <Button size="sm" variant="ghost" onClick={() => send({ type: 'knock.cancel', knockId: outgoing.id })}>
            Cancel
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Incoming doorbells, stacked at the top of the window wherever you are in the app. */
export function DoorbellStack() {
  const incoming = useStore((s) => s.incoming);
  return (
    <div className="doorbells">
      <AnimatePresence>
        {incoming.map((k) => (
          <Doorbell key={k.id} knock={k} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function Doorbell({ knock }: { knock: Knock }) {
  const from = useStore((s) => s.users[knock.fromUserId]);
  const room = useStore((s) => s.rooms[knock.roomId]);
  const send = useStore((s) => s.send);
  if (!from) return null;
  return (
    <motion.div
      layout
      className="doorbell glass"
      initial={{ opacity: 0, y: -40, scale: 0.9 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -24, scale: 0.94, transition: { duration: 0.2 } }}
      transition={{ type: 'spring', stiffness: 420, damping: 28 }}
    >
      <div className="doorbell__who">
        <span className="doorbell__avatar">
          <Avatar user={from} size={52} />
          <motion.span
            className="doorbell__bell"
            animate={{ rotate: [0, -18, 16, -12, 8, 0] }}
            transition={{ duration: 0.9, repeat: Infinity, repeatDelay: 1.2 }}
          >
            <BellRing size={14} />
          </motion.span>
        </span>
        <span className="doorbell__text">
          <strong>{from.displayName} is at your door</strong>
          <span>Wants to come into {room?.name ?? 'your room'}</span>
        </span>
        <Countdown knock={knock} />
      </div>
      <div className="doorbell__actions">
        <Button variant="ghost" onClick={() => send({ type: 'knock.respond', knockId: knock.id, accept: false })}>
          Not now
        </Button>
        <Button variant="gradient" icon={<DoorOpen size={17} />} onClick={() => send({ type: 'knock.respond', knockId: knock.id, accept: true })}>
          Let them in
        </Button>
      </div>
    </motion.div>
  );
}

/** A ring that empties as the knock runs out of time. */
function Countdown({ knock }: { knock: Knock }) {
  // Count from when this device heard about it, so clock drift between computers doesn't matter.
  const [end] = useState(() => Date.now() + Math.min(KNOCK_TIMEOUT_MS, knock.expiresAt - knock.createdAt));
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, []);
  const left = Math.max(0, end - now);
  const fraction = left / KNOCK_TIMEOUT_MS;
  const r = 13;
  const c = 2 * Math.PI * r;
  return (
    <span className="countdown" title={`${Math.ceil(left / 1000)}s left`}>
      <svg width="32" height="32" viewBox="0 0 32 32">
        <circle cx="16" cy="16" r={r} className="countdown__track" />
        <circle cx="16" cy="16" r={r} className="countdown__bar" strokeDasharray={c} strokeDashoffset={c * (1 - fraction)} />
      </svg>
      <span>{Math.ceil(left / 1000)}</span>
    </span>
  );
}
