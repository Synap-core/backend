/**
 * What a proposal still NEEDS FROM YOU before it can apply (finding
 * 91a3bfd3, plan d717d6ac addendum B): the pod's setup projection
 * (`proposals.get` `setup`, `proposals.repairOptions` `setup` with the
 * person's own vault secrets), shaped into the hand-over rows the review
 * draws, and the entry each row sends to `proposals.repair` `setup`.
 *
 * PURE. The pod decides everything here: which rows block (`satisfied`,
 * `blocking`), how to get a value (`obtain`, from the manifest), what a
 * connection block asks (`nextAction`), and the write (vault first, refs
 * only, `repair-setup.ts`). The shapes are the generated API types
 * (`app/_lib/request/api.ts`). A key's value is held only in the field until
 * it is sent; nothing here keeps it.
 */
import { humanizeToken } from "@synap-core/types/vocabulary";
import type {
  ProposalSetup,
  ProposalSetupParam,
  SetupRepairEntry,
} from "../../_lib/request/api";

/**
 * What keeps Approve waiting (B5): a row to fill, a connection to make, or a
 * need nobody can tell. null = nothing holds it.
 */
export type SetupBlock =
  | { kind: "fill"; name: string }
  | { kind: "connect"; hint: string; url: string | null }
  | { kind: "unreadable" }
  | null;

export interface SetupRowView {
  name: string;
  label: string;
  required: boolean;
  secret: boolean;
  description: string | null;
  /** How to get it: the page it starts on (https) and the steps; null = the manifest says nothing. */
  obtain: { url: string | null; steps: string[] } | null;
  /** The ref it points at no longer resolves: say so, never pre-fill. */
  unresolved: boolean;
}

function labelOf(p: Pick<ProposalSetupParam, "name" | "label">): string {
  return p.label?.trim() || humanizeToken(p.name);
}

/** A link the console may open as is: https, or one of its own routes. */
function safeHref(url: string | undefined): string | null {
  if (!url) return null;
  return url.startsWith("https://") || /^\/(?!\/)/.test(url) ? url : null;
}

/**
 * What keeps Approve waiting (B5): the first REQUIRED row still empty
 * ("Fill in X first"), else a required connection that is not connected
 * (the pod's `nextAction`), else a need the pod cannot tell; null = nothing.
 */
export function proposalSetupBlock(
  setup: ProposalSetup | null | undefined
): SetupBlock {
  if (!setup?.blocking) return null;
  if (setup.unreadable) return { kind: "unreadable" };
  const row = setup.params.find((p) => p.required && !p.satisfied);
  if (row) return { kind: "fill", name: labelOf(row) };
  const c = setup.connection;
  if (c?.required && c.state !== "connected") {
    return {
      kind: "connect",
      hint:
        setup.nextAction?.hint?.trim() ||
        humanizeToken(c.provider ?? "connection"),
      url: safeHref(setup.nextAction?.url),
    };
  }
  return { kind: "unreadable" };
}

/** The rows the person still has to hand over, required first. */
export function setupRows(
  setup: Pick<ProposalSetup, "params"> | null | undefined
): SetupRowView[] {
  if (!setup) return [];
  return setup.params
    .filter((p) => !p.satisfied)
    .sort((a, b) => Number(b.required) - Number(a.required))
    .map((p) => {
      const url = p.obtain?.url?.startsWith("https://") ? p.obtain.url : null;
      const steps = (p.obtain?.steps ?? []).filter((s) => s.trim());
      return {
        name: p.name,
        label: labelOf(p),
        required: p.required,
        secret: p.secret,
        description: p.description?.trim() || null,
        obtain: url || steps.length > 0 ? { url, steps } : null,
        unresolved: p.refUnresolved === true,
      };
    });
}

/**
 * The entry a row sends, or null while there is nothing to send. A secret
 * row takes a saved key or a new one, never a plain value; a plain row takes
 * a value. The pod checks again (an undeclared row, a ref that is not yours).
 */
export function setupEntry(
  row: Pick<SetupRowView, "secret">,
  draft: SetupRepairEntry | null
): SetupRepairEntry | null {
  if (!draft) return null;
  if (draft.kind === "existing")
    return row.secret && draft.ref.startsWith("vault://")
      ? { kind: "existing", ref: draft.ref }
      : null;
  const value = typeof draft.value === "string" ? draft.value.trim() : "";
  if (draft.kind === "new")
    return row.secret && value ? { kind: "new", value } : null;
  return !row.secret && value ? { kind: "value", value } : null;
}
