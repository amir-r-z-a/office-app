import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, Info, TriangleAlert } from 'lucide-react';
import { useStore } from '../lib/store';
import { Avatar } from './Avatar';

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const users = useStore((s) => s.users);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="toasts" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((t) => {
          const user = t.userId ? users[t.userId] : undefined;
          return (
            <motion.button
              key={t.id}
              layout
              className={`toast toast--${t.tone}`}
              onClick={() => dismiss(t.id)}
              initial={{ opacity: 0, y: 24, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 60, scale: 0.95, transition: { duration: 0.2 } }}
              transition={{ type: 'spring', stiffness: 460, damping: 32 }}
            >
              {user ? (
                <Avatar user={user} size={32} />
              ) : (
                <span className="toast__icon">
                  {t.tone === 'success' ? <CheckCircle2 size={18} /> : t.tone === 'error' ? <TriangleAlert size={18} /> : <Info size={18} />}
                </span>
              )}
              <span className="toast__text">
                <strong>{t.title}</strong>
                {t.body && <span>{t.body}</span>}
              </span>
            </motion.button>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
