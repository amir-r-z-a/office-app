import { create } from 'zustand';
import type { RtcSignal, StreamSource } from '@office/shared';
import { desktop } from './desktop';
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
  /** Video arriving from each person in the room; it shows frames only while they share. */
  screens: Record<string, MediaStream>;
  /** What I'm sharing, for my own preview. */
  myScreen: MediaStream | null;
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
  settingsOpen: boolean;
}

export const useVoice = create<VoiceStore>(() => ({
  ...loadPrefs(),
  mic: 'off',
  peers: {},
  screens: {},
  myScreen: null,
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
  /** A second channel for someone sharing their computer's audio; silent until they do. */
  streamTransceiver: RTCRtpTransceiver | null;
  /** A third channel for screen sharing; silent until someone shares. */
  videoTransceiver: RTCRtpTransceiver | null;
  audio: HTMLAudioElement;
  streamAudio: HTMLAudioElement;
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
      if (this.shareTrack && (s.music !== prev.music || s.presence !== prev.presence)) {
        const room = s.meId ? s.presence[s.meId]?.roomId : null;
        const music = room ? s.music[room] : undefined;
        // Someone else took over, or we left: stop capturing without telling the server again.
        if (!room || (music && music.streamerId !== s.meId && prev.music[room]?.streamerId === s.meId)) this.stopShare(!!room);
      }
      if (this.screenTrack && (s.screens !== prev.screens || s.presence !== prev.presence)) {
        const room = s.meId ? s.presence[s.meId]?.roomId : null;
        if (!room || (prev.screens[room] === s.meId && s.screens[room] !== s.meId)) this.stopScreen(!!room);
      }
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
    // The room changed size while sharing: spread the bitrate again.
    if (this.screenTrack) for (const peer of this.peers.values()) void this.sendScreen(peer);

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
    const streamAudio = new Audio();
    streamAudio.autoplay = true;
    this.container?.append(audio, streamAudio);
    const peer: Peer = {
      id,
      pc,
      offerer,
      polite: !offerer,
      makingOffer: false,
      ignoreOffer: false,
      transceiver: null,
      streamTransceiver: null,
      videoTransceiver: null,
      audio,
      streamAudio,
      remoteSession: null,
      queue: Promise.resolve(),
    };
    this.peers.set(id, peer);
    this.setPeerState(id, 'connecting');
    this.applyOutput(peer);

    pc.ontrack = (e) => {
      // The offerer adds voice, the stream channel and the screen channel in that order: mids "0", "1", "2".
      if (e.track.kind === 'video') {
        useVoice.setState({ screens: { ...useVoice.getState().screens, [id]: new MediaStream([e.track]) } });
        return;
      }
      const el = e.transceiver.mid === '1' ? streamAudio : audio;
      el.srcObject = new MediaStream([e.track]);
      void el.play().catch(() => undefined);
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
      peer.streamTransceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
      peer.videoTransceiver = pc.addTransceiver('video', { direction: 'sendrecv' });
      preferH264(peer.videoTransceiver);
      if (this.screenTrack) void this.sendScreen(peer);
      const track = this.stream?.getAudioTracks()[0];
      if (track) void peer.transceiver.sender.replaceTrack(track);
      if (this.shareTrack) void this.sendShare(peer);
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
    peer.streamAudio.srcObject = null;
    peer.streamAudio.remove();
    const { [id]: _screen, ...screens } = useVoice.getState().screens;
    useVoice.setState({ screens });
    this.peers.delete(id);
    const { [id]: _gone, ...rest } = useVoice.getState().peers;
    useVoice.setState({ peers: rest });
  }

  private stopAll() {
    this.stopScreen(false);
    this.stopShare(false);
    for (const id of [...this.peers.keys()]) this.closePeer(id);
    this.releaseMic();
  }

  private setPeerState(id: string, state: PeerState) {
    useVoice.setState({ peers: { ...useVoice.getState().peers, [id]: state } });
  }

  // Negotiation

  private signal(to: string, body: RtcSignalBody) {
    if ('description' in body && body.description.sdp) body = { description: { ...body.description, sdp: tuneSdp(body.description.sdp) } };
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
          // Answer on the channels the offer created: voice first, then the stream channel.
          const [voiceT, streamT, videoT] = pc.getTransceivers();
          peer.transceiver = voiceT ?? null;
          peer.streamTransceiver = streamT ?? null;
          peer.videoTransceiver = videoT ?? null;
          if (videoT) preferH264(videoT);
          for (const t of [voiceT, streamT, videoT]) if (t) t.direction = 'sendrecv';
          const track = this.stream?.getAudioTracks()[0];
          if (track && voiceT) await voiceT.sender.replaceTrack(track);
          if (this.shareTrack) await this.sendShare(peer);
          if (this.screenTrack) await this.sendScreen(peer);
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
    peer.streamAudio.volume = this.streamVolume;
    peer.streamAudio.muted = deafened;
    for (const el of [peer.audio, peer.streamAudio] as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> })[]) {
      if (el.setSinkId) void el.setSinkId(outputId).catch(() => undefined);
    }
  }

  // Sharing your computer's audio

  private shareTrack: MediaStreamTrack | null = null;
  private streamVolume = 0.7;

  /** Shared audio plays at the music volume. */
  setStreamVolume(volume: number) {
    this.streamVolume = Math.max(0, Math.min(1, volume));
    for (const peer of this.peers.values()) peer.streamAudio.volume = this.streamVolume;
  }

  private async sendShare(peer: Peer) {
    const sender = peer.streamTransceiver?.sender;
    if (!sender) return;
    await sender.replaceTrack(this.shareTrack);
    try {
      // Music needs more room than speech.
      const params = sender.getParameters();
      if (params.encodings?.length) {
        params.encodings[0].maxBitrate = 160_000;
        await sender.setParameters(params);
      }
    } catch {
      // Older engines: the default bitrate still works.
    }
  }

  private shareSource: StreamSource | null = null;
  private playerOff: (() => void) | null = null;

  /**
   * Start sending sound to everyone in the room.
   * - `system`: everything this computer plays (any app), which can carry voices back.
   * - `player`: only the built-in web player of the desktop app.
   * In a browser the browser's own picker asks; picking a tab shares just that tab.
   */
  async startShare(source: StreamSource = 'system', captured?: MediaStream): Promise<string | null> {
    if (this.shareTrack) this.stopShare(false);
    let stream = captured;
    if (!stream) {
      if (!navigator.mediaDevices?.getDisplayMedia) return 'Sharing audio isn’t available here. Use the Office desktop app.';
      try {
        if (desktop?.capture && source !== 'browser') {
          desktop.capture.choose({ sourceId: null, audio: source === 'player' ? 'player' : 'system' });
          stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        } else {
          source = 'browser';
          stream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
            systemAudio: 'include',
            ...({ restrictOwnAudio: true, selfBrowserSurface: 'exclude', preferCurrentTab: false } as object),
          } as DisplayMediaStreamOptions);
        }
      } catch (err) {
        return (err as DOMException).name === 'NotAllowedError' ? null : 'Couldn’t capture that sound.';
      }
    }
    // Only the sound is wanted; drop any video the capture came with.
    stream.getVideoTracks().forEach((t) => t.stop());
    const track = stream.getAudioTracks()[0];
    if (!track) return 'No sound was shared. Pick a tab or screen and turn on “Share audio”.';
    track.contentHint = 'music';
    this.shareTrack = track;
    this.shareSource = source;
    track.addEventListener('ended', () => this.stopShare());
    if (source === 'player') this.playerOff = desktop?.player?.onClosed(() => this.stopShare()) ?? null;
    for (const peer of this.peers.values()) await this.sendShare(peer);
    useStore.getState().send({ type: 'music.stream', on: true, source });
    this.watchShare(track);
    return null;
  }

  private shareMeter: { timer: number; clone: MediaStreamTrack } | null = null;
  private shareListeners = new Set<(level: number) => void>();

  /** Follow how loud the shared audio is, 0 to 1, so the sharer can see it's working. */
  onShareLevel(fn: (level: number) => void): () => void {
    this.shareListeners.add(fn);
    return () => this.shareListeners.delete(fn);
  }

  /**
   * Measure the shared audio. Some systems hand over a track that is pure silence (a missing
   * permission on macOS, for one), so if nothing at all arrives for a while, say so.
   */
  private watchShare(track: MediaStreamTrack) {
    this.stopShareMeter();
    let analyser: AnalyserNode;
    const clone = track.clone();
    try {
      this.audioCtx ??= new AudioContext();
      void this.audioCtx.resume();
      analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      this.audioCtx.createMediaStreamSource(new MediaStream([clone])).connect(analyser);
    } catch {
      clone.stop();
      return;
    }
    const buf = new Float32Array(analyser.fftSize);
    const started = Date.now();
    let heard = false;
    let warned = false;
    let level = 0;
    const timer = window.setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      if (rms > 0.0005) heard = true;
      level = rms > level ? rms : level * 0.85 + rms * 0.15;
      for (const fn of this.shareListeners) fn(Math.min(1, level * 5));
      if (!heard && !warned && Date.now() - started > 8000) {
        warned = true;
        useStore.getState().toast({
          tone: 'error',
          title: 'No sound is coming through',
          body: navigator.userAgent.includes('Mac')
            ? 'Play something. If the meter stays flat, allow Office (or Electron) under System Settings → Privacy & Security → Screen & System Audio Recording, then reopen the app.'
            : 'Play something on your computer. If the meter stays flat, stop and share again, and make sure audio is included.',
        });
      }
    }, 80);
    this.shareMeter = { timer, clone };
  }

  private stopShareMeter() {
    if (!this.shareMeter) return;
    window.clearInterval(this.shareMeter.timer);
    this.shareMeter.clone.stop();
    this.shareMeter = null;
    for (const fn of this.shareListeners) fn(0);
  }

  stopShare(tellServer = true) {
    if (!this.shareTrack) return;
    this.playerOff?.();
    this.playerOff = null;
    if (this.shareSource === 'player') desktop?.player?.close();
    this.shareSource = null;
    this.stopShareMeter();
    this.shareTrack.stop();
    this.shareTrack = null;
    for (const peer of this.peers.values()) void peer.streamTransceiver?.sender.replaceTrack(null);
    if (tellServer && useStore.getState().connection === 'online') useStore.getState().send({ type: 'music.stream', on: false });
  }

  get sharing() {
    return !!this.shareTrack;
  }

  // Screen sharing

  private screenTrack: MediaStreamTrack | null = null;
  private screenMode: ScreenMode = 'smooth';
  /** Audio that came with the screen, sent on the stream channel. */
  private screenAudio = false;

  /**
   * Show a screen or a window to the room. In the desktop app `sourceId` comes from our own
   * picker; in a browser the browser's picker asks.
   */
  async startScreen(sourceId: string | null, withAudio: boolean, mode: ScreenMode = 'smooth'): Promise<string | null> {
    if (!navigator.mediaDevices?.getDisplayMedia) return 'Screen sharing isn’t available here. Use the Office desktop app.';
    // Capture at up to 1080p: Retina screens are several times that, and every extra pixel
    // costs encoding time, which shows up as stutter.
    const fps = mode === 'game' ? 60 : 30;
    const video: MediaTrackConstraints = {
      frameRate: { ideal: fps, max: fps },
      width: { max: MAX_SCREEN_WIDTH },
      height: { max: MAX_SCREEN_HEIGHT },
    };
    let stream: MediaStream;
    try {
      if (desktop?.capture) {
        desktop.capture.choose({ sourceId, audio: withAudio ? 'system' : 'none' });
        stream = await navigator.mediaDevices.getDisplayMedia({ video, audio: withAudio });
      } else {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video,
          audio: true,
          ...({ selfBrowserSurface: 'exclude', systemAudio: 'include' } as object),
        } as DisplayMediaStreamOptions);
      }
    } catch (err) {
      return (err as DOMException).name === 'NotAllowedError' ? null : 'Couldn’t start sharing your screen.';
    }
    const track = stream.getVideoTracks()[0];
    if (!track) return 'Nothing was picked to share.';
    this.stopScreen(false);
    // "motion" keeps the frame rate up when things move; "detail" keeps text crisp.
    track.contentHint = mode === 'sharp' ? 'detail' : 'motion';
    this.screenMode = mode;
    this.screenTrack = track;
    track.addEventListener('ended', () => this.stopScreen());
    useVoice.setState({ myScreen: new MediaStream([track]) });
    for (const peer of this.peers.values()) await this.sendScreen(peer);
    useStore.getState().send({ type: 'screen.share', on: true });

    const audio = stream.getAudioTracks()[0];
    if (audio) {
      this.screenAudio = true;
      await this.startShare(desktop?.capture ? 'system' : 'browser', new MediaStream([audio]));
    }
    return null;
  }

  stopScreen(tellServer = true) {
    if (!this.screenTrack) return;
    this.screenTrack.stop();
    this.screenTrack = null;
    useVoice.setState({ myScreen: null });
    for (const peer of this.peers.values()) void peer.videoTransceiver?.sender.replaceTrack(null);
    if (tellServer && useStore.getState().connection === 'online') useStore.getState().send({ type: 'screen.share', on: false });
    if (this.screenAudio) {
      this.screenAudio = false;
      this.stopShare(tellServer);
    }
  }

  get sharingScreen() {
    return !!this.screenTrack;
  }

  /**
   * Every viewer gets their own encoded copy, so the bitrate shrinks as the room grows. On an
   * office LAN there's plenty of room, so small rooms get a generous bitrate.
   */
  private async sendScreen(peer: Peer) {
    const sender = peer.videoTransceiver?.sender;
    if (!sender || !this.screenTrack) return void sender?.replaceTrack(null);
    await sender.replaceTrack(this.screenTrack);
    try {
      const viewers = Math.max(1, this.peers.size);
      const { width = MAX_SCREEN_WIDTH, height = MAX_SCREEN_HEIGHT } = this.screenTrack.getSettings();
      const params = sender.getParameters();
      // Sharp keeps every pixel and gives up frames; Games keeps every frame; Smooth trades a little
      // of both. ("maintain-framerate" alone, with a low bitrate, shrank the picture to a blur.)
      const mode = this.screenMode;
      params.degradationPreference = mode === 'sharp' ? 'maintain-resolution' : mode === 'game' ? 'maintain-framerate' : 'balanced';
      if (params.encodings?.length) {
        const e = params.encodings[0];
        // A LAN has room to spare; games need far more bits than a still desktop.
        const budget = mode === 'game' ? [12_000_000, 8_000_000, 4_000_000, 2_500_000] : [6_000_000, 4_000_000, 2_500_000, 1_500_000];
        e.maxBitrate = viewers === 1 ? budget[0] : viewers <= 3 ? budget[1] : viewers <= 7 ? budget[2] : budget[3];
        e.maxFramerate = mode === 'game' ? (viewers <= 3 ? 60 : 30) : viewers <= 7 ? 30 : 20;
        // In case the capture ignored the size limit, scale down when encoding instead. Big rooms
        // watching a game get 720p so every copy keeps its frame rate.
        const maxW = mode === 'game' && viewers > 3 ? 1280 : MAX_SCREEN_WIDTH;
        const maxH = mode === 'game' && viewers > 3 ? 720 : MAX_SCREEN_HEIGHT;
        e.scaleResolutionDownBy = Math.max(1, width / maxW, height / maxH);
        e.priority = 'high';
        e.networkPriority = 'high';
      }
      await sender.setParameters(params);
    } catch {
      // The defaults still work.
    }
  }

  /** For troubleshooting smoothness: what is actually being sent and received. */
  private lastBytes = new Map<string, { bytes: number; at: number }>();

  async screenStats(): Promise<ScreenStat[]> {
    const out: ScreenStat[] = [];
    for (const [id, peer] of this.peers) {
      const stats = await peer.pc.getStats();
      const codecs = new Map<string, string>();
      let rtt: number | undefined;
      let available: number | undefined;
      let remote: { lost?: number; jitter?: number; rtt?: number } = {};
      stats.forEach((r) => {
        if (r.type === 'codec') codecs.set(r.id, r.mimeType);
        if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') {
          rtt = r.currentRoundTripTime;
          available = r.availableOutgoingBitrate;
        }
        if (r.type === 'remote-inbound-rtp' && r.kind === 'video') remote = { lost: r.fractionLost, jitter: r.jitter, rtt: r.roundTripTime };
      });
      stats.forEach((r) => {
        if (r.kind !== 'video' || (r.type !== 'outbound-rtp' && r.type !== 'inbound-rtp')) return;
        const sending = r.type === 'outbound-rtp';
        if (!(sending ? r.framesEncoded : r.framesDecoded)) return;
        const bytes = sending ? r.bytesSent : r.bytesReceived;
        const key = `${id}:${sending ? 'out' : 'in'}`;
        const prev = this.lastBytes.get(key);
        const now = performance.now();
        this.lastBytes.set(key, { bytes, at: now });
        const kbps = prev && now > prev.at ? Math.round(((bytes - prev.bytes) * 8) / (now - prev.at)) : undefined;
        const lost = sending ? remote.lost : r.packetsLost / Math.max(1, r.packetsLost + r.packetsReceived);
        out.push({
          peerId: id,
          direction: sending ? 'sending' : 'receiving',
          codec: codecs.get(r.codecId)?.replace('video/', ''),
          fps: r.framesPerSecond,
          width: r.frameWidth,
          height: r.frameHeight,
          kbps,
          implementation: sending ? r.encoderImplementation : r.decoderImplementation,
          hardware: sending ? r.powerEfficientEncoder : r.powerEfficientDecoder,
          limit: sending ? r.qualityLimitationReason : undefined,
          lossPercent: lost === undefined ? undefined : Math.round(lost * 1000) / 10,
          rttMs: rtt !== undefined ? Math.round(rtt * 1000) : remote.rtt !== undefined ? Math.round(remote.rtt * 1000) : undefined,
          availableKbps: sending && available ? Math.round(available / 1000) : undefined,
          freezes: sending ? undefined : r.freezeCount,
        });
      });
    }
    return out;
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
      let streamBytes = 0;
      (await peer.pc.getStats()).forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio' && r.mid === '1') streamBytes += r.bytesReceived ?? 0;
        else if (r.type === 'inbound-rtp' && r.kind === 'audio') bytesReceived += r.bytesReceived ?? 0;
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
        streamBytes,
      } as typeof out[string];
    }
    return out;
  }
}

/** sharp: text and slides. smooth: everyday desktop. game: games and video, 60 fps. */
export type ScreenMode = 'sharp' | 'smooth' | 'game';

export interface ScreenStat {
  peerId: string;
  direction: 'sending' | 'receiving';
  codec?: string;
  fps?: number;
  width?: number;
  height?: number;
  kbps?: number;
  implementation?: string;
  hardware?: boolean;
  /** What the encoder says holds quality back: "bandwidth", "cpu" or "none". */
  limit?: string;
  lossPercent?: number;
  rttMs?: number;
  availableKbps?: number;
  freezes?: number;
}

/**
 * WebRTC starts video around 300 kbit/s and probes upward, sized for the internet. On an office
 * LAN that makes the first seconds of a screen share blurry and choppy. These codec hints, read
 * by the other side's sender, start it high and keep a floor under it.
 */
const VIDEO_START_KBPS = 4000;
const VIDEO_MIN_KBPS = 1500;

function tuneSdp(sdp: string): string {
  const lines = sdp.split('\r\n');
  const video = new Set<string>();
  let inVideo = false;
  for (const line of lines) {
    if (line.startsWith('m=')) inVideo = line.startsWith('m=video');
    const map = inVideo && /^a=rtpmap:(\d+) (H264|VP8|VP9|AV1)\//.exec(line);
    if (map) video.add(map[1]);
  }
  if (!video.size) return sdp;
  const hint = `x-google-start-bitrate=${VIDEO_START_KBPS};x-google-min-bitrate=${VIDEO_MIN_KBPS}`;
  const out: string[] = [];
  const hasFmtp = new Set<string>();
  for (const line of lines) {
    const fmtp = /^a=fmtp:(\d+) /.exec(line);
    if (fmtp && video.has(fmtp[1]) && !line.includes('x-google-start-bitrate')) {
      hasFmtp.add(fmtp[1]);
      out.push(`${line};${hint}`);
      continue;
    }
    if (fmtp) hasFmtp.add(fmtp[1]);
    out.push(line);
    // Codecs without an fmtp line get one right after their rtpmap.
    const map = /^a=rtpmap:(\d+) /.exec(line);
    if (map && video.has(map[1]) && !lines.some((l) => l.startsWith(`a=fmtp:${map[1]} `))) out.push(`a=fmtp:${map[1]} ${hint}`);
  }
  return out.join('\r\n');
}

const MAX_SCREEN_WIDTH = 1920;
const MAX_SCREEN_HEIGHT = 1080;

/**
 * Put H.264 first for screen video. Macs and most PCs encode it in hardware, which is far
 * faster than the default VP8 in software and keeps the frame rate up. Other codecs stay as
 * fallbacks, so a computer without H.264 still connects.
 */
function preferH264(transceiver: RTCRtpTransceiver) {
  const caps = typeof RTCRtpReceiver !== 'undefined' && RTCRtpReceiver.getCapabilities?.('video');
  if (!caps || !transceiver.setCodecPreferences) return;
  const rank = (c: RTCRtpCodec) => {
    if (c.mimeType !== 'video/H264') return 9;
    const fmtp = c.sdpFmtpLine ?? '';
    // Packetization mode 1 is what hardware encoders produce; prefer the common profiles.
    if (!fmtp.includes('packetization-mode=1')) return 5;
    if (fmtp.includes('profile-level-id=42e0')) return 0;
    if (fmtp.includes('profile-level-id=4d')) return 1;
    return 2;
  };
  const sorted = [...caps.codecs].sort((a, b) => rank(a) - rank(b));
  try {
    transceiver.setCodecPreferences(sorted);
  } catch {
    // Keep the browser's own order.
  }
}

type RtcSignalBody = RtcSignal extends infer S ? (S extends RtcSignal ? Omit<S, 'session'> : never) : never;
type RtcSignalDescription = Extract<RtcSignal, { description: unknown }>['description'];
type RtcSignalCandidate = NonNullable<Extract<RtcSignal, { candidate: unknown }>['candidate']>;

export const voice = new VoiceEngine();
(window as unknown as { __voice: VoiceEngine }).__voice = voice;
