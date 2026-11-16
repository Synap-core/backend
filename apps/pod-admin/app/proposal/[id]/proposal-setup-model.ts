/**
 * What a proposal still NEEDS FROM YOU before it can apply (finding
 * 91a3bfd3, plan d717d6ac addendum B): the pod's setup projection
 * (`proposals.get` `setup`, `proposals.repairOptions` `setup` with the
 * person's own vault secrets), shaped into the hand-over rows the review
 * draws, and the entry each row sends to `proposals.repair` `setup`.
 *
 * PURE. The pod decides everything here: which rows block (`satisfied`,
 * `blocking`), how to get a value (`obtain`, from the manifest), and the
 * write (vault first, refs only, `repair-setup.ts`). A key's value is held
 * only in the field until it is sent; nothing here keeps it.
 */
import { humanizeToken } from "@synap-core/types/vocabulary";

/** One setup row as the pod projects it (`ProposalSetupParam`), structurally. */
export interface ProposalSetupParamView {
  name: string;
  label?: string;
  required: boolean;
  description?: string;
  secret: boolean;
  satisfied: boolean;
  obtain?: { url?: string; steps: string[] };
  refName?: string;
  refUnresolved?: boolean;
}

export interface ProposalSetupView {
  params: ProposalSetupParamView[];
  blocking: boolean;
}

/** One of the person's own vault secrets (`repairOptions.setup.secretChoices`). */
export interface SetupSecretChoiceView {
  ref: string;
  label: string;
  service?: string;
}

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

function labelOf(p: ProposalSetupParamView): string {
  return p.label?.trim() || humanizeToken(p.name);
}

/** "Fill in X first" (B5): the first REQUIRED row still empty, or null. */
export function proposalSetupBlock(
  setup: ProposalSetupView | null | undefined
): string | null {
  if (!setup?.blocking) return null;
  const row = setup.params.find((p) => p.required && !p.satisfied);
  return row ? labelOf(row) : null;
}

/** The rows the person still has to hand over, required first. */
export function setupRows(
  setup: ProposalSetupView | null | undefined
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

/** What the person picked or typed for one row. */
export type SetupDraft =
  | { kind: "existing"; ref: string }
  | { kind: "new"; value: string }
  | { kind: "value"; value: string };

/** `proposals.repair`'s `setup` entry for a row (`setupRepairEntrySchema`). */
export type SetupEntry =
  | { kind: "existing"; ref: string }
  | { kind: "new"; value: string }
  | { kind: "value"; value: string };

/**
 * The entry a row sends, or null while there is nothing to send. A secret
 * row takes a saved key or a new one, never a plain value; a plain row takes
 * a value. The pod checks again (an undeclared row, a ref that is not yours).
 */
export function setupEntry(
  row: Pick<SetupRowView, "secret">,
  draft: SetupDraft | null
): SetupEntry | null {
  if (!draft) return null;
  if (draft.kind === "existing")
    return row.secret && draft.ref.startsWith("vault://")
      ? { kind: "existing", ref: draft.ref }
      : null;
  if (draft.kind === "new")
    return row.secret && draft.value.trim()
      ? { kind: "new", value: draft.value.trim() }
      : null;
  return !row.secret && draft.value.trim()
    ? { kind: "value", value: draft.value.trim() }
    : null;
}
