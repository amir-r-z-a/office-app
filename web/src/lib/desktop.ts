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

/** Present when the app runs inside the Office desktop app. */
export interface OfficeDesktop {
  platform: string;
  changeServer: () => void;
  attention: () => void;
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
