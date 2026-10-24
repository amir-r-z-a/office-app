import { create } from 'zustand';

export type ThemePref = 'light' | 'dark' | 'system';
const KEY = 'office.theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

function resolve(pref: ThemePref): 'light' | 'dark' {
  return pref === 'system' ? (media.matches ? 'dark' : 'light') : pref;
}

function apply(theme: 'light' | 'dark', animate: boolean) {
  const root = document.documentElement;
  if (animate) {
    // Cross-fade every color for one beat, then drop the transition so it can't slow anything else.
    root.classList.add('theme-fade');
    window.setTimeout(() => root.classList.remove('theme-fade'), 450);
  }
  root.dataset.theme = theme;
}

export const useTheme = create<{ pref: ThemePref; theme: 'light' | 'dark'; setPref: (p: ThemePref) => void; toggle: () => void }>(
  (set, get) => ({
    pref: readPref(),
    theme: resolve(readPref()),
    setPref: (pref) => {
      try {
        if (pref === 'system') localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, pref);
      } catch {
        // Not remembered, still applied.
      }
      const theme = resolve(pref);
      apply(theme, true);
      set({ pref, theme });
    },
    toggle: () => get().setPref(get().theme === 'dark' ? 'light' : 'dark'),
  }),
);

apply(useTheme.getState().theme, false);
media.addEventListener('change', () => {
  const { pref, setPref } = useTheme.getState();
  if (pref === 'system') setPref('system');
});
