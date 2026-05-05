/**
 * Shared formatting helpers for the Audit tab.
 */

export function formatRelative(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const d = date instanceof Date ? date : new Date(date);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return "just now";
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

/**
 * `from` and `to` for "last 7 days" — used as the default date range.
 */
export function defaultDateRange(): { fromDate: string; toDate: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 7);
  return {
    fromDate: from.toISOString(),
    toDate: to.toISOString(),
  };
}

export function toLocalDateTimeInput(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  // toISOString() returns Z; the <input type="datetime-local"> format is
  // YYYY-MM-DDThh:mm in local time, so we slice off the offset.
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60_000);
  return local.toISOString().slice(0, 16);
}

export function fromLocalDateTimeInput(value: string): string | undefined {
  if (!value) return undefined;
  // The value from <input type="datetime-local"> is local; new Date(value)
  // interprets it as local time correctly.
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}
