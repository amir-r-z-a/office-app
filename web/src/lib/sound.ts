// Small synthesized sounds, so the app needs no audio files and works offline.

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(ac: AudioContext, freq: number, start: number, length: number, gain = 0.18) {
  const osc = ac.createOscillator();
  const env = ac.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  env.gain.setValueAtTime(0, start);
  env.gain.linearRampToValueAtTime(gain, start + 0.015);
  env.gain.exponentialRampToValueAtTime(0.0001, start + length);
  // A quiet octave above gives the bell its shimmer.
  const over = ac.createOscillator();
  const overEnv = ac.createGain();
  over.frequency.value = freq * 2.01;
  overEnv.gain.setValueAtTime(0, start);
  overEnv.gain.linearRampToValueAtTime(gain * 0.25, start + 0.01);
  overEnv.gain.exponentialRampToValueAtTime(0.0001, start + length * 0.6);
  osc.connect(env).connect(ac.destination);
  over.connect(overEnv).connect(ac.destination);
  osc.start(start);
  over.start(start);
  osc.stop(start + length);
  over.stop(start + length);
}

/** Ding-dong: someone is at your door. */
export function playDoorbell() {
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime + 0.02;
  tone(ac, 659.25, t, 1.1);
  tone(ac, 523.25, t + 0.42, 1.4);
}

/** A soft pop for arrivals and accepted knocks. */
export function playPop() {
  const ac = audio();
  if (!ac) return;
  tone(ac, 880, ac.currentTime + 0.01, 0.25, 0.08);
}

/** A falling two-note "no". */
export function playDecline() {
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime + 0.01;
  tone(ac, 392, t, 0.3, 0.08);
  tone(ac, 311, t + 0.14, 0.4, 0.08);
}
