import { motion } from 'framer-motion';
import { ArrowRight, Building2, Eye, EyeOff, Moon, RefreshCw, Sparkles, Sun, WifiOff } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { useTheme } from '../lib/theme';
import { Button, Field, IconButton } from '../components/ui';

/** Drifting rooms and people behind the sign-in card: a taste of the office. */
function Backdrop() {
  const tiles = [
    { x: '6%', y: '12%', w: 220, h: 150, hue: 'violet', people: ['🎧', 'AK'], d: 0 },
    { x: '72%', y: '8%', w: 260, h: 170, hue: 'sky', people: ['SR', '☕', 'MJ'], d: 1.2 },
    { x: '10%', y: '64%', w: 240, h: 160, hue: 'amber', people: ['🎸'], d: 0.6 },
    { x: '76%', y: '62%', w: 200, h: 150, hue: 'mint', people: ['LN', 'TB'], d: 1.8 },
    { x: '40%', y: '82%', w: 180, h: 120, hue: 'coral', people: [], d: 2.4 },
  ];
  return (
    <div className="auth__backdrop" aria-hidden>
      <div className="auth__blob auth__blob--1" />
      <div className="auth__blob auth__blob--2" />
      <div className="auth__blob auth__blob--3" />
      {tiles.map((t, i) => (
        <motion.div
          key={i}
          className="auth__tile"
          data-hue={t.hue}
          style={{ left: t.x, top: t.y, width: t.w, height: t.h }}
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: [0, -14, 0] }}
          transition={{ opacity: { duration: 1, delay: t.d * 0.3 }, y: { duration: 7 + i, repeat: Infinity, ease: 'easeInOut', delay: t.d } }}
        >
          <span className="auth__tile-bar" />
          <div className="auth__tile-people">
            {t.people.map((p, j) => (
              <motion.span
                key={j}
                className="auth__tile-person"
                data-hue={['violet', 'coral', 'mint', 'sky', 'rose'][(i + j) % 5]}
                animate={{ y: [0, -4, 0] }}
                transition={{ duration: 2.4, repeat: Infinity, delay: j * 0.4 + i * 0.2, ease: 'easeInOut' }}
              >
                {p}
              </motion.span>
            ))}
          </div>
        </motion.div>
      ))}
    </div>
  );
}

function AuthLayout({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  const { theme, toggle } = useTheme();
  return (
    <div className="auth">
      <Backdrop />
      <IconButton label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} className="auth__theme" onClick={toggle}>
        {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
      </IconButton>
      <motion.div
        className={`auth__card ${wide ? 'auth__card--wide' : ''}`}
        initial={{ opacity: 0, y: 28, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 260, damping: 26 }}
      >
        <div className="auth__logo">
          <img src="/icon.svg" alt="" width={44} height={44} />
        </div>
        {children}
      </motion.div>
    </div>
  );
}

function PasswordField(props: { label: string; value: string; onChange: (v: string) => void; autoComplete: string; hint?: string }) {
  const [show, setShow] = useState(false);
  return (
    <Field
      label={props.label}
      type={show ? 'text' : 'password'}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      autoComplete={props.autoComplete}
      hint={props.hint}
      trailing={
        <button type="button" className="field__trailing" onClick={() => setShow(!show)} aria-label={show ? 'Hide password' : 'Show password'}>
          {show ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      }
    />
  );
}

export function Login() {
  const officeName = useStore((s) => s.officeName);
  const signedIn = useStore((s) => s.signedIn);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { token, user } = await api.login(username, password);
      signedIn(token, user);
    } catch (err) {
      setError((err as Error).message);
      setShake((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <h1 className="auth__title">Welcome back</h1>
      <p className="auth__subtitle">
        Sign in to <strong>{officeName || 'the office'}</strong>
      </p>
      <motion.form className="auth__form" onSubmit={submit} animate={shake ? { x: [0, -10, 9, -6, 4, 0] } : {}} transition={{ duration: 0.45 }} key={shake}>
        <Field label="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus />
        <PasswordField label="Password" value={password} onChange={setPassword} autoComplete="current-password" />
        {error && (
          <motion.p className="form-error" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}>
            {error}
          </motion.p>
        )}
        <Button variant="gradient" size="lg" block loading={busy} disabled={!username || !password} icon={<ArrowRight size={18} />}>
          Enter the office
        </Button>
      </motion.form>
      <p className="auth__foot">No account? Ask your office admin to add you.</p>
    </AuthLayout>
  );
}

export function Setup() {
  const signedIn = useStore((s) => s.signedIn);
  const [officeName, setOfficeName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [sampleLayout, setSampleLayout] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { token, user } = await api.setup({ officeName, displayName, username, password, sampleLayout });
      useStore.setState({ officeName });
      signedIn(token, user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout wide>
      <span className="auth__eyebrow">
        <Sparkles size={14} /> First-time setup
      </span>
      <h1 className="auth__title">Let’s build your office</h1>
      <p className="auth__subtitle">You’ll be the admin. You can add your coworkers and rooms right after.</p>
      <form className="auth__form" onSubmit={submit}>
        <Field label="Office name" placeholder="e.g. Studio North" value={officeName} onChange={(e) => setOfficeName(e.target.value)} autoFocus />
        <div className="form-row">
          <Field label="Your name" placeholder="Amir Ahmadi" value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="name" />
          <Field
            label="Username"
            placeholder="amir"
            value={username}
            onChange={(e) => setUsername(e.target.value.replace(/\s/g, ''))}
            autoComplete="username"
          />
        </div>
        <PasswordField label="Password" value={password} onChange={setPassword} autoComplete="new-password" hint="At least 4 characters." />
        <label className={`choice ${sampleLayout ? 'is-checked' : ''}`}>
          <input type="checkbox" checked={sampleLayout} onChange={(e) => setSampleLayout(e.target.checked)} />
          <span className="choice__icon">
            <Building2 size={18} />
          </span>
          <span className="choice__text">
            <strong>Start with a sample floor</strong>
            <span>Your office, a lounge and two meeting rooms. You can rearrange everything.</span>
          </span>
          <span className="choice__check" />
        </label>
        {error && <p className="form-error">{error}</p>}
        <Button
          variant="gradient"
          size="lg"
          block
          loading={busy}
          disabled={!officeName || !displayName || username.length < 2 || password.length < 4}
          icon={<ArrowRight size={18} />}
        >
          Open the office
        </Button>
      </form>
    </AuthLayout>
  );
}

export function Unreachable() {
  const boot = useStore((s) => s.boot);
  return (
    <AuthLayout>
      <div className="auth__state-icon">
        <WifiOff size={26} />
      </div>
      <h1 className="auth__title">Can’t reach the office</h1>
      <p className="auth__subtitle">Make sure you’re on the office Wi-Fi and the office server is running.</p>
      <Button variant="primary" size="lg" block icon={<RefreshCw size={17} />} onClick={() => void boot()}>
        Try again
      </Button>
    </AuthLayout>
  );
}
