"use client";

/**
 * A MODULE cell, RUNNING: an ES module (a React component) in an isolated
 * frame, drawn with the host modules of the pod's renderer bundle
 * (`use-host-modules`), reading and writing pod objects only through the
 * bridge. The second and last frame of pod admin, beside `html-frame` (a
 * stored HTML page). Its contract (sandbox, srcdoc, message rules, typed
 * writes) is the shared leaf `@synap-core/types/cell-bridge`; its header
 * holds the security model and what it does NOT cover.
 *
 *   <iframe sandbox="allow-scripts allow-modals" allow=""
 *           referrerpolicy="no-referrer"
 *           srcdoc={policy meta + tokens + host modules + SDK + cell}>
 *
 * Never `allow-same-origin`, never a `src` URL, never a token, pod URL or
 * key inside. A message is handled only from THIS frame's window with the
 * opaque origin "null" (`createCellFrameHost`). Reads go through the same
 * console reads a stored page uses (`readForPage`), stamped with the host's
 * lens; writes go through the pod's governed doors (`writeForFrame`),
 * stamped with the frame's type and view: the pod answers approved,
 * proposed or denied. A proposed write gets a receipt with its Review door,
 * a denied or failed one a failure receipt, and an approved one refreshes
 * the page's own reads of what it touched. A frame that navigates away (a
 * second `load`) is torn down; the reader can run it again.
 *
 * A frame carries megabytes of srcdoc, so it mounts only when it nears the
 * viewport (`observeNear`), and starts hidden under its cover (a skeleton of
 * its first height, or the page's own content for a record) until the cell
 * says it is ready, then fades in (the `fade` motion preset).
 */

import {
  CELL_FRAME_MOUNT_TIMEOUT_MS,
  CELL_FRAME_READY_TIMEOUT_MS,
  CELL_MODULE_FRAME_SANDBOX,
  buildCellModuleFrameSrcdoc,
  cellModuleHostModulesRefusal,
  cellModuleNeedsKit,
  cellModuleNetworkRefusal,
  createCellFrameHost,
  type CellBridgeEventLike,
  type CellBridgeMutateResult,
  type CellBridgeTarget,
  type CellFrameHostModules,
  type CellFrameInitContext,
  type CellFrameLens,
  type CellFrameStatus,
  type CellFrameWorkspaceScope,
  type CellFrameWriteRequest,
} from "@synap-core/types/cell-bridge";
import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { Button } from "@heroui/react";
import { Maximize2 } from "lucide-react";
import { useTheme } from "next-themes";
import type { Locale } from "@synap-core/types/i18n";
import { trpc } from "../../../../lib/trpc";
import { useConsoleLocale } from "../../../../lib/i18n/locale-provider";
import { ResourceRowError } from "../../../(admin)/components/resource-row";
import { showReceipt } from "../../receipt/decision-receipt-toast";
import { typedDetail, type Receipt } from "../../receipt/decision-receipt";
import {
  REFUSED_WRITE_ANSWER,
  UNREAD_WRITE_ANSWER,
  writeForFrame,
} from "./bridge-writes";
import { readForPage, type BridgeClient } from "./html-bridge-reads";
import {
  browserFrameLinkEnv,
  handleFrameLink,
  handleFrameOpen,
} from "./html-frame-links";
import { NotRun, useFullSize } from "./html-frame";
import { EmbedBodyContext } from "./embed-context";
import { frameT, type RendererWordSubject } from "./frame-copy";
import { objectPage } from "./markdown-model";

/** What the frame IS: the pod resolves a write's trust from it. */
export interface ModuleFrameIdentity {
  /** The cell's type key; a frame without one cannot write. */
  typeKey?: string;
  /** The view it draws, when it draws one. */
  viewId?: string;
  /** The entity it draws, when it draws one (init context only). */
  entityId?: string;
  profileSlug?: string;
}

/**
 * The message handler of one running module frame, wired to pod admin's
 * doors. Pure of React: the component below runs it, tests drive it with a
 * fake window and a recording client.
 */
export function createModuleFrameHost(options: {
  frameWindow: () => CellBridgeTarget | null;
  client: BridgeClient;
  lens: CellFrameLens;
  identity: ModuleFrameIdentity;
  theme: () => "light" | "dark";
  /** The console's language: the frame's words follow it (`synap:init` `locale`). */
  locale?: () => Locale;
  /** `page` refuses every write (a stored HTML page's rule). Default `module`. */
  mechanism?: "module" | "page";
  onStatus?: (status: CellFrameStatus) => void;
  onResize?: (height: number) => void;
  /** What the pod answered a write the host sent: the receipt is the host's. */
  onWriteAnswer?: (
    result: CellBridgeMutateResult,
    request: CellFrameWriteRequest
  ) => void;
  /** A write the pod's door threw on (the frame reads it as denied). */
  onWriteError?: (err: unknown, request: CellFrameWriteRequest) => void;
}): (event: CellBridgeEventLike) => Promise<void> {
  const { identity, lens, client } = options;
  const workspaceScope: CellFrameWorkspaceScope = lens.workspaceId
    ? { type: "workspace", workspaceId: lens.workspaceId }
    : { type: "pod" };
  return createCellFrameHost({
    frameWindow: options.frameWindow,
    mechanism: options.mechanism ?? "module",
    lens,
    identity: {
      ...(identity.typeKey ? { typeKey: identity.typeKey } : {}),
      ...(identity.viewId ? { viewId: identity.viewId } : {}),
    },
    init: (): Omit<CellFrameInitContext, "sdkVersion"> => ({
      workspaceId: lens.workspaceId ?? "",
      workspaceScope,
      ...(identity.viewId ? { viewId: identity.viewId } : {}),
      ...(identity.entityId ? { entityId: identity.entityId } : {}),
      ...(identity.profileSlug ? { profileSlug: identity.profileSlug } : {}),
      theme: options.theme(),
      ...(options.locale ? { locale: options.locale() } : {}),
    }),
    read: (op, params) =>
      readForPage(client, op, params, { workspaceId: lens.workspaceId }),
    write: async (request) => {
      let result: CellBridgeMutateResult;
      try {
        result = await writeForFrame(client, request);
      } catch (err) {
        options.onWriteError?.(err, request);
        throw err;
      }
      options.onWriteAnswer?.(result, request);
      return result;
    },
    on: {
      status: options.onStatus,
      resize: options.onResize,
    },
  });
}

/** Our own words for a denial: the receipt says the hint, never these. */
const OWN_DENIALS: ReadonlySet<string> = new Set([
  UNREAD_WRITE_ANSWER,
  REFUSED_WRITE_ANSWER,
]);

/**
 * The receipt of a frame's write, from what the pod answered (rule
 * feedback-and-forms §1): sent for review, with its one door to the request;
 * refused, with the pod's sentence only when the pod typed it. An applied
 * write gets none: the frame redraws the object itself.
 */
export function writeReceipt(result: CellBridgeMutateResult): Receipt | null {
  const t = frameT();
  if (result.status === "proposed") {
    const href = result.proposalId
      ? objectPage("proposal", result.proposalId)
      : null;
    return {
      title: t("renderer.write.proposed"),
      description: t("renderer.write.proposedBody"),
      tone: "default",
      undo: false,
      ...(href ? { action: { label: t("renderer.write.review"), href } } : {}),
    };
  }
  if (result.status === "denied") {
    const typed =
      result.error && !OWN_DENIALS.has(result.error) ? result.error : null;
    return {
      title: t("renderer.write.failed"),
      description: typed ?? t("renderer.write.failedHint"),
      tone: "danger",
      undo: false,
    };
  }
  return null;
}

/** A write whose door threw: the pod's sentence only when it is typed. */
export function writeErrorReceipt(err: unknown): Receipt {
  const t = frameT();
  return {
    title: t("renderer.write.failed"),
    description:
      typedDetail(err as Parameters<typeof typedDetail>[0]) ??
      t("renderer.write.failedHint"),
    tone: "danger",
    undo: false,
  };
}

/** The host's reads an applied write made stale: the page draws them again. */
export interface StaleReads {
  entityIds: string[];
  viewId?: string;
}

/**
 * What an APPLIED write touched, among what the host page reads: the
 * records it wrote (and both ends of a new link), the record the frame
 * draws, and the view it draws. Anything else answers nothing.
 */
export function readsToRefresh(
  request: CellFrameWriteRequest,
  result: CellBridgeMutateResult,
  identity: ModuleFrameIdentity
): StaleReads {
  if (result.status !== "approved") return { entityIds: [] };
  const ids = new Set<string>();
  switch (request.op) {
    case "update_entity":
    case "delete_entity":
      ids.add(request.payload.id);
      break;
    case "create_relation":
      ids.add(request.payload.sourceEntityId);
      ids.add(request.payload.targetEntityId);
      break;
    case "create_entity": {
      const id = (result.data as { id?: unknown } | undefined)?.id;
      if (typeof id === "string") ids.add(id);
      break;
    }
  }
  if (identity.entityId) ids.add(identity.entityId);
  return {
    entityIds: [...ids],
    ...(identity.viewId ? { viewId: identity.viewId } : {}),
  };
}

/**
 * What the frame's status makes the host draw: the cell, the failed state,
 * or (a cell that says it does not draw this object) the page's own content.
 */
export function moduleFrameStatusOf(
  status: CellFrameStatus
): "ready" | "failed" | "not-drawn" {
  if (status.state === "ready") return "ready";
  return status.reason === "not-drawn" ? "not-drawn" : "failed";
}

/** The reader's theme as the frame takes it. */
function frameTheme(resolved: string | undefined): "light" | "dark" {
  return resolved === "dark" ? "dark" : "light";
}

/** Why this cell cannot run with these modules, in the reader's words. */
export function moduleFrameRefusal(
  code: string,
  hostModules: CellFrameHostModules,
  deps?: Record<string, string>
): { line: string; why: string } | null {
  const t = frameT();
  const network = cellModuleNetworkRefusal(code, deps);
  if (network) return { line: t("renderer.refused.line"), why: network };
  const missing = cellModuleHostModulesRefusal(code, hostModules);
  if (!missing) return null;
  return {
    line:
      cellModuleNeedsKit(code) && !hostModules.kit
        ? t("renderer.needsKit")
        : t("renderer.refused.line"),
    why: missing,
  };
}

/**
 * An inline frame's height before its cell says its own, and its skeleton's:
 * ONE number, so the frame takes the skeleton's place without a jump.
 */
export const FRAME_INITIAL_HEIGHT = 320;
/** A filling frame (a view's page) never draws shorter than this. */
const FILL_MIN_HEIGHT = 420;
/** Under a filling frame: the card's and the page's own bottom padding. */
const FILL_BOTTOM_GAP = 96;
/** How near the viewport a frame mounts: about a screen ahead. */
export const FRAME_NEAR_MARGIN = "600px 0px";

/**
 * Calls `onNear` once `el` nears the viewport, then stops looking. Without an
 * observer (a static render, an old browser) it is near at once.
 */
export function observeNear(
  el: Element,
  onNear: () => void,
  Observer:
    typeof IntersectionObserver | undefined = globalThis.IntersectionObserver
): (() => void) | undefined {
  if (!Observer) {
    onNear();
    return undefined;
  }
  const io = new Observer(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        onNear();
      }
    },
    { rootMargin: FRAME_NEAR_MARGIN }
  );
  io.observe(el);
  return () => io.disconnect();
}

function useNearViewport(ref: RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(
    () => typeof globalThis.IntersectionObserver === "undefined"
  );
  useEffect(() => {
    if (near || !ref.current) return;
    return observeNear(ref.current, () => setNear(true));
  }, [near, ref]);
  return near;
}

/** A filling frame takes the height left under it in the window. */
function useFillHeight(
  ref: RefObject<HTMLElement | null>,
  fill: boolean
): number | undefined {
  const [height, setHeight] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!fill) return;
    const measure = () => {
      const el = ref.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      setHeight(
        Math.max(FILL_MIN_HEIGHT, window.innerHeight - top - FILL_BOTTOM_GAP)
      );
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [fill, ref]);
  return fill ? (height ?? FILL_MIN_HEIGHT) : undefined;
}

/**
 * Focus moves to the area a Retry redraws (rule keyboard-and-focus §4): the
 * reader who pressed it is not left on a button that is gone.
 */
export function useFocusAfterRetry<T extends HTMLElement>(): {
  ref: RefObject<T | null>;
  retrying: (retry?: () => void) => (() => void) | undefined;
} {
  const ref = useRef<T | null>(null);
  const pending = useRef(false);
  useEffect(() => {
    if (!pending.current || !ref.current) return;
    pending.current = false;
    ref.current.focus();
  });
  return {
    ref,
    retrying: (retry) =>
      retry
        ? () => {
            pending.current = true;
            retry();
          }
        : undefined,
  };
}

/**
 * The loading state, in the frame's shape and at its first height. Outside a
 * body it is its own status region; inside one, the body's single region
 * speaks for every frame in it (`EmbedBodyContext`). `announce={false}` is a
 * frame waiting to come into view: not loading, so never announced.
 */
export function RendererSkeleton({
  fill = false,
  subject = "cell",
  announce = true,
}: {
  fill?: boolean;
  subject?: RendererWordSubject;
  announce?: boolean;
}) {
  const t = frameT();
  const body = useContext(EmbedBodyContext);
  const ref = useRef<HTMLDivElement | null>(null);
  // A filling skeleton takes the height its frame will: no jump on swap.
  const fillHeight = useFillHeight(ref, fill);
  useEffect(() => {
    if (!announce || !body) return;
    return body.busy();
  }, [announce, body]);
  const label = t("renderer.loading", { subject });
  const speaks = announce && !body;
  return (
    <div
      ref={ref}
      {...(speaks
        ? { role: "status", "aria-busy": true, "aria-label": label }
        : { "aria-hidden": true })}
      style={{ height: fillHeight ?? FRAME_INITIAL_HEIGHT }}
      className="w-full rounded-lg bg-foreground/[0.05] shimmer-pulse"
    />
  );
}

/** The sandboxed element itself. Presentational: no bridge, no data. */
export function ModuleSandbox({
  srcDoc,
  title,
  frameRef,
  onLoad,
  height,
  full = false,
  hidden = false,
}: {
  srcDoc: string;
  title: string;
  frameRef?: Ref<HTMLIFrameElement>;
  onLoad?: () => void;
  height?: number;
  /** Shown full size: it fills the box the browser made full screen. */
  full?: boolean;
  /** Starting: laid out but unseen, under its cover, until the cell is ready. */
  hidden?: boolean;
}) {
  return (
    <iframe
      ref={frameRef}
      title={title}
      srcDoc={srcDoc}
      sandbox={CELL_MODULE_FRAME_SANDBOX}
      allow=""
      referrerPolicy="no-referrer"
      onLoad={onLoad}
      aria-hidden={hidden || undefined}
      style={{
        ...(full ? {} : { height: height ?? FRAME_INITIAL_HEIGHT }),
        transition: "opacity var(--synap-transition-fade-enter)",
      }}
      className={`block w-full ${full ? "h-full" : "rounded-lg ring-1 ring-inset ring-foreground/10"} ${hidden ? "invisible absolute inset-x-0 top-0 opacity-0" : "visible opacity-100"}`}
    />
  );
}

/**
 * A module cell running in its frame, with the bridge answering its reads
 * and sending its writes to the pod. A cell that needs code from the network,
 * or a module this pod's bundle does not have (the kit), is not run: the
 * reader is told why, next to the host's door (`refusedAction`), which also
 * stays beside a frame that failed or left.
 */
export function ModuleFrame({
  code,
  deps,
  externalHosts,
  hostModules,
  identity,
  workspaceId,
  title,
  fill = false,
  refusedAction,
  subject = "cell",
  cover,
  notDrawn,
}: {
  code: string;
  deps?: Record<string, string>;
  externalHosts?: readonly string[];
  hostModules: CellFrameHostModules;
  identity: ModuleFrameIdentity;
  /** The lens every read and write is stamped with. */
  workspaceId: string | null;
  title: string;
  /** Fill the height left under it (a view's page) instead of its own. */
  fill?: boolean;
  refusedAction?: ReactNode;
  /** What it draws, for its words. */
  subject?: RendererWordSubject;
  /** Drawn until the cell is ready (default: the skeleton). */
  cover?: ReactNode;
  /**
   * What the host shows when the cell says it does not draw this object
   * (`synap:error` reason `not-drawn`): the page's own content, as with no
   * renderer. Absent: the failed state.
   */
  notDrawn?: ReactNode;
}) {
  const utils = trpc.useUtils();
  const client = utils.client;
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const loads = useRef(0);
  const [run, setRun] = useState(0);
  const [left, setLeft] = useState(false);
  const [status, setStatus] = useState<
    "starting" | "ready" | "failed" | "not-drawn"
  >("starting");
  const [height, setHeight] = useState<number | undefined>(undefined);
  const { resolvedTheme } = useTheme();
  const theme = frameTheme(resolvedTheme);
  const themeRef = useRef(theme);
  themeRef.current = theme;
  // A change of language remounts the console's pages (`ConsoleLocaleProvider`),
  // so the frame is rebuilt and reads the new one at its next init.
  const locale = useConsoleLocale();
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const area = useFocusAfterRetry<HTMLDivElement>();
  const near = useNearViewport(area.ref);
  const fillHeight = useFillHeight(area.ref, fill);
  const fullSize = useFullSize();

  // Keyed by value: a caller that hands a new but equal array must not
  // rebuild the srcdoc, which would reload (and so tear down) the frame.
  const depsKey = JSON.stringify(deps ?? {});
  const hostsKey = (externalHosts ?? []).join(" ");
  const refusal = useMemo(
    () => moduleFrameRefusal(code, hostModules, JSON.parse(depsKey)),
    [code, hostModules, depsKey]
  );
  // Built once per cell and run, and only once the frame nears the viewport:
  // a theme change is POSTED to the running frame (`synap:theme`) instead of
  // rebuilding megabytes of srcdoc.
  const srcDoc = useMemo(
    () =>
      refusal || !near
        ? ""
        : buildCellModuleFrameSrcdoc({
            code,
            language: "react",
            theme: themeRef.current,
            externalHosts: hostsKey ? hostsKey.split(" ") : [],
            hostModules,
          }),
    // The theme is read through its ref: a change is posted, not rebuilt.
    [code, hostsKey, hostModules, refusal, run, near]
  );

  const lensKey = workspaceId ?? "";
  const { typeKey, viewId, entityId, profileSlug } = identity;
  const live = near && !left && !refusal;
  useEffect(() => {
    if (!live) return;
    const frameIdentity = { typeKey, viewId, entityId, profileSlug };
    const host = createModuleFrameHost({
      frameWindow: () => frameRef.current?.contentWindow ?? null,
      client,
      lens: { workspaceId: lensKey || null },
      identity: frameIdentity,
      theme: () => themeRef.current,
      locale: () => localeRef.current,
      onStatus: (s) => setStatus(moduleFrameStatusOf(s)),
      onResize: (h) => setHeight(h),
      onWriteAnswer: (result, request) => {
        const receipt = writeReceipt(result);
        if (receipt) showReceipt(receipt);
        const stale = readsToRefresh(request, result, frameIdentity);
        for (const id of stale.entityIds) {
          void utils.entities.get.invalidate({ id });
        }
        if (stale.viewId) {
          void utils.views.get.invalidate({ id: stale.viewId });
          void utils.views.execute.invalidate();
        }
      },
      onWriteError: (err) => showReceipt(writeErrorReceipt(err)),
    });
    const onMessage = (event: MessageEvent) => void host(event);
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [
    utils,
    client,
    lensKey,
    typeKey,
    viewId,
    entityId,
    profileSlug,
    live,
    run,
  ]);

  // A frame that never says it mounted is failed, not "still loading".
  useEffect(() => {
    if (!live || status !== "starting") return;
    const timer = setTimeout(
      () => setStatus((s) => (s === "starting" ? "failed" : s)),
      CELL_FRAME_READY_TIMEOUT_MS + CELL_FRAME_MOUNT_TIMEOUT_MS
    );
    return () => clearTimeout(timer);
  }, [live, status, run]);

  // The link door and "open this", as for a stored page (`html-frame`).
  useEffect(() => {
    if (!live) return;
    const env = browserFrameLinkEnv();
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current?.contentWindow ?? null;
      if (!handleFrameLink(event, frame, env)) {
        handleFrameOpen(event, frame, env);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [live, run]);

  // The reader switched theme: the running frame repaints itself.
  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage(
      { type: "synap:theme", theme },
      "*"
    );
  }, [theme]);

  const again = area.retrying(() => {
    loads.current = 0;
    setStatus("starting");
    setHeight(undefined);
    setLeft(false);
    setRun((n) => n + 1);
  });

  const t = frameT();
  if (refusal) {
    return (
      <NotRun
        mark={t("renderer.refused.mark")}
        line={refusal.line}
        why={refusal.why}
        action={refusedAction}
      />
    );
  }
  if (status === "not-drawn" && notDrawn !== undefined) return <>{notDrawn}</>;
  if (left || status === "failed" || status === "not-drawn") {
    return (
      <div className="flex flex-col items-center gap-1">
        <ResourceRowError
          message={left ? t("left.line") : t("renderer.failed", { subject })}
          onRetry={again}
        />
        {refusedAction}
      </div>
    );
  }
  const starting = status !== "ready";
  const coverNode = cover ?? <RendererSkeleton fill={fill} subject={subject} />;
  return (
    <div
      ref={area.ref}
      tabIndex={-1}
      role="group"
      aria-label={title}
      className="flex flex-col gap-2 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      data-reads-wide={fill ? "" : undefined}
    >
      {!fill && !starting && (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="light"
            radius="md"
            startContent={<Maximize2 aria-hidden size={14} />}
            onPress={fullSize.enter}
          >
            {t("fullSize")}
          </Button>
        </div>
      )}
      {/* The box goes full screen, never the frame: it is neither moved nor
          remounted, so the cell keeps its state and its bridge. */}
      <div
        ref={fullSize.boxRef}
        className={`relative ${fullSize.isFull ? "h-full w-full bg-background" : ""}`}
      >
        {!near ? (
          (cover ?? (
            <RendererSkeleton fill={fill} subject={subject} announce={false} />
          ))
        ) : (
          <>
            {starting && coverNode}
            <ModuleSandbox
              key={run}
              frameRef={frameRef}
              title={title}
              srcDoc={srcDoc}
              height={fill ? fillHeight : height}
              full={fullSize.isFull}
              hidden={starting}
              onLoad={() => {
                // The srcdoc's own load is the first; a later one is the
                // frame leaving for another address.
                loads.current += 1;
                if (loads.current > 1) setLeft(true);
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}
