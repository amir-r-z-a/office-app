import type { Status, User } from '@office/shared';

const STATUS_LABEL: Record<Status, string> = {
  available: 'Available',
  busy: 'Busy',
  away: 'Away',
  dnd: 'Do not disturb',
};

export function statusLabel(status: Status) {
  return STATUS_LABEL[status];
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

interface AvatarProps {
  user: Pick<User, 'displayName' | 'hue' | 'emoji' | 'avatarUrl' | 'status'>;
  size?: number;
  /** Draw the status dot; offline people get a hollow grey one. */
  showStatus?: boolean;
  online?: boolean;
  ring?: boolean;
  className?: string;
}

export function Avatar({ user, size = 36, showStatus = false, online = true, ring = false, className = '' }: AvatarProps) {
  const dot = Math.max(9, Math.round(size * 0.3));
  return (
    <span
      className={`avatar ${ring ? 'avatar--ring' : ''} ${online ? '' : 'avatar--offline'} ${className}`}
      data-hue={user.hue}
      style={{ width: size, height: size, fontSize: size * (user.emoji && !user.avatarUrl ? 0.52 : 0.38) }}
      title={user.displayName}
    >
      {user.avatarUrl ? (
        <img src={user.avatarUrl} alt="" draggable={false} />
      ) : (
        <span className="avatar__face">{user.emoji || initials(user.displayName)}</span>
      )}
      {showStatus && (
        <span
          className={`status-dot status-dot--${online ? user.status : 'offline'}`}
          style={{ width: dot, height: dot }}
          aria-label={online ? STATUS_LABEL[user.status] : 'Offline'}
        />
      )}
    </span>
  );
}

export function StatusDot({ status, size = 10 }: { status: Status | 'offline'; size?: number }) {
  return <span className={`status-dot status-dot--${status} status-dot--inline`} style={{ width: size, height: size }} />;
}
