import { AnimatePresence, motion } from 'framer-motion';
import { Footprints, Headphones, HeadphoneOff, Loader2, Mic, MicOff, Settings2, Volume1, Volume2, VolumeX } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useStore } from '../lib/store';
import { useVoice, voice } from '../lib/voice';
import { playDoorbell } from '../lib/sound';
import { Avatar } from './Avatar';
import { Modal } from './ui';
import { DockMusic } from './Music';
import { ScreenButton } from './Share';

/** The voice state of one person as everyone sees it, plus whether it's me. */
export function useVoiceOf(userId: string) {
  return useStore((s) => s.voice[userId]);
}

/** The control bar shown while you're in a room: who's here, mic, headphones, settings, leave. */
export function VoiceDock() {
  const meId = useStore((s) => s.meId);
  const presence = useStore((s) => s.presence);
  const rooms = useStore((s) => s.rooms);
  const users = useStore((s) => s.users);
  const voiceStates = useStore((s) => s.voice);
  const send = useStore((s) => s.send);
  const { muted, deafened, mic, peers } = useVoice();

  const roomId = meId ? presence[meId]?.roomId : null;
  const room = roomId ? rooms[roomId] : undefined;
  const others = room
    ? Object.values(presence)
        .filter((p) => p.online && p.roomId === room.id && p.userId !== meId && users[p.userId])
        .map((p) => p.userId)
    : [];
  const peerStates = Object.values(peers);
  const status = !others.length
    ? 'Just you here'
    : peerStates.some((p) => p === 'reconnecting')
      ? 'Reconnecting…'
      : peerStates.length < others.length || peerStates.some((p) => p === 'connecting')
        ? 'Connecting…'
        : `Talking with ${others.length}`;
  const live = others.length > 0 && status.startsWith('Talking');

  return (
    <AnimatePresence>
      {room && meId && (
        <motion.div
          className="dock glass"
          data-hue={room.hue}
          initial={{ opacity: 0, y: 40, x: '-50%', scale: 0.92 }}
          animate={{ opacity: 1, y: 0, x: '-50%', scale: 1 }}
          exit={{ opacity: 0, y: 30, x: '-50%', scale: 0.95 }}
          transition={{ type: 'spring', stiffness: 380, damping: 30 }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="dock__room">
            <span className="dock__swatch" />
            <span className="dock__room-text">
              <strong>{room.name}</strong>
              <span className={live ? 'is-live' : ''}>
                <i />
                {status}
              </span>
            </span>
          </div>

          {others.length > 0 && (
            <div className="dock__people">
              <AnimatePresence initial={false}>
                {others.slice(0, 5).map((id) => (
                  <motion.span key={id} layout initial={{ scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0, opacity: 0 }}>
                    <SpeakingAvatar userId={id} size={30} />
                  </motion.span>
                ))}
              </AnimatePresence>
              {others.length > 5 && <span className="dock__more">+{others.length - 5}</span>}
            </div>
          )}

          <div className="dock__controls">
            <DockMusic />
            <MicButton muted={muted || deafened} mic={mic} speaking={!!voiceStates[meId]?.speaking} />
            <DockButton
              label={deafened ? 'Turn sound back on (Ctrl+Shift+D)' : 'Turn off sound (Ctrl+Shift+D)'}
              active={deafened}
              tone="danger"
              onClick={() => voice.toggleDeafen()}
            >
              {deafened ? <HeadphoneOff size={19} /> : <Headphones size={19} />}
            </DockButton>
            <ScreenButton />
            <DockButton label="Audio settings" onClick={() => useVoice.setState({ settingsOpen: true })}>
              <Settings2 size={19} />
            </DockButton>
          </div>

          <button className="dock__leave" onClick={() => send({ type: 'room.leave' })} title="Step out to the hallway">
            <Footprints size={17} />
            <span>Leave</span>
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function DockButton({
  label,
  active,
  tone,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  tone?: 'danger' | 'warning';
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <motion.button
      className={`dock__btn ${active ? `is-${tone ?? 'active'}` : ''}`}
      onClick={onClick}
      aria-label={label}
      title={label}
      whileTap={{ scale: 0.88 }}
      transition={{ type: 'spring', stiffness: 600, damping: 20 }}
    >
      {children}
    </motion.button>
  );
}

/** The mic button, with a ring that grows with your voice. */
function MicButton({ muted, mic, speaking }: { muted: boolean; mic: ReturnType<typeof useVoice.getState>['mic']; speaking: boolean }) {
  const ring = useRef<HTMLSpanElement>(null);
  useEffect(
    () =>
      voice.onLevel((level) => {
        ring.current?.style.setProperty('--level', String(level));
      }),
    [],
  );
  const blocked = mic === 'denied' || mic === 'missing' || mic === 'error';
  const label = blocked
    ? mic === 'denied'
      ? 'Microphone blocked: click to try again'
      : 'No microphone: click to try again'
    : muted
      ? 'Unmute (Ctrl+Shift+M)'
      : 'Mute (Ctrl+Shift+M)';
  return (
    <motion.button
      className={`mic-btn ${muted ? 'is-muted' : ''} ${blocked ? 'is-blocked' : ''} ${speaking && !muted ? 'is-speaking' : ''}`}
      onClick={() => (blocked ? void voice.retryMic() : voice.toggleMute())}
      aria-label={label}
      title={label}
      aria-pressed={!muted}
      whileTap={{ scale: 0.88 }}
      transition={{ type: 'spring', stiffness: 600, damping: 20 }}
    >
      <span className="mic-btn__level" ref={ring} />
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={mic === 'requesting' ? 'wait' : muted || blocked ? 'off' : 'on'}
          className="mic-btn__icon"
          initial={{ scale: 0.4, opacity: 0, rotate: -30 }}
          animate={{ scale: 1, opacity: 1, rotate: 0 }}
          exit={{ scale: 0.4, opacity: 0, rotate: 30 }}
          transition={{ type: 'spring', stiffness: 600, damping: 26 }}
        >
          {mic === 'requesting' ? <Loader2 size={20} className="spin" /> : muted || blocked ? <MicOff size={20} /> : <Mic size={20} />}
        </motion.span>
      </AnimatePresence>
      {blocked && <span className="mic-btn__alert">!</span>}
    </motion.button>
  );
}

/** An avatar that glows while the person talks and shows a crossed-out mic while muted. */
export function SpeakingAvatar({ userId, size = 32 }: { userId: string; size?: number }) {
  const user = useStore((s) => s.users[userId]);
  const v = useVoiceOf(userId);
  if (!user) return null;
  return (
    <span className={`speak-ring ${v?.speaking ? 'is-speaking' : ''}`} data-hue={user.hue}>
      <Avatar user={user} size={size} />
      {(v?.muted || v?.deafened) && (
        <span className="speak-ring__muted" title={v.deafened ? 'Sound off' : 'Muted'}>
          {v.deafened ? <HeadphoneOff size={size * 0.3} /> : <MicOff size={size * 0.3} />}
        </span>
      )}
    </span>
  );
}

/** Per-person volume for someone in your room, remembered on this computer. */
export function VolumeControl({ userId }: { userId: string }) {
  const volume = useVoice((s) => s.volumes[userId] ?? 1);
  const peerState = useVoice((s) => s.peers[userId]);
  const Icon = volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  return (
    <div className="volume" title={`Volume ${Math.round(volume * 100)}%`} onPointerDown={(e) => e.stopPropagation()}>
      {peerState && peerState !== 'connected' ? (
        <span className="volume__state">{peerState === 'connecting' ? 'Connecting…' : 'Reconnecting…'}</span>
      ) : (
        <>
          <button className="volume__icon" onClick={() => voice.setVolume(userId, volume === 0 ? 1 : 0)} aria-label={volume === 0 ? 'Unmute for me' : 'Mute for me'}>
            <Icon size={15} />
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(e) => voice.setVolume(userId, Number(e.target.value))}
            style={{ '--fill': `${volume * 100}%` } as React.CSSProperties}
            aria-label="Volume"
          />
        </>
      )}
    </div>
  );
}

export function AudioSettings() {
  const open = useVoice((s) => s.settingsOpen);
  const { inputs, outputs, inputId, outputId, noiseSuppression, echoCancellation, mic } = useVoice();
  const meter = useRef<HTMLSpanElement>(null);
  const [previewing, setPreviewing] = useState(false);
  const close = () => useVoice.setState({ settingsOpen: false });

  useEffect(() => {
    if (!open) return;
    void voice.refreshDevices();
    void voice.beginPreview().then(() => setPreviewing(true));
    const off = voice.onLevel((level) => meter.current?.style.setProperty('--level', String(level)));
    return () => {
      off();
      voice.endPreview();
      setPreviewing(false);
    };
  }, [open]);

  const sinkSupported = 'setSinkId' in HTMLAudioElement.prototype;

  return (
    <Modal open={open} onClose={close} title="Audio settings" subtitle="These are saved on this computer." width={500}>
      <label className="field">
        <span className="field__label">Microphone</span>
        <span className="field__control">
          <select value={inputId} onChange={(e) => voice.setInput(e.target.value)}>
            <option value="">System default</option>
            {inputs
              .filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications')
              .map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Microphone ${i + 1}`}
                </option>
              ))}
          </select>
        </span>
      </label>
      <div className="meter">
        <span className="meter__label">{mic === 'live' ? 'Say something: the bar should move' : mic === 'denied' ? 'Microphone access is blocked' : previewing ? 'Starting microphone…' : 'Microphone is off'}</span>
        <span className="meter__track">
          <span className="meter__fill" ref={meter} />
        </span>
      </div>

      {sinkSupported && (
        <label className="field">
          <span className="field__label">Speakers</span>
          <span className="field__control">
            <select value={outputId} onChange={(e) => voice.setOutput(e.target.value)}>
              <option value="">System default</option>
              {outputs
                .filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications')
                .map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Speakers ${i + 1}`}
                  </option>
                ))}
            </select>
            <button type="button" className="field__trailing field__trailing--text" onClick={playDoorbell}>
              Test
            </button>
          </span>
        </label>
      )}

      <div className="toggles">
        <Toggle label="Noise suppression" hint="Filters out keyboards, fans and chatter." checked={noiseSuppression} onChange={(v) => voice.setProcessing({ noiseSuppression: v })} />
        <Toggle label="Echo cancellation" hint="Keep on unless everyone wears headphones." checked={echoCancellation} onChange={(v) => voice.setProcessing({ echoCancellation: v })} />
      </div>

      <div className="shortcuts">
        <span>
          <kbd>Ctrl</kbd>
          <kbd>Shift</kbd>
          <kbd>M</kbd> Mute
        </span>
        <span>
          <kbd>Ctrl</kbd>
          <kbd>Shift</kbd>
          <kbd>D</kbd> Sound off
        </span>
      </div>
    </Modal>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={`toggle ${checked ? 'is-on' : ''}`}>
      <span className="toggle__text">
        <strong>{label}</strong>
        <span>{hint}</span>
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle__switch">
        <motion.span className="toggle__knob" layout transition={{ type: 'spring', stiffness: 600, damping: 32 }} />
      </span>
    </label>
  );
}
