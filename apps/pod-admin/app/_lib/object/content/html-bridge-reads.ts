/**
 * Each read a running HTML page may ask for (`CELL_BRIDGE_READ_OPS`,
 * `@synap-core/types/cell-bridge`) → the console's own tRPC procedure, called
 * with the VIEWER'S session. The pod floors every answer to what this person
 * may see; nothing here widens it.
 *
 * The same procedures the desktop host reaches through Hub REST
 * (`/api/hub/entities`, `/lifecycle/*`, `/attention/*`, `/focus-sessions` —
 * each a thin caller of these): one read per op, never a second predicate.
 *
 * The LENS is the host's: `workspaceId` is the page's own space, stamped
 * here; the page's params never carry it (`pickBridgeParams` dropped it).
 * With no space (a personal page) the read is the viewer's whole floor.
 * Values the server validates (enums, ids) are passed through and refused
 * there — a refusal reaches the page as an error, never as an empty answer.
 */

import {
  narrowHomeToSpace,
  type CellBridgeParamValue,
  type CellBridgeReadOp,
} from "@synap-core/types/cell-bridge";
import type { trpc } from "../../../../lib/trpc";

/** The console's vanilla tRPC client (`trpc.useUtils().client`). */
export type BridgeClient = ReturnType<typeof trpc.useUtils>["client"];

/** The lens the host stamps on every read. */
export interface BridgeLens {
  workspaceId: string | null;
}

type Params = Record<string, CellBridgeParamValue>;
type InputOf<F extends (...args: never[]) => unknown> = Exclude<
  Parameters<F>[0],
  void | undefined
>;

const str = (v: CellBridgeParamValue | undefined): string | undefined =>
  typeof v === "string" ? v : undefined;
const bool = (v: CellBridgeParamValue | undefined): boolean | undefined =>
  typeof v === "boolean" ? v : undefined;
/** An integer in [min, max], or undefined (the procedure's own default). */
function int(
  v: CellBridgeParamValue | undefined,
  min: number,
  max: number
): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return Math.min(max, Math.max(min, Math.trunc(v)));
}
/** Drops undefined keys, so a procedure's own default applies. */
function defined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(
    Object.entries(input).filter(([, v]) => v !== undefined)
  ) as T;
}
function required(op: string, name: string, v: string | undefined): string {
  if (!v) throw new Error(`"${op}" needs ${name}.`);
  return v;
}

export async function readForPage(
  client: BridgeClient,
  op: CellBridgeReadOp,
  p: Params,
  lens: BridgeLens
): Promise<unknown> {
  const ws = lens.workspaceId ?? undefined;
  switch (op) {
    case "entities.list":
      return client.entities.list.query(
        defined({
          profileSlug: str(p.profileSlug),
          facetSlug: str(p.facetSlug),
          includeDescendants: bool(p.includeDescendants),
          limit: int(p.limit, 1, 100) ?? 50,
          offset: int(p.offset, 0, 100_000) ?? 0,
          workspaceId: ws,
        })
      );
    case "entities.get":
      return client.entities.get.query({
        id: required(op, "an id", str(p.id)),
      });
    case "views.list":
      return client.views.list.query(
        defined({
          type: str(p.type) as InputOf<typeof client.views.list.query>["type"],
          profileSlug: str(p.profileSlug),
          limit: int(p.limit, 1, 100) ?? 50,
          offset: int(p.offset, 0, 100_000) ?? 0,
          workspaceId: ws,
        })
      );
    case "profiles.list":
      // The pod reads its space from the header for this one; the console
      // sends it per call (`providers.tsx` split link).
      return client.profiles.list.query(
        defined({ creatableOnly: bool(p.creatableOnly) }),
        ws ? { context: { workspaceId: ws } } : undefined
      );
    case "lifecycle.board": {
      const days = int(p.windowDays, 1, 366);
      return client.lifecycle.board.query(
        defined({
          profileSlug: required(op, "a profileSlug", str(p.profileSlug)),
          trackId: str(p.trackId),
          window: days ? { days } : undefined,
          firstN: int(p.firstN, 0, 50),
          column: str(p.column),
          cursor: str(p.cursor),
          limit: int(p.limit, 1, 100),
          workedBy: bool(p.workedBy),
          workspaceId: ws,
        })
      );
    }
    case "lifecycle.throughput": {
      const bucket = str(p.bucket);
      const count = int(p.count, 1, 366);
      return client.lifecycle.throughput.query(
        defined({
          profileSlug: required(op, "a profileSlug", str(p.profileSlug)),
          trackId: str(p.trackId),
          period:
            bucket || count
              ? {
                  // The server validates it (day | week | month).
                  bucket: (bucket ?? "week") as "day" | "week" | "month",
                  count: count ?? 12,
                }
              : undefined,
          workspaceId: ws,
        })
      );
    }
    case "attention.needsYou":
      return client.signals.list.query(
        defined({
          lens: "needs-you" as const,
          profileSlug: required(op, "a profileSlug", str(p.profileSlug)),
          trackId: str(p.trackId),
          limit: int(p.limit, 1, 100),
          workspaceId: ws,
        })
      );
    case "attention.count":
      return client.signals.count.query(
        defined({
          profileSlug: required(op, "a profileSlug", str(p.profileSlug)),
          trackId: str(p.trackId),
          workspaceId: ws,
        })
      );
    case "sessions.list": {
      type SessionsInput = InputOf<typeof client.focusSessions.list.query>;
      const profileSlug = str(p.profileSlug);
      const entityId = str(p.entityId);
      return client.focusSessions.list.query(
        defined({
          subject: profileSlug
            ? { profileSlug }
            : entityId
              ? { entityIds: [entityId] }
              : undefined,
          status: str(p.status) as SessionsInput["status"],
          kind: (str(p.kind) ?? "work") as SessionsInput["kind"],
          limit: int(p.limit, 1, 50) ?? 20,
          workspaceId: ws,
        }) as SessionsInput
      );
    }
    case "lifecycle.home":
      // Lists every space the viewer sees: narrowed to the page's own.
      return narrowHomeToSpace(
        await client.lifecycle.home.query({}),
        lens.workspaceId
      );
    case "lifecycle.moving":
      return client.lifecycle.moving.query(
        defined({ limit: int(p.limit, 1, 100) ?? 30, workspaceId: ws })
      );
    case "documents.get":
      return client.documents.get.query({
        documentId: required(op, "a documentId", str(p.documentId)),
        format: str(p.format) === "readable" ? "readable" : "raw",
      });
  }
}
