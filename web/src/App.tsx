import { AnimatePresence, MotionConfig, motion } from 'framer-motion';
import { useEffect } from 'react';
import { useStore } from './lib/store';
import { Login, Setup, Unreachable } from './screens/Auth';
import { Shell } from './screens/Shell';
import { Toasts } from './components/Toasts';
import './lib/theme';
import { voice } from './lib/voice';

export function App() {
  const phase = useStore((s) => s.phase);
  const boot = useStore((s) => s.boot);
  useEffect(() => void boot(), [boot]);
  useEffect(() => voice.start(), []);

  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence mode="wait">
        <motion.div
          key={phase === 'ready' ? 'app' : phase}
          className="screen"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.18 } }}
        >
          {phase === 'loading' ? (
            <Splash />
          ) : phase === 'unreachable' ? (
            <Unreachable />
          ) : phase === 'setup' ? (
            <Setup />
          ) : phase === 'login' ? (
            <Login />
          ) : (
            <Shell />
          )}
        </motion.div>
      </AnimatePresence>
      <Toasts />
    </MotionConfig>
  );
}

function Splash() {
  return (
    <div className="splash">
      <motion.img
        src="/icon.svg"
        alt=""
        width={64}
        height={64}
        animate={{ scale: [1, 1.08, 1], rotate: [0, 4, 0] }}
        transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
      />
    </div>
  );
}
