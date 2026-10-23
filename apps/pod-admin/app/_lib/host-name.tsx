/**
 * `HostName` — the ONE way pod-admin writes a domain or a pod host.
 *
 * A host is the trust anchor on every screen that shows one: the registrable
 * domain at its END is what tells `pod.antoinesrvt.synap.live` from
 * `pod.antoinesrvt.evil.com`. So it is never end-truncated (`truncate` hid
 * exactly that part), and it never breaks mid-label (`break-all` gave
 * "…synap.li" / "ve", and plain wrapping breaks at a hyphen). It wraps only
 * after a dot, in monospace, so the end is always on screen.
 *
 * One exception: a single label too long for any line (a label may be 63
 * characters) may break inside itself, or it would overflow the card.
 */

import { Fragment } from "react";

/** A label at least this long may break inside itself (see above). */
export const LONG_LABEL = 24;

export interface HostSegment {
  /** The label with its trailing dot: "pod.", "antoinesrvt.", "live". */
  text: string;
  /** Too long to keep on one line: it may break inside itself. */
  long: boolean;
}

/** The host cut after each dot. Joined, the segments are the host, unchanged. */
export function hostSegments(host: string): HostSegment[] {
  const labels = host.split(".");
  return labels.map((label, i) => {
    const text = i < labels.length - 1 ? `${label}.` : label;
    return { text, long: text.length >= LONG_LABEL };
  });
}

export function HostName({
  host,
  className = "",
}: {
  host: string;
  className?: string;
}) {
  const segments = hostSegments(host);
  return (
    <span
      translate="no"
      className={`font-mono [overflow-wrap:normal] [word-break:normal] ${className}`}
    >
      {segments.map((s, i) => (
        <Fragment key={i}>
          <span
            className={
              s.long ? "[overflow-wrap:anywhere]" : "whitespace-nowrap"
            }
          >
            {s.text}
          </span>
          {i < segments.length - 1 ? <wbr /> : null}
        </Fragment>
      ))}
    </span>
  );
}
