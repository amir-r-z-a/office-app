import type { Floor, Room, User } from '@office/shared';

const TOKEN_KEY = 'office.token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private mode: the session simply won't be remembered.
  }
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const isBlob = body instanceof Blob;
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': isBlob ? body.type : 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : isBlob ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Can’t reach the office server. Check that you’re on the office Wi-Fi.', 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

type Auth = { token: string; user: User };
type RoomInput = Omit<Room, 'id'>;

export const api = {
  setupState: () => request<{ needsSetup: boolean; floorName: string }>('GET', '/api/setup'),
  setup: (body: { username: string; displayName: string; password: string; officeName: string; sampleLayout: boolean }) =>
    request<Auth>('POST', '/api/setup', body),
  login: (username: string, password: string) => request<Auth>('POST', '/api/login', { username, password }),
  me: () => request<User>('GET', '/api/me'),
  updateMe: (body: Partial<Pick<User, 'displayName' | 'title' | 'hue' | 'emoji'>> & { currentPassword?: string; newPassword?: string }) =>
    request<User>('PATCH', '/api/me', body),
  uploadAvatar: (image: Blob) => request<User>('PUT', '/api/me/avatar', image),
  removeAvatar: () => request<User>('DELETE', '/api/me/avatar'),
  createUser: (body: { username: string; displayName: string; password: string; role: User['role']; title: string; hue: User['hue'] }) =>
    request<User>('POST', '/api/users', body),
  updateUser: (id: string, body: Partial<Pick<User, 'username' | 'displayName' | 'role' | 'title' | 'hue'>> & { password?: string }) =>
    request<User>('PATCH', `/api/users/${id}`, body),
  deleteUser: (id: string) => request<{ ok: true }>('DELETE', `/api/users/${id}`),
  createRoom: (body: RoomInput) => request<Room>('POST', '/api/rooms', body),
  updateRoom: (id: string, body: Partial<RoomInput>) => request<Room>('PATCH', `/api/rooms/${id}`, body),
  deleteRoom: (id: string) => request<{ ok: true }>('DELETE', `/api/rooms/${id}`),
  updateFloor: (floor: Floor) => request<Floor>('PUT', '/api/floor', floor),
};
