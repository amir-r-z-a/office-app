import { create } from 'zustand';

export type UpdateStatus = 'idle' | 'checking' | 'none' | 'downloading' | 'ready' | 'error' | 'unsupported';

export interface UpdateState {
  status: UpdateStatus;
  current: string;
  version?: string;
  progress?: number;
  error?: string;
  manualUrl?: string;
}

export interface CaptureSource {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  thumbnail: string;
  icon: string | null;
}

/** Present when the app runs inside the Office desktop app. */
export interface OfficeDesktop {
  platform: string;
  changeServer: () => void;
  attention: () => void;
  /** Missing in desktop apps older than 0.2.0. */
  capture?: {
    sources: (opts?: { width?: number; height?: number }) => Promise<CaptureSource[]>;
    choose: (choice: { sourceId: string | null; audio: 'none' | 'system' | 'player' }) => void;
  };
  player?: {
    open: (url: string) => Promise<boolean>;
    close: () => void;
    onClosed: (fn: () => void) => () => void;
  };
  /** Missing in desktop apps older than 0.1.0. */
  updates?: {
    get: () => Promise<UpdateState>;
    check: () => Promise<void>;
    install: () => void;
    openDownloadPage: () => void;
    onChange: (fn: (state: UpdateState) => void) => () => void;
  };
}

export const desktop: OfficeDesktop | undefined = (window as unknown as { officeDesktop?: OfficeDesktop }).officeDesktop;

/** The desktop app's update state, or null in a browser. */
export const useUpdate = create<UpdateState | null>(() => null);

if (desktop?.updates) {
  void desktop.updates.get().then((s) => useUpdate.setState(s, true));
  desktop.updates.onChange((s) => useUpdate.setState(s, true));
}
