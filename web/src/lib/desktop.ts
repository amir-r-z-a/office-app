/** Present when the app runs inside the Office desktop app. */
export interface OfficeDesktop {
  platform: string;
  changeServer: () => void;
  attention: () => void;
}

export const desktop: OfficeDesktop | undefined = (window as unknown as { officeDesktop?: OfficeDesktop }).officeDesktop;
