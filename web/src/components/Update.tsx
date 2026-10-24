import { AnimatePresence, motion } from 'framer-motion';
import { ArrowDownToLine, RotateCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { desktop, useUpdate } from '../lib/desktop';
import { useStore } from '../lib/store';
import { Button, Popover } from './ui';

/** In the sidebar: a progress ring while an update downloads, then a glowing "restart" button. */
export function UpdateButton() {
  const update = useUpdate();
  const [open, setOpen] = useState(false);
  const announced = useRef<string | null>(null);

  useEffect(() => {
    if (update?.status === 'ready' && update.version && announced.current !== update.version) {
      announced.current = update.version;
      useStore.getState().toast({ tone: 'success', title: `Office ${update.version} is ready`, body: 'Restart the app whenever it suits you.' });
    }
  }, [update?.status, update?.version]);

  const show = update?.status === 'downloading' || update?.status === 'ready';
  const r = 19;
  const c = 2 * Math.PI * r;
  return (
    <AnimatePresence>
      {show && update && (
        <motion.div className="update" initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.5 }} transition={{ type: 'spring', stiffness: 420, damping: 24 }}>
          <button
            className={`update__btn ${update.status === 'ready' ? 'is-ready' : ''}`}
            onClick={() => update.status === 'ready' && setOpen(!open)}
            title={update.status === 'ready' ? `Restart to update to ${update.version}` : `Downloading update… ${Math.round((update.progress ?? 0) * 100)}%`}
            aria-label={update.status === 'ready' ? 'Update ready' : 'Downloading update'}
          >
            {update.status === 'downloading' && (
              <svg viewBox="0 0 44 44" className="update__ring">
                <circle cx="22" cy="22" r={r} className="update__track" />
                <circle cx="22" cy="22" r={r} className="update__bar" strokeDasharray={c} strokeDashoffset={c * (1 - (update.progress ?? 0))} />
              </svg>
            )}
            <ArrowDownToLine size={18} />
          </button>
          <Popover open={open} onClose={() => setOpen(false)} align="start" className="update__popover">
            <strong>Office {update.version} is ready</strong>
            <p>Office closes, updates and opens again. It only takes a few seconds.</p>
            <div className="update__actions">
              <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                Later
              </Button>
              <Button size="sm" variant="gradient" icon={<RotateCw size={14} />} onClick={() => desktop?.updates?.install()}>
                Restart now
              </Button>
            </div>
          </Popover>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** In the profile menu: the app version and a manual check. */
export function UpdateMenuItem({ onDone }: { onDone: () => void }) {
  const update = useUpdate();
  if (!update) return null;
  const label =
    update.status === 'checking'
      ? 'Checking for updates…'
      : update.status === 'downloading'
        ? `Downloading ${update.version}… ${Math.round((update.progress ?? 0) * 100)}%`
        : update.status === 'ready'
          ? `Restart to update to ${update.version}`
          : update.status === 'none'
            ? 'You’re up to date'
            : update.status === 'error'
              ? update.error ?? 'Update failed'
              : 'Check for updates';
  return (
    <button
      className={`menu-item menu-item--update ${update.status === 'error' ? 'is-error' : ''}`}
      disabled={update.status === 'checking' || update.status === 'downloading' || update.status === 'unsupported'}
      onClick={() => {
        if (update.status === 'ready') desktop?.updates?.install();
        else if (update.status === 'error' && update.manualUrl) desktop?.updates?.openDownloadPage();
        else void desktop?.updates?.check();
        if (update.status === 'ready') onDone();
      }}
    >
      <RotateCw size={16} className={update.status === 'checking' ? 'spin' : ''} />
      <span>
        <strong>{label}</strong>
        <small>
          Office {update.current}
          {update.status === 'error' && update.manualUrl ? ' · click to download' : ''}
          {update.status === 'unsupported' ? ' · development build' : ''}
        </small>
      </span>
    </button>
  );
}
