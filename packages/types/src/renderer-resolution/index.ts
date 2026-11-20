/**
 * @synap-core/types/renderer-resolution: the ONE answer to "which renderer
 * draws this object", for every host (the desktop, the web kit, pod admin).
 *
 * Until now the rule lived in three places of synap-app and the browser,
 * each with part of it: the entity card (`EntityBlockCell.tsx`), the entity
 * page (`profileSlotRenderer.tsx` with `profileRendererPrecedence.ts`) and a
 * view (`StructuredViewRenderer.tsx` with `viewAdapterRegistry.ts`). This
 * module copies that behaviour EXACTLY (the table `RENDERER_RESOLUTION_CASES`
 * pins each branch); those places re-export or call it, and a host that has
 * no built-ins of its own (pod admin) asks the same function.
 *
 * Pure and dependency-free. The host supplies what only it knows: which cells
 * are installed (`installed`), its own key (`selfKeys`), and what it draws
 * when nothing is bound (`localFallback`: a cell of its own, its built-in, or
 * nothing).
 *
 * The precedence, per subject:
 *   - entity-card: the entity's own override (`systemData.renderer`) wins
 *     when that cell is installed, is an `entity-card` cell and is not the
 *     host itself; then the kind's binding (`pickEffectiveRenderer` with no
 *     local fallback: a system default wins too) when it is a cell other
 *     than the host; then the host's fallback.
 *   - entity-detail: the entity's override wins when that cell is installed;
 *     then the kind's binding, where an unconfigured kind (`source:
 *     "default"`) gives the host's fallback the first shot; a FAILED read
 *     gives the host's fallback, marked `readFailed`.
 *   - view: the view's bound cell (`render.rendererRef`, kind "cell") wins
 *     only when it is installed, runs in a frame and declares this view
 *     type; otherwise the host's fallback (its built-in adapter).
 */

/** A stored renderer reference (a `RendererTarget` of synap-app headless): a cell, or another kind the host dispatches. */
export type RendererCellRef = {
  readonly kind: string;
  readonly cellKey?: string;
  readonly props?: Record<string, unknown>;
  readonly title?: string;
  readonly [field: string]: unknown;
};

/** What is being drawn. */
export type RendererSubject =
  | {
      kind: "entity";
      slot: "entity-card" | "entity-detail";
      entityId: string;
      profileSlug: string;
      /** The entity row's `systemData`, read for its `renderer` override only. */
      systemData?: unknown;
    }
  | {
      kind: "view";
      viewId: string;
      /** The view's effective type (board, table, …). */
      viewType: string;
      /** The view's `config.render`, read for its `rendererRef` only. */
      render?: unknown;
    };

/**
 * The host's read of `profiles.getEffectiveRenderers` for the subject's
 * kind and slot: its answer, or the fact that it failed. Absent = not asked
 * (a view never asks), read as an answer with nothing bound.
 */
export type EffectiveRenderersRead =
  { state: "ok"; result: unknown } | { state: "failed" };

/** One installed cell, as the host's registry knows it. */
export interface InstalledRenderer {
  key: string;
  /** `frame` = sandboxed; `direct` = runs in the host's own tree. */
  runtime: "frame" | "direct";
  /** The slot the cell is made for (`entity-card`, `entity-detail`, `collection`, …). */
  contentKind: string | null;
  /** The view types a view renderer declares. */
  viewTypes: readonly string[];
}

export interface RendererHost {
  /** The host's own cell keys: a binding to one of them would draw the host inside itself. */
  selfKeys?: readonly string[];
  /** What the host draws when nothing is bound: a cell of its own, its built-in, or nothing. */
  localFallback(subject: RendererSubject): RendererCellRef | "builtin" | null;
}

export type RendererResolution =
  | {
      kind: "cell";
      ref: RendererCellRef;
      via:
        | "entity-override"
        | "view-binding"
        | "binding"
        | "system-default"
        | "host-fallback";
      readFailed: boolean;
    }
  | { kind: "builtin"; readFailed: boolean }
  | { kind: "none"; readFailed: boolean };

export interface ResolveObjectRendererInput {
  subject: RendererSubject;
  effective?: EffectiveRenderersRead;
  installed: (key: string) => InstalledRenderer | undefined;
  host: RendererHost;
}

// ── The kind's binding: which answer of getEffectiveRenderers wins ─────────

/**
 * REVERSIBLE PRECEDENCE FLIP, the one line to change. `true`: an UNCONFIGURED
 * kind (`source === "default"`) gives the caller's local fallback the first
 * shot, which is what makes a host's own per-kind renderer reachable at all.
 * `false` restores "the pod's answer always wins", its system default too.
 */
export const PREFER_LOCAL_FALLBACK_OVER_SYSTEM_DEFAULT: boolean = true;

/** The slots the flip applies to (`collection` and `entity-profile` have other doors). */
const SOURCE_AWARE_KINDS: readonly string[] = ["entity-detail", "entity-card"];

/** Which layer of the pod answered (the `sources` map of getEffectiveRenderers). */
type BindingSource = "workspace" | "profile" | "default";

type EffectiveRenderersResult = Record<string, unknown> & {
  sources?: Record<string, BindingSource | null | undefined>;
};

type Picked<R> =
  | { ref: R; via: "binding" | "system-default" }
  | { ref: R; via: "fallback" }
  | { ref: null; via: "none" };

function pickWithVia<R extends RendererCellRef>(
  result: unknown,
  contentKind: string,
  fallback: () => R | null
): Picked<R> {
  const typed = result as EffectiveRenderersResult | undefined;
  const target = typed?.[contentKind] as R | null | undefined;
  const source = typed?.sources?.[contentKind];
  if (target) {
    const isSystemDefault =
      PREFER_LOCAL_FALLBACK_OVER_SYSTEM_DEFAULT &&
      source === "default" &&
      SOURCE_AWARE_KINDS.includes(contentKind);
    if (isSystemDefault) {
      const local = fallback();
      if (local) return { ref: local, via: "fallback" };
    }
    return {
      ref: target,
      via: source === "default" ? "system-default" : "binding",
    };
  }
  const local = fallback();
  return local ? { ref: local, via: "fallback" } : { ref: null, via: "none" };
}

/**
 * Decide the winning ref for one slot from a getEffectiveRenderers answer.
 * An EXPLICIT binding (`source` "workspace" or "profile") always wins. When
 * the pod only had its system default (`source === "default"`), `fallback`
 * gets first refusal for a source-aware slot; the default still answers when
 * the fallback yields nothing. A missing entry falls through to `fallback`:
 * `() => null` gets null for "nothing is bound, draw your own thing".
 */
export function pickEffectiveRenderer<R extends RendererCellRef>(
  result: unknown,
  contentKind: string,
  fallback: () => R | null
): R | null {
  return pickWithVia(result, contentKind, fallback).ref;
}

// ── The entity's own override ──────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The per-ENTITY renderer override (`systemData.renderer`, written by
 * `entities.setEntityRenderer`): only a `{ kind: "cell", cellKey }` ref
 * counts. The one reading of that field: no host reads it itself.
 */
export function resolveEntityRendererOverride(
  entity?: { systemData?: unknown } | null
): {
  kind: "cell";
  cellKey: string;
  props: Record<string, unknown>;
  title?: string;
} | null {
  const systemData = entity?.systemData;
  if (!isRecord(systemData)) return null;
  const ref = systemData.renderer;
  if (!isRecord(ref)) return null;
  if (ref.kind !== "cell") return null;
  if (typeof ref.cellKey !== "string" || ref.cellKey.length === 0) return null;
  return {
    kind: "cell",
    cellKey: ref.cellKey,
    props: isRecord(ref.props) ? ref.props : {},
    title: typeof ref.title === "string" ? ref.title : undefined,
  };
}

// ── The view's own binding ─────────────────────────────────────────────────

/**
 * The cell a view is bound to (`config.render.rendererRef`, kind "cell"), or
 * undefined. The one reading of that field: no host reads it itself.
 */
export function readBoundViewCellKey(render: unknown): string | undefined {
  if (render == null || typeof render !== "object") return undefined;
  const ref = (render as { rendererRef?: unknown }).rendererRef;
  if (
    ref != null &&
    typeof ref === "object" &&
    (ref as { kind?: unknown }).kind === "cell"
  ) {
    const key = (ref as { cellKey?: unknown }).cellKey;
    if (typeof key === "string") return key;
  }
  return undefined;
}

// ── The one resolution ─────────────────────────────────────────────────────

function fromFallback(
  local: RendererCellRef | "builtin" | null,
  readFailed: boolean
): RendererResolution {
  if (local === "builtin") return { kind: "builtin", readFailed };
  if (local)
    return { kind: "cell", ref: local, via: "host-fallback", readFailed };
  return { kind: "none", readFailed };
}

const BUILTIN_REF: RendererCellRef = Object.freeze({ kind: "builtin" });

/** Which renderer draws `subject`, and how it was chosen. */
export function resolveObjectRenderer(
  input: ResolveObjectRendererInput
): RendererResolution {
  const { subject, installed, host } = input;
  const self = new Set(host.selfKeys ?? []);

  if (subject.kind === "view") {
    const key = readBoundViewCellKey(subject.render);
    if (key) {
      const cell = installed(key);
      if (
        cell &&
        cell.runtime === "frame" &&
        cell.viewTypes.includes(subject.viewType)
      ) {
        return {
          kind: "cell",
          ref: { kind: "cell", cellKey: key, props: {} },
          via: "view-binding",
          readFailed: false,
        };
      }
    }
    return fromFallback(host.localFallback(subject), false);
  }

  const override = resolveEntityRendererOverride({
    systemData: subject.systemData,
  });
  const failed = input.effective?.state === "failed";
  const result =
    input.effective?.state === "ok" ? input.effective.result : undefined;

  if (subject.slot === "entity-card") {
    if (override && !self.has(override.cellKey)) {
      if (installed(override.cellKey)?.contentKind === "entity-card") {
        return {
          kind: "cell",
          ref: override,
          via: "entity-override",
          readFailed: false,
        };
      }
    }
    // No local fallback here: an unconfigured kind's system default wins too.
    const bound = pickWithVia<RendererCellRef>(
      result,
      "entity-card",
      () => null
    );
    if (
      bound.ref &&
      bound.ref.kind === "cell" &&
      typeof bound.ref.cellKey === "string" &&
      !self.has(bound.ref.cellKey)
    ) {
      return {
        kind: "cell",
        ref: bound.ref,
        via: bound.via === "system-default" ? "system-default" : "binding",
        readFailed: failed,
      };
    }
    return fromFallback(host.localFallback(subject), failed);
  }

  // entity-detail: any installed override wins (instance beats class).
  if (override && installed(override.cellKey)) {
    return {
      kind: "cell",
      ref: override,
      via: "entity-override",
      readFailed: false,
    };
  }
  const local = () => host.localFallback(subject);
  if (failed) {
    // A failed read still draws something, the host's fallback, and says so.
    const shown = local();
    return fromFallback(shown ?? "builtin", true);
  }
  // `builtin` is a local answer like a cell: it travels through the pick as
  // a marker ref and comes back out as the host's built-in.
  const picked = pickWithVia<RendererCellRef>(result, "entity-detail", () => {
    const l = local();
    return l === "builtin" ? BUILTIN_REF : l;
  });
  if (picked.via === "none") return { kind: "none", readFailed: false };
  if (picked.via === "fallback") {
    return picked.ref === BUILTIN_REF
      ? { kind: "builtin", readFailed: false }
      : {
          kind: "cell",
          ref: picked.ref,
          via: "host-fallback",
          readFailed: false,
        };
  }
  return { kind: "cell", ref: picked.ref, via: picked.via, readFailed: false };
}

// ── The cases every host runs through its own adapter ──────────────────────

/** One case as data: the host's registry and fallback are values, not functions. */
export interface RendererResolutionCaseInput {
  subject: RendererSubject;
  effective?: EffectiveRenderersRead;
  installed: readonly InstalledRenderer[];
  selfKeys?: readonly string[];
  localFallback: RendererCellRef | "builtin" | null;
}

export interface RendererResolutionCase {
  name: string;
  input: RendererResolutionCaseInput;
  expected: RendererResolution;
}

/** A case's input as the arguments of `resolveObjectRenderer`. */
export function rendererResolutionCaseArgs(
  input: RendererResolutionCaseInput
): ResolveObjectRendererInput {
  return {
    subject: input.subject,
    effective: input.effective,
    installed: (key) => input.installed.find((c) => c.key === key),
    host: {
      selfKeys: input.selfKeys,
      localFallback: () => input.localFallback,
    },
  };
}

const ENTITY = "11111111-1111-4111-8111-111111111111";
const VIEW = "22222222-2222-4222-8222-222222222222";
const CARD_HOST = "__entity-block";

const cardCell: InstalledRenderer = {
  key: "cell:acme:deal-card",
  runtime: "frame",
  contentKind: "entity-card",
  viewTypes: [],
};
const pageCell: InstalledRenderer = {
  key: "cell:acme:deal-page",
  runtime: "frame",
  contentKind: "entity-detail",
  viewTypes: [],
};
const boardCell: InstalledRenderer = {
  key: "cell:acme:board",
  runtime: "frame",
  contentKind: "collection",
  viewTypes: ["board", "kanban"],
};
const directBoard: InstalledRenderer = {
  ...boardCell,
  key: "cell:acme:direct-board",
  runtime: "direct",
};

const card = (systemData?: unknown): RendererSubject => ({
  kind: "entity",
  slot: "entity-card",
  entityId: ENTITY,
  profileSlug: "deal",
  ...(systemData !== undefined ? { systemData } : {}),
});
const page = (systemData?: unknown): RendererSubject => ({
  kind: "entity",
  slot: "entity-detail",
  entityId: ENTITY,
  profileSlug: "deal",
  ...(systemData !== undefined ? { systemData } : {}),
});
const view = (render?: unknown, viewType = "board"): RendererSubject => ({
  kind: "view",
  viewId: VIEW,
  viewType,
  ...(render !== undefined ? { render } : {}),
});
const overrideTo = (cellKey: string) => ({
  renderer: { kind: "cell", cellKey, props: { tone: "warm" } },
});
const overrideRef = (cellKey: string): RendererCellRef => ({
  kind: "cell",
  cellKey,
  props: { tone: "warm" },
  title: undefined,
});
const cellRef = (cellKey: string): RendererCellRef => ({
  kind: "cell",
  cellKey,
  props: {},
});
const answer = (
  slot: string,
  ref: RendererCellRef | null,
  source: BindingSource | null
): EffectiveRenderersRead => ({
  state: "ok",
  result: { [slot]: ref, sources: { [slot]: source } },
});
const hostCard = cellRef("entity-detail-deal");

/**
 * Every branch of the precedence, as data. A host proves it DELEGATES by
 * running each case through its own adapter (not only through
 * `resolveObjectRenderer`) and getting `expected`.
 */
export const RENDERER_RESOLUTION_CASES: readonly RendererResolutionCase[] = [
  // ── entity-card ──
  {
    name: "card: an installed entity-card override wins over a binding",
    input: {
      subject: card(overrideTo(cardCell.key)),
      effective: answer("entity-card", cellRef("cell:acme:other"), "workspace"),
      installed: [cardCell],
      selfKeys: [CARD_HOST],
      localFallback: "builtin",
    },
    expected: {
      kind: "cell",
      ref: overrideRef(cardCell.key),
      via: "entity-override",
      readFailed: false,
    },
  },
  {
    name: "card: an override that is not installed falls through to the host",
    input: {
      subject: card(overrideTo("cell:gone:card")),
      installed: [cardCell],
      selfKeys: [CARD_HOST],
      localFallback: "builtin",
    },
    expected: { kind: "builtin", readFailed: false },
  },
  {
    name: "card: an override made for the entity's page does not replace its card",
    input: {
      subject: card(overrideTo(pageCell.key)),
      installed: [pageCell],
      selfKeys: [CARD_HOST],
      localFallback: "builtin",
    },
    expected: { kind: "builtin", readFailed: false },
  },
  {
    name: "card: an override to the host itself is refused (it would recurse)",
    input: {
      subject: card(overrideTo(CARD_HOST)),
      installed: [{ ...cardCell, key: CARD_HOST }],
      selfKeys: [CARD_HOST],
      localFallback: "builtin",
    },
    expected: { kind: "builtin", readFailed: false },
  },
  {
    name: "card: a workspace binding to a cell wins",
    input: {
      subject: card(),
      effective: answer("entity-card", cellRef(cardCell.key), "workspace"),
      installed: [cardCell],
      selfKeys: [CARD_HOST],
      localFallback: "builtin",
    },
    expected: {
      kind: "cell",
      ref: cellRef(cardCell.key),
      via: "binding",
      readFailed: false,
    },
  },
  {
    name: "card: the system default wins over the host's own card (no local fallback on a card)",
    input: {
      subject: card(),
      effective: answer("entity-card", cellRef(cardCell.key), "default"),
      installed: [cardCell],
      selfKeys: [CARD_HOST],
      localFallback: "builtin",
    },
    expected: {
      kind: "cell",
      ref: cellRef(cardCell.key),
      via: "system-default",
      readFailed: false,
    },
  },
  {
    name: "card: a binding to the host itself is refused",
    input: {
      subject: card(),
      effective: answer("entity-card", cellRef(CARD_HOST), "profile"),
      installed: [],
      selfKeys: [CARD_HOST],
      localFallback: "builtin",
    },
    expected: { kind: "builtin", readFailed: false },
  },
  {
    name: "card: a binding that is not a cell gives the host's card",
    input: {
      subject: card(),
      effective: answer(
        "entity-card",
        { kind: "view-adapter", adapterKey: "list" },
        "profile"
      ),
      installed: [],
      selfKeys: [CARD_HOST],
      localFallback: "builtin",
    },
    expected: { kind: "builtin", readFailed: false },
  },
  {
    name: "card: nothing bound gives the host's fallback cell (a host with no built-in)",
    input: {
      subject: card(),
      effective: { state: "ok", result: {} },
      installed: [],
      localFallback: cellRef("cell:synap-renderers:entity-card"),
    },
    expected: {
      kind: "cell",
      ref: cellRef("cell:synap-renderers:entity-card"),
      via: "host-fallback",
      readFailed: false,
    },
  },
  {
    name: "card: a failed read gives the host's card, marked failed",
    input: {
      subject: card(),
      effective: { state: "failed" },
      installed: [],
      selfKeys: [CARD_HOST],
      localFallback: "builtin",
    },
    expected: { kind: "builtin", readFailed: true },
  },
  // ── entity-detail ──
  {
    name: "page: any installed override wins, whatever slot it was made for",
    input: {
      subject: page(overrideTo(cardCell.key)),
      effective: answer("entity-detail", cellRef(pageCell.key), "workspace"),
      installed: [cardCell, pageCell],
      localFallback: hostCard,
    },
    expected: {
      kind: "cell",
      ref: overrideRef(cardCell.key),
      via: "entity-override",
      readFailed: false,
    },
  },
  {
    name: "page: an override that is not installed falls through to the binding",
    input: {
      subject: page(overrideTo("cell:gone:page")),
      effective: answer("entity-detail", cellRef(pageCell.key), "profile"),
      installed: [pageCell],
      localFallback: hostCard,
    },
    expected: {
      kind: "cell",
      ref: cellRef(pageCell.key),
      via: "binding",
      readFailed: false,
    },
  },
  {
    name: "page: an explicit binding beats the host's own page",
    input: {
      subject: page(),
      effective: answer("entity-detail", cellRef(pageCell.key), "workspace"),
      installed: [pageCell],
      localFallback: hostCard,
    },
    expected: {
      kind: "cell",
      ref: cellRef(pageCell.key),
      via: "binding",
      readFailed: false,
    },
  },
  {
    name: "page: an unconfigured kind gives the host's own page the first shot",
    input: {
      subject: page(),
      effective: answer("entity-detail", cellRef("entity-detail"), "default"),
      installed: [],
      localFallback: hostCard,
    },
    expected: {
      kind: "cell",
      ref: hostCard,
      via: "host-fallback",
      readFailed: false,
    },
  },
  {
    name: "page: an unconfigured kind and a host built-in: the built-in",
    input: {
      subject: page(),
      effective: answer("entity-detail", cellRef("entity-detail"), "default"),
      installed: [],
      localFallback: "builtin",
    },
    expected: { kind: "builtin", readFailed: false },
  },
  {
    name: "page: the system default answers when the host has nothing",
    input: {
      subject: page(),
      effective: answer("entity-detail", cellRef("entity-detail"), "default"),
      installed: [],
      localFallback: null,
    },
    expected: {
      kind: "cell",
      ref: cellRef("entity-detail"),
      via: "system-default",
      readFailed: false,
    },
  },
  {
    name: "page: nothing bound and nothing local: none",
    input: {
      subject: page(),
      effective: { state: "ok", result: {} },
      installed: [],
      localFallback: null,
    },
    expected: { kind: "none", readFailed: false },
  },
  {
    name: "page: a failed read gives the host's fallback, marked failed",
    input: {
      subject: page(),
      effective: { state: "failed" },
      installed: [],
      localFallback: hostCard,
    },
    expected: {
      kind: "cell",
      ref: hostCard,
      via: "host-fallback",
      readFailed: true,
    },
  },
  {
    name: "page: a failed read with nothing local still draws the host's built-in",
    input: {
      subject: page(),
      effective: { state: "failed" },
      installed: [],
      localFallback: null,
    },
    expected: { kind: "builtin", readFailed: true },
  },
  // ── view ──
  {
    name: "view: a bound frame cell that declares the view type wins",
    input: {
      subject: view({ rendererRef: { kind: "cell", cellKey: boardCell.key } }),
      installed: [boardCell],
      localFallback: "builtin",
    },
    expected: {
      kind: "cell",
      ref: cellRef(boardCell.key),
      via: "view-binding",
      readFailed: false,
    },
  },
  {
    name: "view: a bound cell that runs outside a frame is refused",
    input: {
      subject: view({
        rendererRef: { kind: "cell", cellKey: directBoard.key },
      }),
      installed: [directBoard],
      localFallback: "builtin",
    },
    expected: { kind: "builtin", readFailed: false },
  },
  {
    name: "view: a bound cell that does not declare this view type is refused",
    input: {
      subject: view(
        { rendererRef: { kind: "cell", cellKey: boardCell.key } },
        "calendar"
      ),
      installed: [boardCell],
      localFallback: "builtin",
    },
    expected: { kind: "builtin", readFailed: false },
  },
  {
    name: "view: a bound cell that is not installed is refused",
    input: {
      subject: view({
        rendererRef: { kind: "cell", cellKey: "cell:gone:board" },
      }),
      installed: [boardCell],
      localFallback: "builtin",
    },
    expected: { kind: "builtin", readFailed: false },
  },
  {
    name: "view: a view-adapter binding is the host's own business",
    input: {
      subject: view({
        rendererRef: { kind: "view-adapter", adapterKey: "kanban" },
      }),
      installed: [boardCell],
      localFallback: "builtin",
    },
    expected: { kind: "builtin", readFailed: false },
  },
  {
    name: "view: unbound, a host with no built-in draws its default cell",
    input: {
      subject: view(),
      installed: [boardCell],
      localFallback: cellRef(boardCell.key),
    },
    expected: {
      kind: "cell",
      ref: cellRef(boardCell.key),
      via: "host-fallback",
      readFailed: false,
    },
  },
  {
    name: "view: unbound and nothing local: none",
    input: { subject: view(), installed: [], localFallback: null },
    expected: { kind: "none", readFailed: false },
  },
];
