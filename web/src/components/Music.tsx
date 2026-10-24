import { AnimatePresence, motion, Reorder, useDragControls } from 'framer-motion';
import {
  CirclePlay,
  GripVertical,
  ListMusic,
  ListPlus,
  Music2,
  Pause,
  Play,
  Plus,
  Radio,
  Repeat,
  Repeat1,
  Search,
  SkipBack,
  SkipForward,
  Trash2,
  Upload,
  Volume2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import type { QueueItem, RepeatMode, RoomMusic, Track } from '@office/shared';
import { api } from '../lib/api';
import { currentTrack, dismissUpload, formatTime, player, positionOf, uploadSongs, useMusic, useMyRoomMusic } from '../lib/music';
import { useMe, useStore } from '../lib/store';
import { voice } from '../lib/voice';
import { Avatar } from './Avatar';
import { Button, IconButton, Segmented } from './ui';
import { openSharePicker } from './Share';

// Small pieces

/** Album art, or a gradient picked from the song so every song looks a little different. */
export function Cover({ track, size, rounded = 10 }: { track?: Track; size: number; rounded?: number }) {
  const hue = useMemo(() => {
    let h = 0;
    for (const c of track?.id ?? 'none') h = (h * 31 + c.charCodeAt(0)) % 360;
    return h;
  }, [track?.id]);
  return (
    <span className="cover" style={{ width: size, height: size, borderRadius: rounded, '--cover-h': hue } as React.CSSProperties}>
      {track?.coverUrl ? <img src={track.coverUrl} alt="" draggable={false} /> : <Music2 size={size * 0.42} />}
    </span>
  );
}

/** Dancing bars: something is playing. */
export function Equalizer({ playing = true, size = 14 }: { playing?: boolean; size?: number }) {
  return (
    <span className={`eq ${playing ? 'is-playing' : ''}`} style={{ height: size, width: size }} aria-hidden>
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

function send(msg: Parameters<ReturnType<typeof useStore.getState>['send']>[0]) {
  useStore.getState().send(msg);
}

// The panel

export function MusicPanel({ onClose }: { onClose: () => void }) {
  const tab = useMusic((s) => s.tab);
  const music = useMyRoomMusic();
  const queueCount = music ? Math.max(0, music.queue.length - Math.max(0, music.index) - (music.index >= 0 ? 1 : 0)) : 0;
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    depth.current = 0;
    setDragging(false);
    const files = [...e.dataTransfer.files];
    if (files.length) {
      useMusic.setState({ tab: 'library' });
      void uploadSongs(files);
    }
  };

  return (
    <motion.aside
      className="panel music-panel"
      initial={{ opacity: 0, x: 40, scale: 0.98 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 30, scale: 0.98, transition: { duration: 0.18 } }}
      transition={{ type: 'spring', stiffness: 380, damping: 34 }}
      onPointerDown={(e) => e.stopPropagation()}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        depth.current++;
        setDragging(true);
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setDragging(false);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <NowPlaying music={music} onClose={onClose} />
      <div className="music-panel__tabs">
        <Segmented<'queue' | 'library' | 'share'>
          size="sm"
          layoutId="music-tab"
          value={tab}
          onChange={(t) => useMusic.setState({ tab: t })}
          options={[
            { value: 'queue', label: queueCount ? `Queue · ${queueCount}` : 'Queue', icon: <ListMusic size={13} /> },
            { value: 'library', label: 'Library', icon: <Music2 size={13} /> },
            { value: 'share', label: 'Share', icon: <Radio size={13} /> },
          ]}
        />
      </div>
      <div className="music-panel__body">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={tab}
            className="music-panel__page"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18 }}
          >
            {tab === 'queue' ? <QueueList music={music} /> : tab === 'library' ? <Library music={music} /> : <SharePane music={music} />}
          </motion.div>
        </AnimatePresence>
      </div>
      <AnimatePresence>
        {dragging && (
          <motion.div className="dropzone" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.div className="dropzone__inner" initial={{ scale: 0.92 }} animate={{ scale: 1 }}>
              <Upload size={30} />
              <strong>Drop songs to add them to the library</strong>
              <span>MP3, M4A, FLAC, OGG, WAV…</span>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.aside>
  );
}

function NowPlaying({ music, onClose }: { music?: RoomMusic; onClose: () => void }) {
  const library = useStore((s) => s.library);
  const users = useStore((s) => s.users);
  const meId = useStore((s) => s.meId);
  const volume = useMusic((s) => s.volume);
  const blocked = useMusic((s) => s.blocked);
  const track = currentTrack(music, library);
  const streamer = music?.streamerId ? users[music.streamerId] : undefined;
  const repeat = music?.repeat ?? 'off';
  const nextRepeat: Record<RepeatMode, RepeatMode> = { off: 'all', all: 'one', one: 'off' };

  return (
    <div className="now" style={{ '--cover-url': track?.coverUrl ? `url("${track.coverUrl}")` : 'none' } as React.CSSProperties}>
      <div className="now__backdrop" />
      <IconButton label="Close" className="panel__close" onClick={onClose}>
        <X size={18} />
      </IconButton>
      {streamer ? (
        <div className="now__stream">
          <div className="now__stream-art">
            <Avatar user={streamer} size={76} />
            <span className="now__stream-wave">
              <Equalizer size={22} />
            </span>
          </div>
          <strong>{streamer.id === meId ? 'You’re sharing your audio' : `${streamer.displayName.split(' ')[0]} is sharing their audio`}</strong>
          <span>{streamer.id === meId ? 'Everyone in this room hears whatever plays on your computer.' : 'Whatever plays on their computer, everyone here hears.'}</span>
          {streamer.id === meId && (
            <Button variant="danger" size="sm" icon={<X size={14} />} onClick={() => voice.stopShare()}>
              Stop sharing
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="now__main">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div
                key={track?.id ?? 'none'}
                className={`now__art ${music?.playing ? 'is-playing' : ''}`}
                initial={{ opacity: 0, scale: 0.85, rotate: -4 }}
                animate={{ opacity: 1, scale: 1, rotate: 0 }}
                exit={{ opacity: 0, scale: 0.9, rotate: 4 }}
                transition={{ type: 'spring', stiffness: 300, damping: 24 }}
              >
                <Cover track={track} size={92} rounded={18} />
              </motion.div>
            </AnimatePresence>
            <div className="now__meta">
              <span className="now__label">{track ? (music?.playing ? 'Now playing' : 'Paused') : 'Nothing playing'}</span>
              <strong>{track?.title ?? 'Pick a song from the library'}</strong>
              <span>{track ? track.artist || 'Unknown artist' : 'Everyone in this room will hear it.'}</span>
            </div>
          </div>
          <Progress music={music} track={track} />
          <div className="now__controls">
            <IconButton
              label={repeat === 'off' ? 'Repeat is off' : repeat === 'all' ? 'Repeating the queue' : 'Repeating this song'}
              active={repeat !== 'off'}
              className="now__small"
              onClick={() => send({ type: 'music.repeat', mode: nextRepeat[repeat] })}
            >
              {repeat === 'one' ? <Repeat1 size={17} /> : <Repeat size={17} />}
            </IconButton>
            <IconButton label="Previous" className="now__skip" onClick={() => send({ type: 'music.prev' })} disabled={!track}>
              <SkipBack size={20} fill="currentColor" />
            </IconButton>
            <motion.button
              className="now__play"
              onClick={() => send({ type: 'music.toggle', playing: !music?.playing })}
              disabled={!music?.queue.length}
              whileTap={{ scale: 0.9 }}
              aria-label={music?.playing ? 'Pause' : 'Play'}
            >
              <AnimatePresence mode="wait" initial={false}>
                <motion.span key={music?.playing ? 'pause' : 'play'} initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.5, opacity: 0 }} transition={{ duration: 0.12 }}>
                  {music?.playing ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" style={{ marginLeft: 3 }} />}
                </motion.span>
              </AnimatePresence>
            </motion.button>
            <IconButton label="Next" className="now__skip" onClick={() => send({ type: 'music.next' })} disabled={!track}>
              <SkipForward size={20} fill="currentColor" />
            </IconButton>
            <div className="now__volume" title={`Music volume ${Math.round(volume * 100)}%`}>
              <Volume2 size={15} />
              <input
                type="range"
                min={0}
                max={1}
                step={0.02}
                value={volume}
                onChange={(e) => player.setVolume(Number(e.target.value))}
                style={{ '--fill': `${volume * 100}%` } as React.CSSProperties}
                aria-label="Music volume"
              />
            </div>
          </div>
          {blocked && <p className="now__blocked">Click anywhere to start the sound.</p>}
        </>
      )}
    </div>
  );
}

/** The seek bar; it reads the clock every frame instead of re-rendering React. */
function Progress({ music, track }: { music?: RoomMusic; track?: Track }) {
  const fill = useRef<HTMLSpanElement>(null);
  const time = useRef<HTMLSpanElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [scrub, setScrub] = useState<number | null>(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (music && track && scrub === null) {
        const pos = Math.min(track.duration, positionOf(music, player.clockOffset));
        fill.current?.style.setProperty('--progress', String(pos / track.duration));
        if (time.current) time.current.textContent = formatTime(pos);
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [music, track, scrub]);

  const at = (clientX: number) => {
    const rect = bar.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };

  return (
    <div className="progress">
      <div
        ref={bar}
        className={`progress__bar ${track ? '' : 'is-empty'} ${scrub !== null ? 'is-scrubbing' : ''}`}
        onPointerDown={(e) => {
          if (!track) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          setScrub(at(e.clientX));
        }}
        onPointerMove={(e) => scrub !== null && setScrub(at(e.clientX))}
        onPointerUp={(e) => {
          if (scrub === null || !track) return;
          send({ type: 'music.seek', position: at(e.clientX) * track.duration });
          setScrub(null);
        }}
      >
        <span className="progress__fill" ref={fill} style={scrub !== null ? ({ '--progress': scrub } as React.CSSProperties) : undefined}>
          <i />
        </span>
      </div>
      <div className="progress__times">
        <span ref={time}>{scrub !== null && track ? formatTime(scrub * track.duration) : '0:00'}</span>
        <span>{track ? formatTime(track.duration) : '0:00'}</span>
      </div>
    </div>
  );
}

// Up next

function QueueList({ music }: { music?: RoomMusic }) {
  const library = useStore((s) => s.library);
  const [order, setOrder] = useState<QueueItem[]>([]);
  const upcoming = useMemo(() => (music ? music.queue.slice(music.index + 1) : []), [music]);
  const played = music && music.index > 0 ? music.queue.slice(0, music.index) : [];
  useEffect(() => setOrder(upcoming), [upcoming]);

  if (!music || (!music.queue.length && music.index < 0)) {
    return (
      <div className="music-empty">
        <span className="music-empty__icon">
          <ListMusic size={26} />
        </span>
        <strong>The queue is empty</strong>
        <span>Add songs from the library and they’ll play here for everyone in the room.</span>
        <Button size="sm" variant="primary" icon={<Music2 size={14} />} onClick={() => useMusic.setState({ tab: 'library' })}>
          Open the library
        </Button>
      </div>
    );
  }

  const commitMove = (item: QueueItem) => {
    const newIndex = order.findIndex((q) => q.id === item.id);
    const oldIndex = upcoming.findIndex((q) => q.id === item.id);
    if (newIndex !== oldIndex && newIndex >= 0) send({ type: 'music.move', itemId: item.id, toIndex: music.index + 1 + newIndex });
  };

  return (
    <div className="queue">
      {order.length ? (
        <>
          <div className="queue__head">
            <span>Up next</span>
            <button onClick={() => send({ type: 'music.clear' })}>Clear</button>
          </div>
          <Reorder.Group axis="y" values={order} onReorder={setOrder} className="queue__list">
            {order.map((item) => (
              <QueueRow key={item.id} item={item} track={library[item.trackId]} onDrop={() => commitMove(item)} />
            ))}
          </Reorder.Group>
        </>
      ) : (
        <p className="queue__end">That’s the last song. Add more from the library.</p>
      )}
      {played.length > 0 && (
        <>
          <div className="queue__head">
            <span>Played</span>
          </div>
          <ul className="queue__list queue__list--played">
            {played
              .slice(-8)
              .reverse()
              .map((item) => (
                <li key={item.id} className="song-row">
                  <Cover track={library[item.trackId]} size={36} rounded={8} />
                  <SongText track={library[item.trackId]} />
                  <IconButton label="Play again" onClick={() => send({ type: 'music.jump', itemId: item.id })}>
                    <CirclePlay size={16} />
                  </IconButton>
                </li>
              ))}
          </ul>
        </>
      )}
    </div>
  );
}

function QueueRow({ item, track, onDrop }: { item: QueueItem; track?: Track; onDrop: () => void }) {
  const controls = useDragControls();
  const adder = useStore((s) => s.users[item.addedBy]);
  return (
    <Reorder.Item
      value={item}
      dragListener={false}
      dragControls={controls}
      onDragEnd={onDrop}
      className="song-row song-row--queue"
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      whileDrag={{ scale: 1.03, boxShadow: 'var(--shadow-lg)', zIndex: 2 }}
    >
      <span className="song-row__grip" onPointerDown={(e) => controls.start(e)} title="Drag to reorder">
        <GripVertical size={15} />
      </span>
      <Cover track={track} size={38} rounded={8} />
      <SongText track={track} />
      {adder && (
        <span className="song-row__adder" title={`Added by ${adder.displayName}`}>
          <Avatar user={adder} size={20} />
        </span>
      )}
      <span className="song-row__actions">
        <IconButton label="Play now" onClick={() => send({ type: 'music.jump', itemId: item.id })}>
          <CirclePlay size={16} />
        </IconButton>
        <IconButton label="Remove from queue" className="danger-hover" onClick={() => send({ type: 'music.remove', itemId: item.id })}>
          <X size={16} />
        </IconButton>
      </span>
    </Reorder.Item>
  );
}

function SongText({ track }: { track?: Track }) {
  return (
    <span className="song-row__text">
      <strong>{track?.title ?? 'Removed song'}</strong>
      <span>
        {track?.artist || 'Unknown artist'}
        {track && ` · ${formatTime(track.duration)}`}
      </span>
    </span>
  );
}

// Library

function Library({ music }: { music?: RoomMusic }) {
  const library = useStore((s) => s.library);
  const users = useStore((s) => s.users);
  const toast = useStore((s) => s.toast);
  const me = useMe();
  const uploads = useMusic((s) => s.uploads);
  const [query, setQuery] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const playingId = currentTrack(music, library)?.id;

  const tracks = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(library)
      .filter((t) => !q || `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q))
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [library, query]);

  const remove = async (t: Track) => {
    try {
      await api.deleteTrack(t.id);
      toast({ tone: 'info', title: `Removed “${t.title}”` });
    } catch (err) {
      toast({ tone: 'error', title: (err as Error).message });
    }
  };

  return (
    <div className="library">
      <div className="library__bar">
        <label className="rail__search library__search">
          <Search size={15} />
          <input placeholder="Search songs and artists" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <Button size="sm" variant="primary" icon={<Upload size={14} />} onClick={() => fileInput.current?.click()}>
          Add
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept="audio/*,.mp3,.m4a,.aac,.ogg,.opus,.flac,.wav,.webm"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            if (files.length) void uploadSongs(files);
            e.target.value = '';
          }}
        />
      </div>

      <AnimatePresence initial={false}>
        {uploads.map((u) => (
          <motion.div key={u.id} className={`upload ${u.error ? 'has-error' : ''}`} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
            <span className="upload__name">{u.name}</span>
            {u.error ? (
              <>
                <span className="upload__error">{u.error}</span>
                <IconButton label="Dismiss" onClick={() => dismissUpload(u.id)}>
                  <X size={14} />
                </IconButton>
              </>
            ) : (
              <span className="upload__bar">
                <i style={{ width: `${Math.round(u.progress * 100)}%` }} />
              </span>
            )}
          </motion.div>
        ))}
      </AnimatePresence>

      {tracks.length ? (
        <ul className="library__list">
          {tracks.map((t, i) => {
            const uploader = t.uploadedBy ? users[t.uploadedBy] : undefined;
            const canRemove = me && (me.role === 'admin' || t.uploadedBy === me.id);
            return (
              <motion.li
                key={t.id}
                className={`song-row ${playingId === t.id ? 'is-current' : ''}`}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0, transition: { delay: Math.min(i, 15) * 0.015 } }}
                onDoubleClick={() => send({ type: 'music.playNow', trackId: t.id })}
              >
                <span className="song-row__art">
                  <Cover track={t} size={40} rounded={9} />
                  <button className="song-row__play" onClick={() => send({ type: 'music.playNow', trackId: t.id })} aria-label={`Play ${t.title} now`}>
                    {playingId === t.id && music?.playing ? <Equalizer size={14} /> : <Play size={16} fill="currentColor" />}
                  </button>
                </span>
                <span className="song-row__text">
                  <strong>{t.title}</strong>
                  <span>
                    {t.artist || 'Unknown artist'} · {formatTime(t.duration)}
                    {uploader && <em> · added by {uploader.id === me?.id ? 'you' : uploader.displayName.split(' ')[0]}</em>}
                  </span>
                </span>
                <span className="song-row__actions">
                  <IconButton label="Play next" onClick={() => send({ type: 'music.add', trackIds: [t.id], playNext: true })}>
                    <ListPlus size={16} />
                  </IconButton>
                  <IconButton label="Add to queue" onClick={() => send({ type: 'music.add', trackIds: [t.id] })}>
                    <Plus size={17} />
                  </IconButton>
                  {canRemove && (
                    <IconButton label="Remove from library" className="danger-hover" onClick={() => void remove(t)}>
                      <Trash2 size={15} />
                    </IconButton>
                  )}
                </span>
              </motion.li>
            );
          })}
        </ul>
      ) : (
        <div className="music-empty">
          <span className="music-empty__icon">
            <Upload size={24} />
          </span>
          <strong>{query ? 'No songs match' : 'The library is empty'}</strong>
          <span>{query ? 'Try another word.' : 'Drop music files here, or use Add. Everyone in the office can play them.'}</span>
        </div>
      )}
      {tracks.length > 1 && !query && (
        <Button size="sm" variant="ghost" block icon={<ListPlus size={14} />} onClick={() => send({ type: 'music.add', trackIds: tracks.map((t) => t.id) })}>
          Queue the whole library
        </Button>
      )}
    </div>
  );
}

// Sharing your computer's audio

function SharePane({ music }: { music?: RoomMusic }) {
  const users = useStore((s) => s.users);
  const meId = useStore((s) => s.meId);
  const streamer = music?.streamerId ? users[music.streamerId] : undefined;
  const mine = streamer?.id === meId;
  const isMac = navigator.platform.toLowerCase().includes('mac');

  const start = () => openSharePicker('audio');

  return (
    <div className="share">
      <div className="share__hero">
        <span className="share__icon">
          <Radio size={26} />
        </span>
        <strong>Share audio with the room</strong>
        <span>Play music in Office’s web player or anywhere on your computer, and everyone in this room hears it too. The queue pauses while you share.</span>
      </div>
      {streamer && !mine ? (
        <div className="share__other">
          <Avatar user={streamer} size={36} />
          <span>
            <strong>{streamer.displayName} is sharing right now</strong>
            <small>Starting your own share takes over from them.</small>
          </span>
        </div>
      ) : null}
      {mine && <ShareMeter />}
      {mine ? (
        <Button variant="danger" size="lg" block icon={<X size={18} />} onClick={() => voice.stopShare()}>
          Stop sharing
        </Button>
      ) : (
        <Button variant="gradient" size="lg" block icon={<Radio size={18} />} onClick={start}>
          Start sharing
        </Button>
      )}
      <ul className="share__tips">
        <li>The web player shares only its own sound. “Entire computer sound” shares everything, notifications included.</li>
        <li>Others control how loud it is with their music volume, and it fades down while people talk.</li>
        {isMac && (
          <li>
            On a Mac, the first share asks to allow screen and system audio recording. Allow it, then quit and reopen the app. If nothing comes
            through, check System Settings → Privacy &amp; Security → Screen &amp; System Audio Recording.
          </li>
        )}
      </ul>
    </div>
  );
}

/** A live meter of what you're sharing, so you can tell sound is getting out. */
function ShareMeter() {
  const fill = useRef<HTMLSpanElement>(null);
  const [silent, setSilent] = useState(true);
  useEffect(
    () =>
      voice.onShareLevel((level) => {
        fill.current?.style.setProperty('--level', String(level));
        if (level > 0.02) setSilent(false);
      }),
    [],
  );
  return (
    <div className="meter share__meter">
      <span className="meter__label">{silent ? 'Waiting for sound from your computer…' : 'Sound is going out to the room'}</span>
      <span className="meter__track">
        <span className="meter__fill" ref={fill} />
      </span>
    </div>
  );
}

// Compact pieces used elsewhere

/** In the voice dock: what's playing here, with play/pause. Click to open the music panel. */
export function DockMusic() {
  const music = useMyRoomMusic();
  const library = useStore((s) => s.library);
  const users = useStore((s) => s.users);
  const panelOpen = useMusic((s) => s.panelOpen);
  const track = currentTrack(music, library);
  const streamer = music?.streamerId ? users[music.streamerId] : undefined;
  const open = () => {
    useStore.getState().selectRoom(null);
    useMusic.setState({ panelOpen: !panelOpen });
  };

  if (!track && !streamer) {
    return (
      <motion.button className={`dock__btn ${panelOpen ? 'is-active' : ''}`} onClick={open} aria-label="Music" title="Music" whileTap={{ scale: 0.88 }}>
        <Music2 size={19} />
      </motion.button>
    );
  }
  return (
    <div className={`dock-music ${panelOpen ? 'is-open' : ''}`}>
      <button className="dock-music__info" onClick={open} title="Open music">
        {streamer ? <Avatar user={streamer} size={34} /> : <Cover track={track} size={34} rounded={9} />}
        <span className="dock-music__text">
          <strong>{streamer ? `${streamer.displayName.split(' ')[0]}’s audio` : track!.title}</strong>
          <span>
            <Equalizer playing={!!(streamer || music?.playing)} size={10} />
            {streamer ? 'Sharing live' : track!.artist || 'Unknown artist'}
          </span>
        </span>
      </button>
      {!streamer && (
        <motion.button
          className="dock-music__toggle"
          onClick={() => send({ type: 'music.toggle', playing: !music?.playing })}
          aria-label={music?.playing ? 'Pause' : 'Play'}
          whileTap={{ scale: 0.88 }}
        >
          {music?.playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" style={{ marginLeft: 2 }} />}
        </motion.button>
      )}
    </div>
  );
}

/** On the map: a chip on any room with music, visible from anywhere in the office. */
export function RoomNowPlaying({ roomId }: { roomId: string }) {
  const music = useStore((s) => s.music[roomId]);
  const library = useStore((s) => s.library);
  const streamer = useStore((s) => (music?.streamerId ? s.users[music.streamerId] : undefined));
  const track = currentTrack(music, library);
  const show = !!(streamer || (track && music?.playing));
  return (
    <AnimatePresence>
      {show && (
        <motion.span className="room__music" initial={{ opacity: 0, y: 8, scale: 0.9 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 6, scale: 0.9 }}>
          <Equalizer size={11} />
          <span>{streamer ? `${streamer.displayName.split(' ')[0]}’s audio` : `${track!.title}${track!.artist ? ` · ${track!.artist}` : ''}`}</span>
        </motion.span>
      )}
    </AnimatePresence>
  );
}
