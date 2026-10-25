import { AnimatePresence, motion } from 'framer-motion';
import { Armchair, Copy, Crown, Headphones, KeyRound, LayoutGrid, Pencil, Plus, Presentation, Sofa, Trash2, UserPlus, Users, Wand2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Hue, LockMode, Room, RoomKind, User } from '@office/shared';
import { api } from '../lib/api';
import { occupantsOf, useStore } from '../lib/store';
import { Avatar } from '../components/Avatar';
import { FloorMap, KIND_LABEL } from '../components/FloorMap';
import { Badge, Button, Field, IconButton, Modal, Segmented } from '../components/ui';
import { HuePicker } from './Shell';

type Tab = 'people' | 'floor';

export function Admin() {
  const [tab, setTab] = useState<Tab>('people');
  return (
    <div className="admin">
      <div className="admin__tabs">
        <Segmented<Tab>
          layoutId="admin-tab"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'people', label: 'People', icon: <Users size={15} /> },
            { value: 'floor', label: 'Floor plan', icon: <LayoutGrid size={15} /> },
          ]}
        />
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={tab}
          className="admin__body"
          initial={{ opacity: 0, x: tab === 'people' ? -14 : 14 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: tab === 'people' ? -10 : 10 }}
          transition={{ duration: 0.2 }}
        >
          {tab === 'people' ? <People /> : <FloorEditor />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

// People

function People() {
  const users = useStore((s) => s.users);
  const rooms = useStore((s) => s.rooms);
  const presence = useStore((s) => s.presence);
  const meId = useStore((s) => s.meId);
  const [editing, setEditing] = useState<User | 'new' | null>(null);
  const [removing, setRemoving] = useState<User | null>(null);
  const list = Object.values(users).sort((a, b) => a.displayName.localeCompare(b.displayName));

  return (
    <div className="people">
      <div className="section-head">
        <div>
          <h2>People</h2>
          <p>
            {list.length} {list.length === 1 ? 'person' : 'people'} · {Object.values(presence).filter((p) => p.online).length} online now
          </p>
        </div>
        <Button variant="primary" icon={<UserPlus size={17} />} onClick={() => setEditing('new')}>
          Add person
        </Button>
      </div>

      <motion.div className="people-grid" layout>
        <AnimatePresence initial={false}>
          {list.map((u, i) => {
            const room = Object.values(rooms).find((r) => r.kind === 'personal' && r.ownerId === u.id);
            const online = presence[u.id]?.online;
            return (
              <motion.article
                key={u.id}
                layout
                className="person-card"
                data-hue={u.hue}
                initial={{ opacity: 0, y: 14, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1, transition: { delay: Math.min(i, 12) * 0.03 } }}
                exit={{ opacity: 0, scale: 0.92 }}
              >
                <div className="person-card__glow" />
                <Avatar user={u} size={56} showStatus online={online} />
                <h3>
                  {u.displayName}
                  {u.role === 'admin' && (
                    <span className="person-card__crown" title="Admin">
                      <Crown size={13} />
                    </span>
                  )}
                </h3>
                <p>@{u.username}</p>
                <div className="person-card__meta">
                  {u.title && <Badge>{u.title}</Badge>}
                  <Badge tone={room ? 'accent' : 'neutral'} icon={<Armchair size={12} />}>
                    {room ? room.name : 'No room'}
                  </Badge>
                </div>
                <div className="person-card__actions">
                  <Button size="sm" variant="ghost" icon={<Pencil size={14} />} onClick={() => setEditing(u)}>
                    Edit
                  </Button>
                  {u.id !== meId && (
                    <IconButton label={`Remove ${u.displayName}`} className="danger-hover" onClick={() => setRemoving(u)}>
                      <Trash2 size={15} />
                    </IconButton>
                  )}
                </div>
              </motion.article>
            );
          })}
        </AnimatePresence>
      </motion.div>

      <PersonModal person={editing} onClose={() => setEditing(null)} />
      <ConfirmRemove person={removing} onClose={() => setRemoving(null)} />
    </div>
  );
}

function randomPassword() {
  const words = ['maple', 'river', 'comet', 'pixel', 'tiger', 'lemon', 'orbit', 'cedar', 'nova', 'echo'];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  return `${pick()}-${pick()}-${Math.floor(10 + Math.random() * 90)}`;
}

function PersonModal({ person, onClose }: { person: User | 'new' | null; onClose: () => void }) {
  const rooms = useStore((s) => s.rooms);
  const floor = useStore((s) => s.floor);
  const putUser = useStore((s) => s.putUser);
  const putRoom = useStore((s) => s.putRoom);
  const toast = useStore((s) => s.toast);
  const isNew = person === 'new';
  const existing = person && person !== 'new' ? person : null;

  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [title, setTitle] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<User['role']>('member');
  const [hue, setHue] = useState<Hue>('violet');
  const [giveRoom, setGiveRoom] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ username: string; password: string } | null>(null);

  useEffect(() => {
    if (!person) return;
    setError('');
    setCreated(null);
    if (existing) {
      setDisplayName(existing.displayName);
      setUsername(existing.username);
      setTitle(existing.title);
      setRole(existing.role);
      setHue(existing.hue);
      setPassword('');
    } else {
      setDisplayName('');
      setUsername('');
      setTitle('');
      setRole('member');
      setHue(['violet', 'coral', 'mint', 'sky', 'amber', 'rose', 'lime', 'indigo'][Math.floor(Math.random() * 8)] as Hue);
      setPassword(randomPassword());
      setGiveRoom(true);
    }
  }, [person]); // eslint-disable-line react-hooks/exhaustive-deps

  // Suggest a username from the name while it hasn't been typed by hand.
  const [usernameTouched, setUsernameTouched] = useState(false);
  useEffect(() => setUsernameTouched(false), [person]);
  useEffect(() => {
    if (isNew && !usernameTouched) setUsername(displayName.trim().toLowerCase().split(/\s+/)[0]?.replace(/[^a-z0-9._-]/g, '') ?? '');
  }, [displayName, isNew, usernameTouched]);

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      if (existing) {
        putUser(await api.updateUser(existing.id, { displayName, username, title, role, hue, ...(password ? { password } : {}) }));
        toast({ tone: 'success', title: `${displayName} updated` });
        onClose();
      } else {
        const user = await api.createUser({ displayName, username, password, role, title, hue });
        putUser(user);
        if (giveRoom) {
          const spot = findFreeSpot(Object.values(rooms), floor.width, floor.height, 300, 230);
          const first = displayName.trim().split(/\s+/)[0];
          const room = await api.createRoom({
            name: `${first}’s Room`,
            kind: 'personal',
            ownerId: user.id,
            hue,
            lockMode: 'knock',
            capacity: 4,
            ...spot,
          });
          putRoom(room);
          if (spot.y + spot.h > floor.height - 100) {
            await api.updateFloor({ ...floor, height: spot.y + spot.h + 140 });
          }
        }
        setCreated({ username, password });
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <Modal
        open={!!person}
        onClose={onClose}
        title={`${displayName} is in!`}
        subtitle="Share these sign-in details with them. They can change the password in their profile."
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <div className="credentials">
          <div>
            <span>Username</span>
            <code>{created.username}</code>
          </div>
          <div>
            <span>Password</span>
            <code>{created.password}</code>
          </div>
          <Button
            size="sm"
            icon={<Copy size={14} />}
            onClick={() => {
              void navigator.clipboard?.writeText(`Office sign-in\nAddress: ${location.origin}\nUsername: ${created.username}\nPassword: ${created.password}`);
              toast({ tone: 'success', title: 'Copied to clipboard' });
            }}
          >
            Copy
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open={!!person}
      onClose={onClose}
      title={isNew ? 'Add a person' : `Edit ${existing?.displayName}`}
      subtitle={isNew ? 'They’ll sign in with this username and password.' : undefined}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={save} disabled={!displayName.trim() || username.length < 2 || (isNew && password.length < 4)}>
            {isNew ? 'Add person' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="form-row">
        <Field label="Name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoFocus />
        <Field label="Username" value={username} onChange={(e) => (setUsernameTouched(true), setUsername(e.target.value.replace(/\s/g, '')))} />
      </div>
      <div className="form-row">
        <Field label="Title" placeholder="e.g. Developer" value={title} onChange={(e) => setTitle(e.target.value)} />
        <Field
          label={isNew ? 'Password' : 'New password'}
          placeholder={isNew ? '' : 'Leave empty to keep'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          trailing={
            <button type="button" className="field__trailing" title="Generate a password" onClick={() => setPassword(randomPassword())}>
              <Wand2 size={15} />
            </button>
          }
        />
      </div>
      <div className="picker">
        <span className="picker__label">Role</span>
        <Segmented<User['role']>
          layoutId="person-role"
          value={role}
          onChange={setRole}
          options={[
            { value: 'member', label: 'Member', icon: <Users size={14} /> },
            { value: 'admin', label: 'Admin', icon: <Crown size={14} /> },
          ]}
        />
      </div>
      <div className="picker">
        <span className="picker__label">Color</span>
        <HuePicker value={hue} onChange={setHue} />
      </div>
      {isNew && (
        <label className={`choice ${giveRoom ? 'is-checked' : ''}`}>
          <input type="checkbox" checked={giveRoom} onChange={(e) => setGiveRoom(e.target.checked)} />
          <span className="choice__icon">
            <Armchair size={18} />
          </span>
          <span className="choice__text">
            <strong>Give them a personal room</strong>
            <span>Placed in a free spot on the floor. You can move it later.</span>
          </span>
          <span className="choice__check" />
        </label>
      )}
      {error && <p className="form-error">{error}</p>}
    </Modal>
  );
}

function ConfirmRemove({ person, onClose }: { person: User | null; onClose: () => void }) {
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={!!person}
      onClose={onClose}
      title={`Remove ${person?.displayName}?`}
      subtitle="They’ll be signed out at once. Their room stays on the floor without an owner."
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep
          </Button>
          <Button
            variant="danger"
            loading={busy}
            onClick={async () => {
              if (!person) return;
              setBusy(true);
              try {
                await api.deleteUser(person.id);
                toast({ tone: 'info', title: `${person.displayName} was removed` });
                onClose();
              } catch (err) {
                toast({ tone: 'error', title: (err as Error).message });
              } finally {
                setBusy(false);
              }
            }}
          >
            Remove
          </Button>
        </>
      }
    >
      {person && (
        <div className="confirm-person">
          <Avatar user={person} size={44} />
          <span>
            <strong>{person.displayName}</strong>
            <small>@{person.username}</small>
          </span>
        </div>
      )}
    </Modal>
  );
}

// Floor plan

const NEW_ROOM: Record<RoomKind, { name: string; w: number; h: number; capacity: number; hue: Hue; lockMode: LockMode }> = {
  personal: { name: 'New Room', w: 300, h: 230, capacity: 4, hue: 'violet', lockMode: 'knock' },
  meeting: { name: 'Meeting Room', w: 420, h: 280, capacity: 10, hue: 'sky', lockMode: 'open' },
  lounge: { name: 'Lounge', w: 480, h: 300, capacity: 15, hue: 'amber', lockMode: 'open' },
  listening: { name: 'Listening Room', w: 380, h: 260, capacity: 15, hue: 'rose', lockMode: 'open' },
};

function FloorEditor() {
  const rooms = useStore((s) => s.rooms);
  const floor = useStore((s) => s.floor);
  const putRoom = useStore((s) => s.putRoom);
  const toast = useStore((s) => s.toast);
  const [selected, setSelected] = useState<string | null>(null);

  const add = async (kind: RoomKind) => {
    const preset = NEW_ROOM[kind];
    const spot = findFreeSpot(Object.values(rooms), floor.width, floor.height, preset.w, preset.h);
    try {
      const room = await api.createRoom({ ...preset, kind, ownerId: null, ...spot });
      putRoom(room);
      setSelected(room.id);
      if (spot.y + spot.h > floor.height - 100) await api.updateFloor({ ...floor, height: spot.y + spot.h + 140 });
    } catch (err) {
      toast({ tone: 'error', title: (err as Error).message });
    }
  };

  const move = async (room: Room) => {
    const before = rooms[room.id];
    putRoom(room);
    try {
      await api.updateRoom(room.id, { x: room.x, y: room.y, w: room.w, h: room.h });
    } catch (err) {
      if (before) putRoom(before);
      toast({ tone: 'error', title: (err as Error).message });
    }
  };

  return (
    <div className="editor">
      <div className="editor__map">
        <FloorMap mode="edit" selectedId={selected} onSelect={setSelected} onChangeRoom={move} />
        <div className="editor__toolbar glass" onPointerDown={(e) => e.stopPropagation()}>
          <span className="editor__toolbar-label">Add</span>
          <Button size="sm" variant="ghost" icon={<Armchair size={15} />} onClick={() => add('personal')}>
            Personal
          </Button>
          <Button size="sm" variant="ghost" icon={<Presentation size={15} />} onClick={() => add('meeting')}>
            Meeting
          </Button>
          <Button size="sm" variant="ghost" icon={<Sofa size={15} />} onClick={() => add('lounge')}>
            Lounge
          </Button>
          <Button size="sm" variant="ghost" icon={<Headphones size={15} />} onClick={() => add('listening')} title="Music only: microphones stay off">
            Listening
          </Button>
        </div>
        <p className="editor__hint">Drag rooms to move them · drag the corner to resize</p>
      </div>
      <aside className="editor__side">
        <AnimatePresence mode="wait">
          {selected && rooms[selected] ? (
            <RoomInspector key={selected} room={rooms[selected]} onDeleted={() => setSelected(null)} />
          ) : (
            <FloorInspector key="floor" />
          )}
        </AnimatePresence>
      </aside>
    </div>
  );
}

function FloorInspector() {
  const floor = useStore((s) => s.floor);
  const rooms = useStore((s) => s.rooms);
  const toast = useStore((s) => s.toast);
  const [name, setName] = useState(floor.name);
  const [width, setWidth] = useState(String(floor.width));
  const [height, setHeight] = useState(String(floor.height));
  useEffect(() => {
    setName(floor.name);
    setWidth(String(floor.width));
    setHeight(String(floor.height));
  }, [floor]);
  const counts = Object.values(rooms).reduce<Record<RoomKind, number>>((acc, r) => ({ ...acc, [r.kind]: acc[r.kind] + 1 }), { personal: 0, meeting: 0, lounge: 0, listening: 0 });

  const save = async () => {
    try {
      const w = Number(width);
      const h = Number(height);
      const tooSmall = Object.values(rooms).some((r) => r.x + r.w > w || r.y + r.h > h);
      if (tooSmall) return toast({ tone: 'error', title: 'Some rooms would fall off the floor', body: 'Move them in first, or keep the floor larger.' });
      const next = await api.updateFloor({ name, width: w, height: h });
      useStore.setState({ floor: next, officeName: next.name });
      toast({ tone: 'success', title: 'Floor saved' });
    } catch (err) {
      toast({ tone: 'error', title: (err as Error).message });
    }
  };

  return (
    <motion.div className="inspector" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }}>
      <h2>Floor</h2>
      <p className="inspector__sub">Select a room to edit it.</p>
      <div className="stat-row">
        <div>
          <strong>{counts.personal}</strong>
          <span>Personal</span>
        </div>
        <div>
          <strong>{counts.meeting}</strong>
          <span>Meeting</span>
        </div>
        <div>
          <strong>{counts.lounge}</strong>
          <span>Lounge</span>
        </div>
      </div>
      <Field label="Office name" value={name} onChange={(e) => setName(e.target.value)} />
      <div className="form-row">
        <Field label="Width" type="number" min={600} step={50} value={width} onChange={(e) => setWidth(e.target.value)} />
        <Field label="Height" type="number" min={400} step={50} value={height} onChange={(e) => setHeight(e.target.value)} />
      </div>
      <Button variant="primary" block onClick={save} disabled={name === floor.name && Number(width) === floor.width && Number(height) === floor.height}>
        Save floor
      </Button>
    </motion.div>
  );
}

function RoomInspector({ room, onDeleted }: { room: Room; onDeleted: () => void }) {
  const users = useStore((s) => s.users);
  const rooms = useStore((s) => s.rooms);
  const presence = useStore((s) => s.presence);
  const putRoom = useStore((s) => s.putRoom);
  const toast = useStore((s) => s.toast);
  const [name, setName] = useState(room.name);
  const [capacity, setCapacity] = useState(String(room.capacity));
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setName(room.name), [room.name]);
  useEffect(() => setCapacity(String(room.capacity)), [room.capacity]);

  const patch = async (body: Partial<Room>) => {
    const before = room;
    putRoom({ ...room, ...body });
    try {
      putRoom(await api.updateRoom(room.id, body));
    } catch (err) {
      putRoom(before);
      toast({ tone: 'error', title: (err as Error).message });
    }
  };

  const owners = useMemo(() => Object.values(users).sort((a, b) => a.displayName.localeCompare(b.displayName)), [users]);
  const ownsAnother = (id: string) => Object.values(rooms).some((r) => r.id !== room.id && r.kind === 'personal' && r.ownerId === id);
  const inside = occupantsOf(presence, room.id).length;

  return (
    <motion.div className="inspector" data-hue={room.hue} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }}>
      <div className="inspector__swatch" />
      <Field
        label="Room name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() && name !== room.name && patch({ name: name.trim() })}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      <div className="picker">
        <span className="picker__label">Kind</span>
        <Segmented<RoomKind>
          size="sm"
          layoutId="room-kind"
          value={room.kind}
          onChange={(kind) => patch({ kind, ownerId: kind === 'personal' ? room.ownerId : null })}
          options={[
            { value: 'personal', label: 'Personal', icon: <Armchair size={13} /> },
            { value: 'meeting', label: 'Meeting', icon: <Presentation size={13} /> },
            { value: 'lounge', label: 'Lounge', icon: <Sofa size={13} /> },
            { value: 'listening', label: 'Listen', icon: <Headphones size={13} />, title: 'Music only: microphones stay off' },
          ]}
        />
      </div>
      {room.kind === 'listening' && <p className="inspector__sub inspector__tip">Music only: microphones stay off here, so headphones keep full sound quality.</p>}
      {room.kind === 'personal' && (
        <label className="field">
          <span className="field__label">Owner</span>
          <span className="field__control">
            <select value={room.ownerId ?? ''} onChange={(e) => patch({ ownerId: e.target.value || null })}>
              <option value="">Nobody yet</option>
              {owners.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName}
                  {ownsAnother(u.id) ? ' (has a room)' : ''}
                </option>
              ))}
            </select>
          </span>
        </label>
      )}
      <div className="picker">
        <span className="picker__label">Color</span>
        <HuePicker value={room.hue} onChange={(hue) => patch({ hue })} />
      </div>
      <div className="form-row">
        <Field
          label="Capacity"
          type="number"
          min={1}
          max={50}
          value={capacity}
          onChange={(e) => setCapacity(e.target.value)}
          onBlur={() => {
            const n = Math.round(Number(capacity));
            if (n >= 1 && n <= 50 && n !== room.capacity) void patch({ capacity: n });
            else setCapacity(String(room.capacity));
          }}
        />
        <div className="field">
          <span className="field__label">Inside now</span>
          <span className="field__static">{inside}</span>
        </div>
      </div>
      <div className="picker">
        <span className="picker__label">Door</span>
        <Segmented<LockMode>
          size="sm"
          layoutId="room-lock"
          value={room.lockMode}
          onChange={(lockMode) => patch({ lockMode })}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'knock', label: 'Knock' },
            { value: 'locked', label: 'Locked' },
          ]}
        />
      </div>
      <p className="inspector__sub">{KIND_LABEL[room.kind]} · {Math.round(room.w)} × {Math.round(room.h)}</p>
      {confirming ? (
        <div className="confirm-inline">
          <span>Delete this room?{inside ? ` ${inside} inside will step out.` : ''}</span>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            Keep
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={async () => {
              try {
                await api.deleteRoom(room.id);
                onDeleted();
              } catch (err) {
                toast({ tone: 'error', title: (err as Error).message });
              }
            }}
          >
            Delete
          </Button>
        </div>
      ) : (
        <Button variant="ghost" block className="danger-hover" icon={<Trash2 size={15} />} onClick={() => setConfirming(true)}>
          Delete room
        </Button>
      )}
      <p className="inspector__sub inspector__tip">
        <KeyRound size={13} /> The door setting is the default people find when they arrive.
      </p>
    </motion.div>
  );
}

/** The first place on a 20-unit grid where a w×h room fits without touching another, scanning row by row. */
export function findFreeSpot(rooms: Room[], floorW: number, floorH: number, w: number, h: number) {
  const gap = 40;
  const hits = (x: number, y: number) =>
    rooms.some((r) => x < r.x + r.w + gap && x + w + gap > r.x && y < r.y + r.h + gap && y + h + gap > r.y);
  for (let y = 80; y + h <= floorH - 110; y += 20) {
    for (let x = 80; x + w <= floorW - 40; x += 20) if (!hits(x, y)) return { x, y, w, h };
  }
  // No room left: put it below everything; the caller grows the floor.
  const bottom = rooms.reduce((m, r) => Math.max(m, r.y + r.h), 0);
  return { x: 80, y: bottom + gap + 20, w, h };
}
