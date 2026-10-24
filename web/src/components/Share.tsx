import { AnimatePresence, motion } from 'framer-motion';
import { AppWindow, Expand, Globe, Lock, Settings2, Maximize2, Monitor, MonitorUp, PictureInPicture2, Radio, ScreenShare, Volume2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { desktop, type CaptureSource } from '../lib/desktop';
import { useStore } from '../lib/store';
import { useVoice, voice } from '../lib/voice';
import { Avatar } from './Avatar';
import { Button, Modal, Segmented } from './ui';

/** Which picker is open, if any. */
export const useSharePicker = create<{ mode: 'screen' | 'audio' | null }>(() => ({ mode: null }));

export function openSharePicker(mode: 'screen' | 'audio') {
  useSharePicker.setState({ mode });
}

const PLAYER_SITES = [
  { label: 'YouTube', url: 'https://www.youtube.com' },
  { label: 'YouTube Music', url: 'https://music.youtube.com' },
  { label: 'SoundCloud', url: 'https://soundcloud.com' },
  { label: 'Radio Garden', url: 'https://radio.garden' },
];

export function SharePicker() {
  const mode = useSharePicker((s) => s.mode);
  const close = () => useSharePicker.setState({ mode: null });
  return (
    <Modal
      open={!!mode}
      onClose={close}
      title={mode === 'screen' ? 'Share your screen' : 'Share audio with the room'}
      subtitle={mode === 'screen' ? 'Everyone in your room will see it.' : 'Pick where the sound comes from.'}
      width={mode === 'screen' && desktop?.capture ? 760 : 560}
    >
      {mode === 'screen' ? <ScreenChoice onDone={close} /> : mode === 'audio' ? <AudioChoice onDone={close} /> : null}
    </Modal>
  );
}

// Screens and windows

function ScreenChoice({ onDone }: { onDone: () => void }) {
  const toast = useStore((s) => s.toast);
  const [sources, setSources] = useState<CaptureSource[] | null>(null);
  const [tab, setTab] = useState<'screen' | 'window'>('screen');
  const [selected, setSelected] = useState<string | null>(null);
  const [withAudio, setWithAudio] = useState(false);
  const [busy, setBusy] = useState(false);

  const [access, setAccess] = useState<string>('checking');

  useEffect(() => {
    const capture = desktop?.capture;
    if (!capture) return;
    let alive = true;
    let asked = false;
    const load = () =>
      capture.sources({ width: 400, height: 250 }).then((list) => {
        if (!alive) return;
        setSources(list);
        setSelected((cur) => cur ?? list.find((s) => s.kind === 'screen')?.id ?? null);
      });
    // Listing windows without permission makes macOS ask again, so check first, and only
    // refresh thumbnails once access is granted.
    const tick = async () => {
      const status = capture.access ? await capture.access() : 'granted';
      if (!alive) return;
      setAccess(status);
      if (status === 'granted') await load();
      else if (status === 'not-determined' && !asked) {
        asked = true;
        await load().catch(() => undefined);
      }
    };
    void tick();
    const t = window.setInterval(() => void tick(), 2500);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  const share = async (sourceId: string | null) => {
    setBusy(true);
    const problem = await voice.startScreen(sourceId, withAudio);
    setBusy(false);
    if (problem) toast({ tone: 'error', title: 'Couldn’t share', body: problem });
    else onDone();
  };

  if (!desktop?.capture) {
    // In a browser, the browser shows its own picker with tabs, windows and screens.
    return (
      <div className="share-browser">
        <span className="share-browser__icon">
          <ScreenShare size={26} />
        </span>
        <p>
          {desktop
            ? 'This version of Office shares your whole screen. Update Office (profile menu → Check for updates) to pick a single window.'
            : 'Your browser will ask what to share: a tab, a window or your entire screen. To include sound, pick a tab and turn on “Share tab audio”.'}
        </p>
        <Button variant="gradient" size="lg" block loading={busy} icon={<MonitorUp size={18} />} onClick={() => void share(null)}>
          Choose what to share
        </Button>
      </div>
    );
  }

  if (access === 'denied' || access === 'restricted') return <ScreenPermission onCancel={onDone} />;

  const list = (sources ?? []).filter((s) => s.kind === tab);
  return (
    <div className="picker-body">
      <Segmented<'screen' | 'window'>
        layoutId="share-kind"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'screen', label: 'Screens', icon: <Monitor size={14} /> },
          { value: 'window', label: 'Windows', icon: <AppWindow size={14} /> },
        ]}
      />
      <div className="source-grid">
        {sources === null
          ? Array.from({ length: 3 }, (_, i) => <div key={i} className="source-card is-loading" />)
          : list.map((s, i) => (
              <motion.button
                key={s.id}
                className={`source-card ${selected === s.id ? 'is-selected' : ''}`}
                onClick={() => setSelected(s.id)}
                onDoubleClick={() => void share(s.id)}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0, transition: { delay: Math.min(i, 8) * 0.03 } }}
              >
                <span className="source-card__thumb">{s.thumbnail ? <img src={s.thumbnail} alt="" /> : <Monitor size={28} />}</span>
                <span className="source-card__name">
                  {s.icon && <img src={s.icon} alt="" />}
                  <span>{s.name}</span>
                </span>
              </motion.button>
            ))}
        {sources !== null && !list.length && (
          <p className="source-grid__empty">{tab === 'window' ? 'No windows to share. Open the app you want to show.' : 'No screens found.'}</p>
        )}
      </div>
      <label className={`toggle ${withAudio ? 'is-on' : ''}`}>
        <span className="toggle__text">
          <strong>Also share my computer’s sound</strong>
          <span>Everything your computer plays. People may hear their own voices faintly, so Office turns it down while anyone talks.</span>
        </span>
        <input type="checkbox" checked={withAudio} onChange={(e) => setWithAudio(e.target.checked)} />
        <span className="toggle__switch">
          <motion.span className="toggle__knob" layout transition={{ type: 'spring', stiffness: 600, damping: 32 }} />
        </span>
      </label>
      <div className="picker-footer">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="gradient" disabled={!selected} loading={busy} icon={<MonitorUp size={16} />} onClick={() => void share(selected)}>
          Share
        </Button>
      </div>
    </div>
  );
}

/** macOS hasn't allowed this copy of Office to record the screen yet. */
function ScreenPermission({ onCancel }: { onCancel: () => void }) {
  return (
    <div className="permission">
      <span className="permission__icon">
        <Lock size={24} />
      </span>
      <strong>Allow Office to see your screen</strong>
      <p>macOS needs your permission before Office can show your screen or windows to your room.</p>
      <ol className="permission__steps">
        <li>
          Open <b>System Settings → Privacy &amp; Security → Screen &amp; System Audio Recording</b>.
        </li>
        <li>
          Turn on <b>Office</b>. If it’s already on, select it, remove it with <b>−</b>, and come back here: that entry belongs to an older
          version of Office.
        </li>
        <li>If macOS asks, choose <b>Quit &amp; Reopen</b>.</li>
      </ol>
      <div className="picker-footer">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="gradient" icon={<Settings2 size={16} />} onClick={() => desktop?.capture?.openSettings?.()}>
          Open System Settings
        </Button>
      </div>
      <span className="permission__waiting">
        <span className="spinner" /> This continues by itself once access is on.
      </span>
    </div>
  );
}

// Audio sources

function AudioChoice({ onDone }: { onDone: () => void }) {
  const toast = useStore((s) => s.toast);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const startPlayer = async (target: string) => {
    if (!desktop?.player) return;
    setBusy('player');
    const opened = await desktop.player.open(target);
    if (!opened) {
      setBusy(null);
      return toast({ tone: 'error', title: 'That address didn’t work', body: 'Try something like youtube.com.' });
    }
    const problem = await voice.startShare('player');
    setBusy(null);
    if (problem) toast({ tone: 'error', title: 'Couldn’t share the player', body: problem });
    else onDone();
  };

  const startOther = async (source: 'system' | 'browser') => {
    setBusy(source);
    const problem = await voice.startShare(source);
    setBusy(null);
    if (problem) toast({ tone: 'error', title: 'Couldn’t share audio', body: problem });
    else onDone();
  };

  if (!desktop?.player) {
    return (
      <div className="audio-options">
        <div className="audio-option is-recommended">
          <span className="audio-option__icon">
            <Globe size={22} />
          </span>
          <span className="audio-option__text">
            <strong>
              A browser tab <em>No echo</em>
            </strong>
            <span>Play music in another tab (YouTube, Spotify Web…). In the next window pick that tab and turn on “Share tab audio”. Only that tab is heard.</span>
          </span>
        </div>
        <Button variant="gradient" size="lg" block loading={busy === 'browser'} icon={<Radio size={18} />} onClick={() => void startOther('browser')}>
          Choose a tab
        </Button>
      </div>
    );
  }

  return (
    <div className="audio-options">
      <div className="audio-option is-recommended">
        <span className="audio-option__icon">
          <Globe size={22} />
        </span>
        <span className="audio-option__text">
          <strong>
            Web player <em>No echo</em>
          </strong>
          <span>Opens a player window inside Office. Only its sound reaches the room, so nobody hears themselves.</span>
        </span>
        <div className="audio-option__sites">
          {PLAYER_SITES.map((site) => (
            <button key={site.url} className="site-chip" disabled={!!busy} onClick={() => void startPlayer(site.url)}>
              {site.label}
            </button>
          ))}
        </div>
        <form
          className="audio-option__url"
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim()) void startPlayer(url.trim());
          }}
        >
          <input placeholder="Or type any site, like bandcamp.com" value={url} onChange={(e) => setUrl(e.target.value)} />
          <Button size="sm" variant="primary" loading={busy === 'player'} disabled={!url.trim()}>
            Open
          </Button>
        </form>
        <small className="audio-option__note">Spotify’s and Apple Music’s web players need copy protection Office doesn’t include. For those, use their app and the option below.</small>
      </div>

      <button className="audio-option audio-option--button" disabled={!!busy} onClick={() => void startOther('system')}>
        <span className="audio-option__icon audio-option__icon--plain">
          <Volume2 size={22} />
        </span>
        <span className="audio-option__text">
          <strong>Entire computer sound</strong>
          <span>Spotify, Apple Music or any app. It also carries the voices you hear, so Office turns it almost silent while anyone talks.</span>
        </span>
        {busy === 'system' && <span className="spinner" />}
      </button>
    </div>
  );
}

// Watching a shared screen

/** A shared screen in your room: large, minimized to a corner, or fullscreen. */
export function ScreenStage() {
  const meId = useStore((s) => s.meId);
  const roomId = useStore((s) => (s.meId ? s.presence[s.meId]?.roomId : null));
  const sharerId = useStore((s) => (roomId ? s.screens[roomId] : undefined));
  const sharer = useStore((s) => (sharerId ? s.users[sharerId] : undefined));
  const remote = useVoice((s) => (sharerId ? s.screens[sharerId] : undefined));
  const mine = useVoice((s) => s.myScreen);
  const [size, setSize] = useState<'large' | 'small'>('large');
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const isMe = !!sharerId && sharerId === meId;
  const stream = isMe ? mine : remote;

  useEffect(() => setSize(isMe ? 'small' : 'large'), [sharerId, isMe]);
  useEffect(() => {
    if (video.current && video.current.srcObject !== stream) video.current.srcObject = stream ?? null;
  }, [stream, size]);

  return (
    <AnimatePresence>
      {sharer && stream && (
        <motion.div
          key={sharerId}
          ref={box}
          className={`stage stage--${size} ${isMe ? 'is-mine' : ''}`}
          layout
          initial={{ opacity: 0, scale: 0.9, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.92, y: 20 }}
          transition={{ type: 'spring', stiffness: 320, damping: 30 }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <motion.header className="stage__bar" layout="position">
            <Avatar user={sharer} size={size === 'large' ? 30 : 24} />
            <span className="stage__title">
              {isMe ? 'Your screen' : `${sharer.displayName.split(' ')[0]}’s screen`}
              <i className="stage__live">Live</i>
            </span>
            <span className="stage__actions">
              {!isMe && (
                <button
                  onClick={() => setSize(size === 'large' ? 'small' : 'large')}
                  title={size === 'large' ? 'Make small' : 'Make large'}
                  aria-label={size === 'large' ? 'Make small' : 'Make large'}
                >
                  {size === 'large' ? <PictureInPicture2 size={16} /> : <Maximize2 size={15} />}
                </button>
              )}
              {!isMe && (
                <button onClick={() => void box.current?.requestFullscreen?.()} title="Fullscreen" aria-label="Fullscreen">
                  <Expand size={15} />
                </button>
              )}
              {isMe && (
                <button className="stage__stop" onClick={() => voice.stopScreen()} title="Stop sharing">
                  <X size={15} /> Stop
                </button>
              )}
            </span>
          </motion.header>
          <div className="stage__video" onDoubleClick={() => !isMe && void box.current?.requestFullscreen?.()}>
            <video ref={video} autoPlay playsInline muted />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** The dock button: opens the picker, or stops your share. */
export function ScreenButton() {
  const sharing = useVoice((s) => !!s.myScreen);
  return (
    <motion.button
      className={`dock__btn ${sharing ? 'is-danger' : ''}`}
      onClick={() => (sharing ? voice.stopScreen() : openSharePicker('screen'))}
      aria-label={sharing ? 'Stop sharing your screen' : 'Share your screen'}
      title={sharing ? 'Stop sharing your screen' : 'Share your screen'}
      whileTap={{ scale: 0.88 }}
    >
      {sharing ? <X size={19} /> : <MonitorUp size={19} />}
    </motion.button>
  );
}

/** On the map: a chip on any room where someone's screen is up. */
export function RoomScreenChip({ roomId }: { roomId: string }) {
  const user = useStore((s) => (s.screens[roomId] ? s.users[s.screens[roomId]] : undefined));
  return (
    <AnimatePresence>
      {user && (
        <motion.span className="room__music room__screen" initial={{ opacity: 0, y: 8, scale: 0.9 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }}>
          <ScreenShare size={11} />
          <span>{user.displayName.split(' ')[0]}’s screen</span>
        </motion.span>
      )}
    </AnimatePresence>
  );
}
