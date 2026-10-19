/**
 * THE one door for reading a URL:
 * which readers can read THIS link for THIS person, and `readUrl`, which runs
 * the chosen one and hands back ONE `@synap-core/types/url-read` shape.
 *
 * ── NO SECOND INDEX ─────────────────────────────────────────────────────────
 * Readers are ordinary verbs that DECLARE the URLs they read
 * (`skills.url_patterns`, projected onto each registry verb as `urlPatterns`).
 * The resolver folds the rows `listCapabilities` already returns — the caller's
 * own visibility floor — and the catalog entries `cp_catalog_cache` already
 * holds. Nothing here keeps a host table: a reader joins routing by declaring.
 *
 * ── AUTOMATIC READS ARE THE POD'S OWN ───────────────────────────────────────
 * A read nobody asked a reader for (`reader` absent: the Library's keep and
 * sweep, capture, Build's inline read, an agent's `web.read` with no reader)
 * runs the pod's BUILT-IN ladder only. An installed reader — free or billed,
 * official or from another source — reads a link only when a person taps it
 * ("Read with X") or an agent names it, and then through its own gate. A
 * reader's `urls` decide what it is OFFERED for, never where links flow by
 * themselves: approving a pack for one purpose never quietly sends it every
 * link the person keeps. Its declaration is gated at the pod too
 * (`projectUrlPatterns`: a readOnly `read_webpage` verb; a pattern broader
 * than one domain only from the official vendor).
 *
 * ── ROUTING, NEVER AUTHORIZATION ────────────────────────────────────────────
 * A verb reader runs through `executeCapability` — its own gate, its own
 * approval, its own agent posture. This module only picks WHICH verb; a deny
 * from the gate becomes an `enable` answer, never a bypass.
 *
 * ── HONEST OUTCOMES ─────────────────────────────────────────────────────────
 * A read is `ok | partial | blocked | failed`. A reader that is not usable
 * (needs enabling, connecting, installing, or the person's tap for a billed
 * read) is `blocked` with the next step and the offers that would unblock it.
 * A run that failed is `failed` with its message and failure class (a retry
 * question), never "unreadable", never an empty `ok`.
 */

import {
  normalizeUrlRead,
  type ReaderStamp,
  type UrlRead,
  type UrlReadBlockReason,
  type UrlReadFailureClass,
  type UrlReaderOffer,
  type UrlReadNextStep,
} from "@synap-core/types/url-read";
import type { FailureErrorClass } from "../../connectors/external-dispatch.js";
import { readBuiltin } from "./web-read/index.js";
import { BUILTIN_READER_ID, type RankedReader } from "./url-reader-fold.js";
import {
  resolveReaders,
  type ResolvedReaders,
  type UrlReadersContext,
} from "./url-reader-sources.js";

// The door's whole surface, from its focused modules.
export {
  BUILTIN_READER_ID,
  foldUrlReaders,
  offerIdOfStamp,
} from "./url-reader-fold.js";
export { installOffersForUrl } from "./url-reader-offers.js";
export {
  listReadersForUrl,
  readsAllSpaces,
  urlReaderLookup,
  type UrlReadersContext,
} from "./url-reader-sources.js";
export { invalidateUrlReaderCache } from "./url-reader-cache.js";
export {
  captureLinkReader,
  structurerPageContext,
  STRUCTURER_PAGE_TEXT_MAX,
  type CaptureUrlReader,
} from "./capture-link-reader.js";

// ── readUrl ─────────────────────────────────────────────────────────────────

export interface ReadUrlOptions {
  /**
   * `"builtin"` or a reader verb id from the offers. Absent = the pod's
   * built-in ladder (never an installed reader: see AUTOMATIC READS).
   */
  reader?: string;
  /**
   * May an `account`-billed reader run? Only an explicit choice (a person's
   * tap, an agent naming the verb) ever passes true; automatic reads never bill.
   */
  allowBilled: boolean;
  /**
   * A caller with a review surface (an agent turn, a person's tap). When false
   * a gate `propose` is a plain deny — no proposal row is filed.
   */
  interactive?: boolean;
  /**
   * The person's per-tap choice to download the video too. Sent to the
   * reader's verb as its `withVideo` parameter ONLY when its offer declares
   * the option (`UrlReaderOffer.options`); ignored for any other reader.
   */
  withVideo?: boolean;
}

export interface ReadUrlResult {
  read: UrlRead;
  /** The readers of this URL, live; the one that produced `read` is `current`. */
  offers: UrlReaderOffer[];
  /** A failed verb run's failure class (the retry question). */
  errorClass?: FailureErrorClass;
}

/** Test seams; production uses the real modules. */
export interface ReadUrlDeps {
  resolve?: (ctx: UrlReadersContext, url: string) => Promise<ResolvedReaders>;
  readBuiltin?: (url: string) => Promise<UrlRead>;
  execute?: (
    input: Parameters<
      typeof import("./execute-capability.js").executeCapability
    >[0]
  ) => ReturnType<typeof import("./execute-capability.js").executeCapability>;
  now?: () => Date;
}

/**
 * A failed verb run's dispatch class → the read's failure class (the retry
 * question the light read asks). Exhaustive: a new dispatch class stops the build.
 */
const READ_FAILURE_OF: Record<FailureErrorClass, UrlReadFailureClass> = {
  transient: "unavailable",
  auth: "auth",
  no_connection: "auth",
  permission: "refused",
  target_missing: "refused",
  provider: "refused",
  missing_field: "refused",
  validation: "refused",
  conflict: "refused",
  unknown: "unknown",
};

/** A failed read through the one parse door, with its class. */
function failedRead(
  sourceUrl: string,
  via: ReaderStamp,
  error: string,
  errorClass: UrlReadFailureClass
): UrlRead {
  return normalizeUrlRead(
    { status: "failed", error, errorClass },
    sourceUrl,
    via
  );
}

/**
 * A read that did not happen: nothing ran on the person's account, so the
 * stamp is never `billed` (the ONE place that says so).
 */
function blockedRead(
  sourceUrl: string,
  via: ReaderStamp,
  reason: UrlReadBlockReason,
  nextStep: UrlReadNextStep | undefined,
  detail: string
): UrlRead {
  return normalizeUrlRead(
    { status: "blocked", blocked: { reason, nextStep, detail } },
    sourceUrl,
    { ...via, billed: false }
  );
}

function verbStamp(
  r: RankedReader,
  now: Date,
  extra: Pick<ReaderStamp, "contentHash" | "correlationId">
): ReaderStamp {
  return {
    id: r.offer.readerId,
    name: r.offer.name,
    ...(r.offer.capabilityId ? { capabilityId: r.offer.capabilityId } : {}),
    ...(r.offer.verbId ? { verbId: r.offer.verbId } : {}),
    ...(extra.contentHash ? { contentHash: extra.contentHash } : {}),
    ...(extra.correlationId ? { correlationId: extra.correlationId } : {}),
    billed: r.offer.billing === "account",
    readAt: now.toISOString(),
  };
}

function withCurrent(
  ranked: readonly RankedReader[],
  readerId: string | null,
  patch?: Partial<UrlReaderOffer>
): UrlReaderOffer[] {
  return ranked.map((r) =>
    r.offer.readerId === readerId
      ? { ...r.offer, ...patch, current: true }
      : r.offer
  );
}

/**
 * Read `url` through the one door.
 *
 * No `reader`, or `"builtin"` → the pod's free built-in ladder (blocked
 * needs_reader for a link only a reader can read, with the offers that
 * would). A verb id → that verb, through `executeCapability` (its own gate;
 * `observability:"mirror"` so reads never flood recall).
 *
 * @throws only when the readers cannot be listed (see {@link listReadersForUrl}).
 */
export async function readUrl(
  ctx: UrlReadersContext,
  url: string,
  opts: ReadUrlOptions,
  deps: ReadUrlDeps = {}
): Promise<ReadUrlResult> {
  const now = (deps.now ?? (() => new Date()))();
  const sourceUrl = url.trim();
  const { ranked, contentHashByContainer } = await (
    deps.resolve ?? resolveReaders
  )(ctx, sourceUrl);
  const runBuiltin = deps.readBuiltin ?? ((u: string) => readBuiltin(u));

  const builtin = async (): Promise<ReadUrlResult> => {
    const read = await runBuiltin(sourceUrl);
    return { read, offers: withCurrent(ranked, BUILTIN_READER_ID) };
  };

  // Nobody named a reader: the pod's own ladder, never an installed one.
  if (opts.reader === undefined || opts.reader === BUILTIN_READER_ID) {
    return builtin();
  }
  const chosen = ranked.find((r) => r.offer.readerId === opts.reader);
  if (!chosen) {
    return {
      read: failedRead(
        sourceUrl,
        {
          id: opts.reader,
          name: opts.reader,
          billed: false,
          readAt: now.toISOString(),
        },
        `"${opts.reader}" does not read this link`,
        "refused"
      ),
      offers: ranked.map((r) => r.offer),
    };
  }

  const offers = ranked.map((r) => r.offer);
  const stamp = verbStamp(chosen, now, {
    contentHash: chosen.containerId
      ? contentHashByContainer.get(chosen.containerId)
      : undefined,
  });

  // Not runnable without a step only the person can take: say which.
  if (chosen.offer.state === "install") {
    return {
      read: blockedRead(
        sourceUrl,
        stamp,
        "needs_reader",
        "install_reader",
        chosen.offer.hint ?? `Install ${chosen.offer.name} to read this link.`
      ),
      offers,
    };
  }
  if (chosen.offer.state === "unavailable") {
    // No door at all: the pod cannot offer this reader's provider.
    return {
      read: blockedRead(
        sourceUrl,
        stamp,
        "needs_reader",
        undefined,
        chosen.offer.hint ??
          `${chosen.offer.name} is not available on this pod.`
      ),
      offers,
    };
  }
  if (chosen.offer.state === "connect") {
    return {
      read: blockedRead(
        sourceUrl,
        stamp,
        "needs_reader",
        "connect_reader",
        chosen.offer.hint ?? `Connect ${chosen.offer.name} to read this link.`
      ),
      offers,
    };
  }
  if (chosen.offer.billing === "account" && !opts.allowBilled) {
    return {
      read: blockedRead(
        sourceUrl,
        stamp,
        "needs_reader",
        undefined,
        `${chosen.offer.name} runs on your account, so it reads only when you choose it.`
      ),
      offers,
    };
  }

  const execute =
    deps.execute ??
    (async (input) =>
      (await import("./execute-capability.js")).executeCapability(input));
  let outcome: Awaited<ReturnType<NonNullable<ReadUrlDeps["execute"]>>>;
  try {
    outcome = await execute({
      verbId: chosen.offer.verbId ?? chosen.offer.readerId,
      parameters: {
        url: sourceUrl,
        ...(opts.withVideo && chosen.offer.options?.includes("withVideo")
          ? { withVideo: true }
          : {}),
      },
      userId: ctx.userId,
      // The verb's own space when the read saw every space (never an agent's
      // read — its rows carry no space), else the caller's lens.
      workspaceId: chosen.workspaceId ?? ctx.workspaceId,
      agentUserId: ctx.agentUserId ?? null,
      observability: "mirror",
      suppressProposal: !opts.interactive,
    });
  } catch (err) {
    return {
      read: failedRead(
        sourceUrl,
        stamp,
        `${chosen.offer.name} could not run: ${err instanceof Error ? err.message : String(err)}`,
        "unknown"
      ),
      offers: withCurrent(ranked, chosen.offer.readerId),
    };
  }

  switch (outcome.kind) {
    case "run":
      return {
        read: normalizeUrlRead(outcome.result, sourceUrl, {
          ...stamp,
          ...(outcome.correlationId
            ? { correlationId: outcome.correlationId }
            : {}),
        }),
        offers: withCurrent(ranked, chosen.offer.readerId),
      };
    case "deny": {
      const proposalId =
        outcome.enableProposal?.status === "proposed"
          ? outcome.enableProposal.proposalId
          : undefined;
      return {
        read: blockedRead(
          sourceUrl,
          stamp,
          "needs_reader",
          "enable_reader",
          outcome.enable?.hint ?? outcome.reason
        ),
        offers: ranked.map((r) =>
          r === chosen
            ? {
                ...r.offer,
                state: "enable" as const,
                ...(outcome.enable?.hint ? { hint: outcome.enable.hint } : {}),
                ...(proposalId ? { proposalId } : {}),
              }
            : r.offer
        ),
      };
    }
    case "proposed":
    case "dry-run":
      // The gate wants review before this reader runs: nothing was read.
      return {
        read: blockedRead(
          sourceUrl,
          stamp,
          "needs_reader",
          "enable_reader",
          outcome.kind === "proposed"
            ? "Waiting for review before it reads."
            : "It runs as a dry run here, so nothing was read."
        ),
        offers: ranked.map((r) =>
          r === chosen && outcome.kind === "proposed"
            ? { ...r.offer, proposalId: outcome.proposalId }
            : r.offer
        ),
      };
    case "error":
      return {
        read: failedRead(
          sourceUrl,
          stamp,
          outcome.message,
          READ_FAILURE_OF[outcome.errorClass ?? "unknown"]
        ),
        offers: withCurrent(ranked, chosen.offer.readerId),
        ...(outcome.errorClass ? { errorClass: outcome.errorClass } : {}),
      };
    case "not_found":
      return {
        read: failedRead(
          sourceUrl,
          { ...stamp, billed: false },
          outcome.message,
          "refused"
        ),
        offers,
      };
  }
}
