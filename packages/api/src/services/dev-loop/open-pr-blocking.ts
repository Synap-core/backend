/**
 * sessionIdsBlockingOpenPr — which sessions hold an OPEN pull request.
 *
 * What a session asks the person is blocking that PR (the plan 2c8fca91 §4
 * "Also"), so the needs-you rule never folds it by age and the order puts it
 * first (`NeedsYouSessionFacts.blocksOpenPr`). No new store: the session's
 * open PR outcomes (`workUnitsSection`) joined to the recorded PR facts
 * (`readPullRequestStates`), the very read the waiting-on uses
 * (`readOpenWorkUnits`). A PR with no recorded fact is never guessed open.
 *
 * A failed read THROWS: "no session holds an open PR" and "could not tell"
 * are different facts. Each caller names the failure the way its read
 * already does (the needs-you halves: a named `failures` entry, so the
 * person's tray says it could not read, never a calm unblocked list).
 */

import type { WaitingOnReader } from "../status/status-facts.js";

export async function sessionIdsBlockingOpenPr(
  reader: WaitingOnReader,
  sessionIds: readonly string[]
): Promise<Set<string>> {
  const ids = [...new Set(sessionIds)];
  if (ids.length === 0) return new Set();
  const { readOpenWorkUnits } = await import("../status/status-facts.js");
  const bySession = await readOpenWorkUnits(reader, ids);
  const out = new Set<string>();
  for (const [sessionId, units] of bySession) {
    if (units.some((u) => u.facts.state === "open")) out.add(sessionId);
  }
  return out;
}

/** Which of `sessionIds` hold an open PR. Throws when the read fails. */
export type OpenPrBlockingRead = (
  sessionIds: readonly string[]
) => Promise<Set<string>>;

/** One consumer of a {@link sharedOpenPrRead}: it asks once, or leaves. */
export interface OpenPrConsumer {
  read: OpenPrBlockingRead;
  /** This consumer will not ask (it ended, failed or had nothing to ask). */
  leave(): void;
}

/** The one read once it started: the ids it covers, and its answer. */
interface SharedRead {
  ids: Set<string>;
  result: Promise<Set<string>>;
}

/**
 * ONE open-PR read for the consumers of ONE needs-you read (the owed half,
 * the decisions half's classification, the clusters' order). Each consumer
 * is registered up front (`consumer()`), then either asks or leaves; the read
 * runs ONCE, when every registered consumer has done one or the other, over
 * every id asked, and answers each asker. A later ask (`read`) is answered
 * from that read for the ids it covered and reads only the rest.
 *
 * Request-scoped and explicit: the reader that builds it hands it down, and
 * nothing outlives the request. A failure of the one read reaches every
 * asker.
 */
export function sharedOpenPrRead(reader: WaitingOnReader): {
  consumer(): OpenPrConsumer;
  read: OpenPrBlockingRead;
} {
  let pending = 0;
  const asked = new Set<string>();
  let started: SharedRead | null = null;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const startIfReady = () => {
    if (started || pending > 0) return;
    started = {
      ids: new Set(asked),
      result: sessionIdsBlockingOpenPr(reader, [...asked]),
    };
    release();
  };
  const read: OpenPrBlockingRead = async (sessionIds) => {
    if (!started) {
      for (const id of sessionIds) asked.add(id);
      startIfReady();
      await gate;
    }
    const one = started!;
    const rest = sessionIds.filter((id) => !one.ids.has(id));
    const [shared, more] = await Promise.all([
      one.result,
      rest.length > 0
        ? sessionIdsBlockingOpenPr(reader, rest)
        : Promise.resolve(new Set<string>()),
    ]);
    return new Set(sessionIds.filter((id) => shared.has(id) || more.has(id)));
  };
  return {
    consumer() {
      pending += 1;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        pending -= 1;
      };
      return {
        read: (sessionIds) => {
          if (!started) for (const id of sessionIds) asked.add(id);
          settle();
          return read(sessionIds);
        },
        leave: () => {
          settle();
          startIfReady();
        },
      };
    },
    read,
  };
}
