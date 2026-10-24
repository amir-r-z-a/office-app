import { create } from 'zustand';
import type { RtcSignal } from '@office/shared';
import { onRtcSignal, useStore } from './store';
import { playMuteToggle, setSoundOutput } from './sound';

// Voice runs peer to peer: everyone in a room holds one WebRTC connection to each other person
// there, negotiated through the office server. On a LAN there is no STUN or TURN to configure.

export type MicState = 'off' | 'requesting' | 'live' | 'denied' | 'missing' | 'error';
export type PeerState = 'connecting' | 'connected' | 'reconnecting';

interface Prefs {
  muted: boolean;
  deafened: boolean;
  inputId: string;
  outputId: string;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  volumes: Record<string, number>;
}

const PREFS_KEY = 'office.voice';
const DEFAULT_PREFS: Prefs = { muted: false, deafened: false, inputId: '', outputId: '', noiseSuppression: true, echoCancellation: true, volumes: {} };

function loadPrefs(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') };
  } catch {
    return DEFAULT_PREFS;
  }
}

interface VoiceStore extends Prefs {
  mic: MicState;
  peers: Record<string, PeerState>;
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
  settingsOpen: boolean;
}

export const useVoice = create<VoiceStore>(() => ({
  ...loadPrefs(),
  mic: 'off',
  peers: {},
  inputs: [],
  outputs: [],
  settingsOpen: false,
}));

function savePrefs() {
  const { muted, deafened, inputId, outputId, noiseSuppression, echoCancellation, volumes } = useVoice.getState();
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ muted, deafened, inputId, outputId, noiseSuppression, echoCancellation, volumes }));
  } catch {
    // Settings just won't survive a restart.
  }
}

interface Peer {
  id: string;
  pc: RTCPeerConnection;
  /** The side with the larger id makes the first offer; the other answers on the same channel. */
  offerer: boolean;
  /** When both sides renegotiate at once (an ICE restart), the polite one gives way. */
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  /** Null on the answering side until the first offer arrives. */
  transceiver: RTCRtpTransceiver | null;
  audio: HTMLAudioElement;
  /** The other side's app session; a new one means they reloaded and the call starts over. */
  remoteSession: string | null;
  /** Signals are handled one at a time, in order. */
  queue: Promise<void>;
  restartTimer?: number;
}

/** Identifies this copy of the app, so others can tell a reload from a renegotiation. */
const SESSION = Math.random().toString(36).slice(2, 10);

const SPEAK_ON = 0.035;
const SPEAK_OFF_MS = 650;
const RELEASE_MIC_MS = 2500;

class VoiceEngine {
  private peers = new Map<string, Peer>();
  private stream: MediaStream | null = null;
  private acquiring: Promise<void> | null = null;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  /** A copy of the mic track for the meter, so it keeps listening while muted. */
  private meterTrack: MediaStreamTrack | null = null;
  private meterTimer: number | undefined;
  private releaseTimer: number | undefined;
  private level = 0;
  private levelListeners = new Set<(level: number) => void>();
  private speaking = false;
  private lastLoud = 0;
  private loudWhileMutedSince = 0;
  private lastMutedHint = 0;
  private container: HTMLDivElement | null = null;
  private started = false;
  /** The settings dialog is open and wants the mic for its level meter. */
  private previewing = false;

  start() {
    if (this.started) return;
    this.started = true;
    this.container = document.createElement('div');
    this.container.hidden = true;
    document.body.append(this.container);
    onRtcSignal((from, signal) => void this.onSignal(from, signal));

    useStore.subscribe((s, prev) => {
      if (s.presence !== prev.presence || s.meId !== prev.meId) this.sync();
      if (s.connection === 'online' && prev.connection !== 'online') this.announce();
      if (s.phase !== 'ready' && prev.phase === 'ready') this.stopAll();
    });
    navigator.mediaDevices?.addEventListener?.('devicechange', () => void this.refreshDevices());
    window.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || !e.shiftKey) return;
      if (e.key.toLowerCase() === 'm') {
        e.preventDefault();
        this.toggleMute();
      } else if (e.key.toLowerCase() === 'd') {
        e.preventDefault();
        this.toggleDeafen();
      }
    });
    void this.refreshDevices();
    setSoundOutput(useVoice.getState().outputId);
    this.sync();
  }

  // Who to talk to

  /** Everyone online in my room, except me. Nobody talks in the hallway. */
  private wantedPeers(): string[] {
    const { meId, presence } = useStore.getState();
    const room = meId ? presence[meId]?.roomId : null;
    if (!meId || !room) return [];
    return Object.values(presence)
      .filter((p) => p.online && p.roomId === room && p.userId !== meId)
      .map((p) => p.userId);
  }

  private sync() {
    const wanted = new Set(this.wantedPeers());
    for (const id of [...this.peers.keys()]) if (!wanted.has(id)) this.closePeer(id);
    for (const id of wanted) if (!this.peers.has(id)) this.openPeer(id);

    if (wanted.size) {
      window.clearTimeout(this.releaseTimer);
      this.releaseTimer = undefined;
      void this.ensureMic();
    } else if (this.stream && !this.releaseTimer) {
      // Alone again: let go of the microphone so the system's "mic in use" light goes off.
      this.releaseTimer = window.setTimeout(() => {
        this.releaseTimer = undefined;
        if (!this.peers.size && !this.previewing) this.releaseMic();
      }, RELEASE_MIC_MS);
    }
  }

  private openPeer(id: string) {
    const meId = useStore.getState().meId!;
    const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
    const offerer = meId > id;
    const audio = new Audio();
    audio.autoplay = true;
    this.container?.append(audio);
    const peer: Peer = {
      id,
      pc,
      offerer,
      polite: !offerer,
      makingOffer: false,
      ignoreOffer: false,
      transceiver: null,
      audio,
      remoteSession: null,
      queue: Promise.resolve(),
    };
    this.peers.set(id, peer);
    this.setPeerState(id, 'connecting');
    this.applyOutput(peer);

    pc.ontrack = (e) => {
      audio.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      void audio.play().catch(() => undefined);
    };
    pc.onicecandidate = (e) => this.signal(id, { candidate: e.candidate ? (e.candidate.toJSON() as RtcSignalCandidate) : null });
    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        if (pc.localDescription) this.signal(id, { description: pc.localDescription.toJSON() as RtcSignalDescription });
      } catch (err) {
        console.warn('voice: offer failed', err);
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connected') {
        window.clearTimeout(peer.restartTimer);
        this.setPeerState(id, 'connected');
      } else if (state === 'disconnected') {
        this.setPeerState(id, 'reconnecting');
        // Give a Wi-Fi blip a moment to recover on its own before renegotiating.
        window.clearTimeout(peer.restartTimer);
        peer.restartTimer = window.setTimeout(() => pc.connectionState !== 'connected' && pc.restartIce(), 3000);
      } else if (state === 'failed') {
        this.setPeerState(id, 'reconnecting');
        pc.restartIce();
      }
    };

    if (offerer) {
      // Adding the channel fires negotiationneeded, which sends the offer.
      peer.transceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
      const track = this.stream?.getAudioTracks()[0];
      if (track) void peer.transceiver.sender.replaceTrack(track);
    } else {
      // Let the offering side know we're here, in case it still holds a call with an older copy of us.
      this.signal(id, { hello: true });
    }
  }

  private closePeer(id: string) {
    const peer = this.peers.get(id);
    if (!peer) return;
    window.clearTimeout(peer.restartTimer);
    peer.pc.close();
    peer.audio.srcObject = null;
    peer.audio.remove();
    this.peers.delete(id);
    const { [id]: _gone, ...rest } = useVoice.getState().peers;
    useVoice.setState({ peers: rest });
  }

  private stopAll() {
    for (const id of [...this.peers.keys()]) this.closePeer(id);
    this.releaseMic();
  }

  private setPeerState(id: string, state: PeerState) {
    useVoice.setState({ peers: { ...useVoice.getState().peers, [id]: state } });
  }

  // Negotiation

  private signal(to: string, body: RtcSignalBody) {
    const { send, connection } = useStore.getState();
    if (connection === 'online') send({ type: 'rtc.signal', to, signal: { ...body, session: SESSION } as RtcSignal });
  }

  onSignal(from: string, signal: RtcSignal) {
    let peer = this.peers.get(from);
    if (peer && peer.remoteSession && signal.session !== peer.remoteSession) {
      // They reloaded or reconnected: the old call can't be resumed, so start a fresh one.
      this.closePeer(from);
      peer = undefined;
    }
    if (!peer) {
      // They saw us first; the server only relays between people in one room.
      this.openPeer(from);
      peer = this.peers.get(from)!;
    }
    peer.remoteSession = signal.session;
    const current = peer;
    current.queue = current.queue.then(() => this.handleSignal(current, signal)).catch((err) => console.warn('voice: signal failed', err));
  }

  private async handleSignal(peer: Peer, signal: RtcSignal) {
    const { pc } = peer;
    if (pc.signalingState === 'closed') return;
    if ('hello' in signal) return;
    if ('description' in signal) {
      const description = signal.description as RTCSessionDescriptionInit;
      const collision = description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
      peer.ignoreOffer = !peer.polite && collision;
      if (peer.ignoreOffer) return;
      await pc.setRemoteDescription(description);
      if (description.type === 'offer') {
        if (!peer.transceiver) {
          // Answer on the channel the offer created, and send our mic back on it.
          peer.transceiver = pc.getTransceivers().find((t) => t.receiver.track.kind === 'audio') ?? null;
          if (peer.transceiver) {
            peer.transceiver.direction = 'sendrecv';
            const track = this.stream?.getAudioTracks()[0];
            if (track) await peer.transceiver.sender.replaceTrack(track);
          }
        }
        await pc.setLocalDescription();
        if (pc.localDescription) this.signal(peer.id, { description: pc.localDescription.toJSON() as RtcSignalDescription });
      }
    } else if (signal.candidate) {
      try {
        await pc.addIceCandidate(signal.candidate as RTCIceCandidateInit);
      } catch (err) {
        if (!peer.ignoreOffer) throw err;
      }
    }
  }

  /** Tell everyone our mute state again, e.g. after reconnecting to the server. */
  private announce() {
    const { muted, deafened } = useVoice.getState();
    useStore.getState().send({ type: 'voice.set', muted: muted || deafened, deafened });
    this.speaking = false;
  }

  // Microphone

  private async ensureMic() {
    if (this.stream || this.acquiring) return this.acquiring ?? undefined;
    const mic = useVoice.getState().mic;
    if (mic === 'denied' || mic === 'missing') return;
    this.acquiring = this.acquireMic().finally(() => (this.acquiring = null));
    return this.acquiring;
  }

  private async acquireMic() {
    if (!navigator.mediaDevices?.getUserMedia) {
      useVoice.setState({ mic: 'error' });
      useStore.getState().toast({
        tone: 'error',
        title: 'Voice isn’t available here',
        body: 'Use the Office desktop app, or open the office at a secure address.',
      });
      return;
    }
    const { inputId, noiseSuppression, echoCancellation } = useVoice.getState();
    useVoice.setState({ mic: 'requesting' });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: inputId ? { ideal: inputId } : undefined,
          echoCancellation,
          noiseSuppression,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      // We may have been left alone while the permission prompt was open.
      if (!this.peers.size && !this.wantedPeers().length && !this.previewing) {
        stream.getTracks().forEach((t) => t.stop());
        useVoice.setState({ mic: 'off' });
        return;
      }
      this.useStream(stream);
      void this.refreshDevices();
    } catch (err) {
      const name = (err as DOMException).name;
      const mic: MicState = name === 'NotAllowedError' ? 'denied' : name === 'NotFoundError' ? 'missing' : 'error';
      useVoice.setState({ mic });
      useStore.getState().toast({
        tone: 'error',
        title: mic === 'denied' ? 'Microphone blocked' : mic === 'missing' ? 'No microphone found' : 'Couldn’t start your microphone',
        body: mic === 'denied' ? 'Allow microphone access for Office, then try again.' : 'You can still listen. Check your audio settings.',
      });
    }
  }

  private useStream(stream: MediaStream) {
    const old = this.stream;
    this.stream = stream;
    const track = stream.getAudioTracks()[0];
    this.applyMute();
    for (const peer of this.peers.values()) void peer.transceiver?.sender.replaceTrack(track);
    old?.getTracks().forEach((t) => t.stop());
    track.addEventListener('ended', () => {
      // Unplugged: fall back to the default device.
      if (this.stream === stream) void this.restartMic();
    });
    this.startMeter(stream);
    useVoice.setState({ mic: 'live' });
  }

  private releaseMic() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.stopMeter();
    if (this.speaking) this.setSpeaking(false);
    const mic = useVoice.getState().mic;
    if (mic === 'live' || mic === 'requesting') useVoice.setState({ mic: 'off' });
  }

  /** Open the mic while the settings dialog shows its level meter. */
  async beginPreview() {
    this.previewing = true;
    await this.ensureMic();
  }

  endPreview() {
    this.previewing = false;
    if (!this.peers.size) this.releaseMic();
  }

  /** Reopen the mic with the current settings, e.g. after picking another device. */
  async restartMic() {
    if (!this.peers.size && !this.previewing) return;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.stopMeter();
    useVoice.setState({ mic: 'off' });
    await this.ensureMic();
  }

  /** Try again after the mic was blocked or missing. */
  async retryMic() {
    useVoice.setState({ mic: 'off' });
    if (this.wantedPeers().length) await this.ensureMic();
    else await this.testPermission();
  }

  private async testPermission() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      void this.refreshDevices();
    } catch {
      useVoice.setState({ mic: 'denied' });
    }
  }

  private applyMute() {
    const { muted, deafened } = useVoice.getState();
    const track = this.stream?.getAudioTracks()[0];
    // A disabled track sends silence without renegotiating.
    if (track) track.enabled = !muted && !deafened;
  }

  // Level meter and speaking detection

  private startMeter(stream: MediaStream) {
    this.stopMeter();
    try {
      this.audioCtx ??= new AudioContext();
      void this.audioCtx.resume();
      this.meterTrack = stream.getAudioTracks()[0].clone();
      this.meterTrack.enabled = true;
      const source = this.audioCtx.createMediaStreamSource(new MediaStream([this.meterTrack]));
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 512;
      source.connect(this.analyser);
    } catch {
      return;
    }
    const buf = new Float32Array(this.analyser.fftSize);
    this.meterTimer = window.setInterval(() => {
      if (!this.analyser) return;
      this.analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      // Smooth falling edges so the meter doesn't flicker.
      this.level = rms > this.level ? rms : this.level * 0.82 + rms * 0.18;
      for (const fn of this.levelListeners) fn(Math.min(1, this.level * 6));
      this.detectSpeech(rms);
    }, 60);
  }

  private stopMeter() {
    window.clearInterval(this.meterTimer);
    this.meterTimer = undefined;
    this.analyser = null;
    this.meterTrack?.stop();
    this.meterTrack = null;
    this.level = 0;
    for (const fn of this.levelListeners) fn(0);
  }

  private detectSpeech(rms: number) {
    const now = Date.now();
    const { muted, deafened } = useVoice.getState();
    const loud = rms > SPEAK_ON;
    if (muted || deafened) {
      if (this.speaking) this.setSpeaking(false);
      // Talking while muted for a while: a gentle nudge, at most every half minute.
      if (loud) {
        this.loudWhileMutedSince ||= now;
        if (now - this.loudWhileMutedSince > 1500 && now - this.lastMutedHint > 30_000 && this.peers.size) {
          this.lastMutedHint = now;
          useStore.getState().toast({ tone: 'info', title: 'You’re muted', body: 'Press Ctrl+Shift+M or the mic button to talk.' });
        }
      } else this.loudWhileMutedSince = 0;
      return;
    }
    if (loud) {
      this.lastLoud = now;
      if (!this.speaking) this.setSpeaking(true);
    } else if (this.speaking && now - this.lastLoud > SPEAK_OFF_MS) {
      this.setSpeaking(false);
    }
  }

  private setSpeaking(speaking: boolean) {
    this.speaking = speaking;
    const { meId, voice, connection, send } = useStore.getState();
    if (meId && voice[meId]) useStore.setState({ voice: { ...voice, [meId]: { ...voice[meId], speaking } } });
    if (connection === 'online') send({ type: 'voice.speaking', speaking });
  }

  /** Follow the mic level, 0 to 1, without re-rendering React. */
  onLevel(fn: (level: number) => void): () => void {
    this.levelListeners.add(fn);
    return () => this.levelListeners.delete(fn);
  }

  // Controls

  toggleMute() {
    const { muted, deafened } = useVoice.getState();
    // Unmuting while deafened brings both back, like most call apps.
    if (deafened) useVoice.setState({ deafened: false, muted: false });
    else useVoice.setState({ muted: !muted });
    this.afterToggle();
  }

  toggleDeafen() {
    useVoice.setState({ deafened: !useVoice.getState().deafened });
    this.afterToggle();
  }

  private afterToggle() {
    const { muted, deafened } = useVoice.getState();
    playMuteToggle(muted || deafened);
    this.applyMute();
    for (const peer of this.peers.values()) peer.audio.muted = deafened;
    savePrefs();
    const { send, connection } = useStore.getState();
    if (connection === 'online') send({ type: 'voice.set', muted: muted || deafened, deafened });
  }

  setVolume(userId: string, volume: number) {
    useVoice.setState({ volumes: { ...useVoice.getState().volumes, [userId]: volume } });
    const peer = this.peers.get(userId);
    if (peer) peer.audio.volume = volume;
    savePrefs();
  }

  setInput(inputId: string) {
    useVoice.setState({ inputId });
    savePrefs();
    void this.restartMic();
  }

  setOutput(outputId: string) {
    useVoice.setState({ outputId });
    savePrefs();
    for (const peer of this.peers.values()) this.applyOutput(peer);
    setSoundOutput(outputId);
  }

  setProcessing(patch: Partial<Pick<Prefs, 'noiseSuppression' | 'echoCancellation'>>) {
    useVoice.setState(patch);
    savePrefs();
    void this.restartMic();
  }

  private applyOutput(peer: Peer) {
    const { outputId, volumes, deafened } = useVoice.getState();
    peer.audio.volume = volumes[peer.id] ?? 1;
    peer.audio.muted = deafened;
    const el = peer.audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (el.setSinkId) void el.setSinkId(outputId).catch(() => undefined);
  }

  async refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    // Without permission yet, labels are empty; show them once the mic has been allowed.
    useVoice.setState({
      inputs: devices.filter((d) => d.kind === 'audioinput' && d.deviceId),
      outputs: devices.filter((d) => d.kind === 'audiooutput' && d.deviceId),
    });
  }

  /** For tests and troubleshooting: how much audio has arrived from each person. */
  async debugStats() {
    const out: Record<string, { state: string; bytesReceived: number; bytesSent: number; signaling: string; local?: string; remote?: string; track: boolean }> = {};
    for (const [id, peer] of this.peers) {
      let bytesReceived = 0;
      let bytesSent = 0;
      (await peer.pc.getStats()).forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') bytesReceived += r.bytesReceived ?? 0;
        if (r.type === 'outbound-rtp' && r.kind === 'audio') bytesSent += r.bytesSent ?? 0;
      });
      out[id] = {
        state: peer.pc.connectionState,
        bytesReceived,
        bytesSent,
        signaling: peer.pc.signalingState,
        local: peer.pc.localDescription?.type,
        remote: peer.pc.remoteDescription?.type,
        track: !!peer.transceiver?.sender.track,
        ice: peer.pc.iceConnectionState,
        gathering: peer.pc.iceGatheringState,
        transceivers: peer.pc.getTransceivers().length,
      } as typeof out[string];
    }
    return out;
  }
}

type RtcSignalBody = RtcSignal extends infer S ? (S extends RtcSignal ? Omit<S, 'session'> : never) : never;
type RtcSignalDescription = Extract<RtcSignal, { description: unknown }>['description'];
type RtcSignalCandidate = NonNullable<Extract<RtcSignal, { candidate: unknown }>['candidate']>;

export const voice = new VoiceEngine();
(window as unknown as { __voice: VoiceEngine }).__voice = voice;
