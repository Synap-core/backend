/**
 * Date-range helpers for the Audit tab.
 */

/**
 * `from` and `to` for the activity log's default date range: 30 days. The log
 * is only ever narrowed by it client-side, so a wide default costs nothing.
 */
export function defaultDateRange(): { fromDate: string; toDate: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30);
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
