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
 * proposed or denied, and a proposed write gets its receipt here. A frame
 * that navigates away (a second `load`) is torn down; the reader can run it
 * again.
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
} from "@synap-core/types/cell-bridge";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { useTheme } from "next-themes";
import { trpc } from "../../../../lib/trpc";
import { ResourceRowError } from "../../../(admin)/components/resource-row";
import { showReceipt } from "../../receipt/decision-receipt-toast";
import { writeForFrame } from "./bridge-writes";
import { readForPage, type BridgeClient } from "./html-bridge-reads";
import {
  browserFrameLinkEnv,
  handleFrameLink,
  handleFrameOpen,
} from "./html-frame-links";
import { NotRun } from "./html-frame";
import { frameT } from "./frame-copy";

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
  /** `page` refuses every write (a stored HTML page's rule). Default `module`. */
  mechanism?: "module" | "page";
  onStatus?: (status: CellFrameStatus) => void;
  onResize?: (height: number) => void;
  /** The pod sent a write for review: the receipt is the host's. */
  onProposed?: (result: CellBridgeMutateResult) => void;
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
    }),
    read: (op, params) =>
      readForPage(client, op, params, { workspaceId: lens.workspaceId }),
    write: async (request) => {
      const result = await writeForFrame(client, request);
      if (result.status === "proposed") options.onProposed?.(result);
      return result;
    },
    on: {
      status: options.onStatus,
      resize: options.onResize,
    },
  });
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

const INLINE_HEIGHT = 320;

/** The sandboxed element itself. Presentational: no bridge, no data. */
export function ModuleSandbox({
  srcDoc,
  title,
  frameRef,
  onLoad,
  fill = false,
  height,
}: {
  srcDoc: string;
  title: string;
  frameRef?: Ref<HTMLIFrameElement>;
  onLoad?: () => void;
  fill?: boolean;
  height?: number;
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
      style={fill ? undefined : { height: height ?? INLINE_HEIGHT }}
      className={
        fill
          ? "block h-[min(80vh,900px)] min-h-[420px] w-full rounded-lg ring-1 ring-inset ring-foreground/10"
          : "block max-h-[80vh] w-full rounded-lg ring-1 ring-inset ring-foreground/10"
      }
    />
  );
}

/**
 * A module cell running in its frame, with the bridge answering its reads
 * and sending its writes to the pod. A cell that needs code from the network,
 * or a module this pod's bundle does not have (the kit), is not run: the
 * reader is told why, next to the host's door (`refusedAction`).
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
}: {
  code: string;
  deps?: Record<string, string>;
  externalHosts?: readonly string[];
  hostModules: CellFrameHostModules;
  identity: ModuleFrameIdentity;
  /** The lens every read and write is stamped with. */
  workspaceId: string | null;
  title: string;
  /** Fill its box (a view's page) instead of the cell's own height. */
  fill?: boolean;
  refusedAction?: ReactNode;
}) {
  const client = trpc.useUtils().client;
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const loads = useRef(0);
  const [run, setRun] = useState(0);
  const [left, setLeft] = useState(false);
  const [status, setStatus] = useState<"starting" | "ready" | "failed">(
    "starting"
  );
  const [height, setHeight] = useState<number | undefined>(undefined);
  const { resolvedTheme } = useTheme();
  const theme = frameTheme(resolvedTheme);
  const themeRef = useRef(theme);
  themeRef.current = theme;

  // Keyed by value: a caller that hands a new but equal array must not
  // rebuild the srcdoc, which would reload (and so tear down) the frame.
  const depsKey = JSON.stringify(deps ?? {});
  const hostsKey = (externalHosts ?? []).join(" ");
  const refusal = useMemo(
    () => moduleFrameRefusal(code, hostModules, JSON.parse(depsKey)),
    [code, hostModules, depsKey]
  );
  // Built once per cell and run: a theme change is POSTED to the running
  // frame (`synap:theme`) instead of rebuilding megabytes of srcdoc.
  const srcDoc = useMemo(
    () =>
      refusal
        ? ""
        : buildCellModuleFrameSrcdoc({
            code,
            language: "react",
            theme: themeRef.current,
            externalHosts: hostsKey ? hostsKey.split(" ") : [],
            hostModules,
          }),
    // The theme is read through its ref: a change is posted, not rebuilt.
    [code, hostsKey, hostModules, refusal, run]
  );

  const lensKey = workspaceId ?? "";
  const { typeKey, viewId, entityId, profileSlug } = identity;
  useEffect(() => {
    if (left || refusal) return;
    const host = createModuleFrameHost({
      frameWindow: () => frameRef.current?.contentWindow ?? null,
      client,
      lens: { workspaceId: lensKey || null },
      identity: { typeKey, viewId, entityId, profileSlug },
      theme: () => themeRef.current,
      onStatus: (s) => setStatus(s.state === "ready" ? "ready" : "failed"),
      onResize: (h) => setHeight(h),
      onProposed: () => {
        const t = frameT();
        showReceipt({
          title: t("renderer.write.proposed"),
          description: t("renderer.write.proposedBody"),
          tone: "default",
          undo: false,
        });
      },
    });
    const onMessage = (event: MessageEvent) => void host(event);
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [
    client,
    lensKey,
    typeKey,
    viewId,
    entityId,
    profileSlug,
    left,
    refusal,
    run,
  ]);

  // A frame that never says it mounted is failed, not "still loading".
  useEffect(() => {
    if (left || refusal || status !== "starting") return;
    const timer = setTimeout(
      () => setStatus((s) => (s === "starting" ? "failed" : s)),
      CELL_FRAME_READY_TIMEOUT_MS + CELL_FRAME_MOUNT_TIMEOUT_MS
    );
    return () => clearTimeout(timer);
  }, [left, refusal, status, run]);

  // The link door and "open this", as for a stored page (`html-frame`).
  useEffect(() => {
    if (left || refusal) return;
    const env = browserFrameLinkEnv();
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current?.contentWindow ?? null;
      if (!handleFrameLink(event, frame, env)) {
        handleFrameOpen(event, frame, env);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [left, refusal, run]);

  // The reader switched theme: the running frame repaints itself.
  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage(
      { type: "synap:theme", theme },
      "*"
    );
  }, [theme]);

  const again = () => {
    loads.current = 0;
    setStatus("starting");
    setHeight(undefined);
    setLeft(false);
    setRun((n) => n + 1);
  };

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
  if (left)
    return <ResourceRowError message={t("left.line")} onRetry={again} />;
  if (status === "failed") {
    return <ResourceRowError message={t("renderer.failed")} onRetry={again} />;
  }
  return (
    <ModuleSandbox
      key={run}
      frameRef={frameRef}
      title={title}
      srcDoc={srcDoc}
      fill={fill}
      height={height}
      onLoad={() => {
        // The srcdoc's own load is the first; a later one is the frame
        // leaving for another address.
        loads.current += 1;
        if (loads.current > 1) setLeft(true);
      }}
    />
  );
}
