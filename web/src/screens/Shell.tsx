import { AnimatePresence, motion } from 'framer-motion';
import { AudioLines, Camera, Check, ChevronDown, LogOut, Server, Map, Monitor, Moon, Settings2, Shield, Sun, Trash2, UserRound } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { HUES, STATUSES, type Hue, type Status } from '@office/shared';
import { api } from '../lib/api';
import { desktop } from '../lib/desktop';
import { useMe, useStore, type View } from '../lib/store';
import { useTheme, type ThemePref } from '../lib/theme';
import { Avatar, StatusDot, statusLabel } from '../components/Avatar';
import { Button, Field, Modal, Popover, Segmented } from '../components/ui';
import { Office, DoorbellStack } from './Office';
import { AudioSettings } from '../components/Voice';
import { useVoice } from '../lib/voice';
import { Admin } from './Admin';

export function Shell() {
  const view = useStore((s) => s.view);
  return (
    <div className="shell">
      <Sidebar />
      <main className="shell__main">
        <Topbar />
        <div className="shell__content">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={view}
              className="shell__view"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            >
              {view === 'office' ? <Office /> : <Admin />}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
      <DoorbellStack />
      <ProfileModal />
      <AudioSettings />
    </div>
  );
}

function Sidebar() {
  const me = useMe();
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const items: { id: View; label: string; icon: ReactNode; show: boolean }[] = [
    { id: 'office', label: 'Office', icon: <Map size={20} />, show: true },
    { id: 'admin', label: 'Admin', icon: <Shield size={20} />, show: me?.role === 'admin' },
  ];
  return (
    <nav className="sidebar">
      <div className="sidebar__logo">
        <img src="/icon.svg" alt="" width={36} height={36} />
      </div>
      <div className="sidebar__nav">
        {items
          .filter((i) => i.show)
          .map((i) => (
            <button key={i.id} className={`sidebar__item ${view === i.id ? 'is-active' : ''}`} onClick={() => setView(i.id)} aria-label={i.label}>
              {view === i.id && <motion.span layoutId="nav-active" className="sidebar__active" transition={{ type: 'spring', stiffness: 500, damping: 36 }} />}
              <span className="sidebar__icon">{i.icon}</span>
              <span className="sidebar__label">{i.label}</span>
            </button>
          ))}
      </div>
      <ThemeSwitch />
    </nav>
  );
}

function ThemeSwitch() {
  const { theme, toggle } = useTheme();
  return (
    <button className="theme-switch" onClick={toggle} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} title="Switch theme">
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={theme}
          initial={{ rotate: -90, scale: 0.4, opacity: 0 }}
          animate={{ rotate: 0, scale: 1, opacity: 1 }}
          exit={{ rotate: 90, scale: 0.4, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        >
          {theme === 'dark' ? <Moon size={19} /> : <Sun size={19} />}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}

function Topbar() {
  const officeName = useStore((s) => s.officeName);
  const connection = useStore((s) => s.connection);
  const presence = useStore((s) => s.presence);
  const users = useStore((s) => s.users);
  const view = useStore((s) => s.view);
  const online = Object.values(presence).filter((p) => p.online && users[p.userId]);
  return (
    <header className="topbar">
      <div className="topbar__title">
        <h1>{view === 'admin' ? 'Admin' : officeName}</h1>
        <AnimatePresence mode="wait">
          <motion.span
            key={connection}
            className={`conn conn--${connection}`}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
          >
            <i />
            {connection === 'online' ? `${online.length} in the office` : connection === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
          </motion.span>
        </AnimatePresence>
      </div>
      <div className="topbar__right">
        <div className="face-pile">
          <AnimatePresence initial={false}>
            {online.slice(0, 5).map((p) => (
              <motion.span key={p.userId} layout initial={{ scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0, opacity: 0 }}>
                <Avatar user={users[p.userId]} size={28} />
              </motion.span>
            ))}
          </AnimatePresence>
          {online.length > 5 && <span className="face-pile__more">+{online.length - 5}</span>}
        </div>
        <MeMenu />
      </div>
    </header>
  );
}

function MeMenu() {
  const me = useMe();
  const send = useStore((s) => s.send);
  const signOut = useStore((s) => s.signOut);
  const setProfileOpen = useStore((s) => s.setProfileOpen);
  const { pref, setPref } = useTheme();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(me?.statusText ?? '');
  useEffect(() => setText(me?.statusText ?? ''), [me?.statusText, open]);
  if (!me) return null;

  const setStatus = (status: Status) => send({ type: 'status.set', status, statusText: text });
  const saveText = () => text !== me.statusText && send({ type: 'status.set', status: me.status, statusText: text });

  return (
    <div className="me-menu">
      <button className={`me-button ${open ? 'is-open' : ''}`} onClick={() => setOpen(!open)}>
        <Avatar user={me} size={34} showStatus />
        <span className="me-button__text">
          <strong>{me.displayName}</strong>
          <span>{me.statusText || statusLabel(me.status)}</span>
        </span>
        <ChevronDown size={16} className="me-button__chevron" />
      </button>
      <Popover open={open} onClose={() => (saveText(), setOpen(false))} className="me-popover">
        <div className="me-popover__head">
          <Avatar user={me} size={48} showStatus />
          <div>
            <strong>{me.displayName}</strong>
            <span>@{me.username}</span>
          </div>
        </div>
        <label className="status-input">
          <input
            placeholder="What are you up to?"
            maxLength={80}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={saveText}
            onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget.blur(), setOpen(false))}
          />
        </label>
        <div className="status-list">
          {STATUSES.map((s) => (
            <button key={s} className={`status-option ${me.status === s ? 'is-active' : ''}`} onClick={() => setStatus(s)}>
              <StatusDot status={s} />
              <span>
                <strong>{statusLabel(s)}</strong>
                <small>
                  {s === 'available'
                    ? 'Visitors can ring your bell'
                    : s === 'busy'
                      ? 'People see you’re focused'
                      : s === 'away'
                        ? 'Stepped away for a bit'
                        : 'Your door locks, no doorbells'}
                </small>
              </span>
              {me.status === s && <Check size={16} />}
            </button>
          ))}
        </div>
        <div className="me-popover__section">
          <span className="me-popover__label">Theme</span>
          <Segmented<ThemePref>
            size="sm"
            layoutId="theme-pref"
            value={pref}
            onChange={setPref}
            options={[
              { value: 'light', label: 'Light', icon: <Sun size={13} /> },
              { value: 'dark', label: 'Dark', icon: <Moon size={13} /> },
              { value: 'system', label: 'Auto', icon: <Monitor size={13} /> },
            ]}
          />
        </div>
        <div className="me-popover__actions">
          <button className="menu-item" onClick={() => (setOpen(false), setProfileOpen(true))}>
            <Settings2 size={16} /> Edit profile
          </button>
          <button className="menu-item" onClick={() => (setOpen(false), useVoice.setState({ settingsOpen: true }))}>
            <AudioLines size={16} /> Audio settings
          </button>
          {desktop && (
            <button className="menu-item" onClick={() => (setOpen(false), desktop?.changeServer())}>
              <Server size={16} /> Change server
            </button>
          )}
          <button className="menu-item menu-item--danger" onClick={signOut}>
            <LogOut size={16} /> Sign out
          </button>
        </div>
      </Popover>
    </div>
  );
}

const EMOJIS = ['', '🎧', '☕', '🚀', '🎸', '🌿', '🦊', '🐼', '🎨', '💻', '📚', '⚡', '🌙', '🍕', '🎮', '🧠'];

function ProfileModal() {
  const open = useStore((s) => s.profileOpen);
  const setOpen = useStore((s) => s.setProfileOpen);
  const putUser = useStore((s) => s.putUser);
  const toast = useStore((s) => s.toast);
  const me = useMe();
  const [displayName, setDisplayName] = useState('');
  const [title, setTitle] = useState('');
  const [hue, setHue] = useState<Hue>('violet');
  const [emoji, setEmoji] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open || !me) return;
    setDisplayName(me.displayName);
    setTitle(me.title);
    setHue(me.hue);
    setEmoji(me.emoji);
    setCurrentPassword('');
    setNewPassword('');
    setError('');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!me) return null;
  const preview = { ...me, displayName: displayName || me.displayName, hue, emoji };

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const user = await api.updateMe({ displayName, title, hue, emoji, ...(newPassword ? { currentPassword, newPassword } : {}) });
      putUser(user);
      toast({ tone: 'success', title: 'Profile saved' });
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File) => {
    try {
      const blob = await squareImage(file, 256);
      putUser(await api.uploadAvatar(blob));
    } catch (err) {
      toast({ tone: 'error', title: 'Couldn’t use that picture', body: (err as Error).message });
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      title="Your profile"
      subtitle="How coworkers see you on the map."
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={save} disabled={!displayName.trim()}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="profile-hero" data-hue={hue}>
        <motion.div key={`${hue}${emoji}${me.avatarUrl}`} initial={{ scale: 0.85 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 400, damping: 18 }}>
          <Avatar user={preview} size={84} showStatus />
        </motion.div>
        <div className="profile-hero__actions">
          <Button size="sm" icon={<Camera size={15} />} onClick={() => fileInput.current?.click()}>
            {me.avatarUrl ? 'Change photo' : 'Upload photo'}
          </Button>
          {me.avatarUrl && (
            <Button size="sm" variant="ghost" icon={<Trash2 size={15} />} onClick={async () => putUser(await api.removeAvatar())}>
              Remove
            </Button>
          )}
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
              e.target.value = '';
            }}
          />
        </div>
      </div>

      <div className="form-row">
        <Field label="Name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        <Field label="Title" placeholder="e.g. Designer" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>

      <div className="picker">
        <span className="picker__label">Color</span>
        <HuePicker value={hue} onChange={setHue} />
      </div>

      {!me.avatarUrl && (
        <div className="picker">
          <span className="picker__label">Face</span>
          <div className="emoji-grid">
            {EMOJIS.map((e) => (
              <button key={e || 'initials'} className={`emoji-option ${emoji === e ? 'is-active' : ''}`} onClick={() => setEmoji(e)} type="button">
                {e || <UserRound size={16} />}
              </button>
            ))}
          </div>
        </div>
      )}

      <details className="disclosure">
        <summary>Change password</summary>
        <div className="form-row">
          <Field label="Current password" type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" />
          <Field label="New password" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" />
        </div>
      </details>
      {error && <p className="form-error">{error}</p>}
    </Modal>
  );
}

export function HuePicker({ value, onChange }: { value: Hue; onChange: (h: Hue) => void }) {
  return (
    <div className="hue-picker" role="radiogroup">
      {HUES.map((h) => (
        <button key={h} type="button" role="radio" aria-checked={value === h} aria-label={h} title={h} data-hue={h} className={`hue-swatch ${value === h ? 'is-active' : ''}`} onClick={() => onChange(h)}>
          {value === h && (
            <motion.span layoutId="hue-check" className="hue-swatch__ring" transition={{ type: 'spring', stiffness: 500, damping: 32 }} />
          )}
        </button>
      ))}
    </div>
  );
}

/** Center-crop a picture to a square and shrink it, so uploads stay small. */
async function squareImage(file: File, size: number): Promise<Blob> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('That file isn’t an image this computer can read.');
  });
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', 0.86));
  if (!blob) throw new Error('Couldn’t process the picture.');
  return blob;
}

