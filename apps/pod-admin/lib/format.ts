/**
 * Formatting helpers shared by every pod-admin surface.
 *
 * One copy, so "3d ago" reads the same on Overview, Audit and Trust. Callers
 * that render a missing date differently pass `empty` ("never" for a key that
 * was never used, "—" for a column with no value).
 */

export function formatRelative(
  date: Date | string | null | undefined,
  { empty = "—" }: { empty?: string } = {}
): string {
  if (!date) return empty;
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return empty;
  const diff = Date.now() - d.getTime();
  // Clock skew between pod and browser makes a fresh row land a few seconds
  // "in the future"; either side of now within a minute is just now.
  if (Math.abs(diff) < 60_000) return "just now";
  if (diff < 0) {
    // Future: expiresAt and the like.
    const minutes = Math.floor(-diff / 60_000);
    if (minutes < 60) return `in ${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `in ${hours}h`;
    return `in ${Math.floor(hours / 24)}d`;
  }
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function formatTimestamp(
  date: Date | string | null | undefined
): string {
  if (!date) return "—";
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function shortId(id: string | null | undefined, head = 6, tail = 4) {
  if (!id) return "—";
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

export function humanizeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
}

export function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return `${s.slice(0, half)}…${s.slice(s.length - half)}`;
}

/**
 * Text as one line for a row or a sentence: whitespace folded to single
 * spaces, cut at `max` characters with an ellipsis.
 */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a canonical uuid — the shape every pod object id has. */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
