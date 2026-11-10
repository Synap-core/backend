"use client";

/**
 * A stored HTML page, RUNNING: the author's scripts execute in an isolated
 * frame, and the page can read live pod objects through the read-only bridge,
 * answered with the viewer's own permissions. The contract — sandbox, policy,
 * allowed reads, the in-frame `window.synap.query` — is the shared leaf
 * `@synap-core/types/cell-bridge`; its header holds the security model and
 * what it does NOT cover.
 *
 *   <iframe sandbox="allow-scripts" allow="" referrerpolicy="no-referrer"
 *           srcdoc={policy meta + SDK + page}>
 *
 * Never `allow-same-origin` (the page would share the console's origin),
 * never a `src` URL (the page is text read through `documents.get`), never
 * inlined into the console's DOM. A page that navigates its frame away (a
 * second `load`) is torn down and the bridge closed with it; the reader can
 * run it again.
 */

import { Button, Tab, Tabs } from "@heroui/react";
import { Maximize2 } from "lucide-react";
import {
  CELL_FRAME_MAX_BYTES,
  CELL_FRAME_SANDBOX,
  createCellBridgeHost,
  frameNetworkCodeRefusal,
  wrapHtmlForFrame,
} from "@synap-core/types/cell-bridge";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { trpc } from "../../../../lib/trpc";
import { humanizeBytes } from "../../../../lib/format";
import { SectionCard } from "../../../(admin)/components/section-card";
import { StatusPill } from "../../../(admin)/components/status-pill";
import { ResourceRowError } from "../../../(admin)/components/resource-row";
import { readForPage } from "./html-bridge-reads";
import { frameT } from "./frame-copy";
import type { PreparedContent } from "./markdown-model";

/**
 * A page that is not run, said as a state: a mark, one short line, the host's
 * door, and (for the author) the technical reason behind "Why". Never a
 * sentence of hostnames in the reader's line.
 */
function NotRun({
  mark,
  line,
  why,
  action,
}: {
  mark: string;
  line: string;
  why?: string | null;
  action?: ReactNode;
}) {
  const t = frameT();
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg bg-content2 px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill kind="unknown" label={mark} />
        <p className="text-small text-foreground/85">{line}</p>
      </div>
      {action}
      {why && (
        <details className="text-tiny text-foreground/65">
          <summary className="cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
            {t("refused.why")}
          </summary>
          <p className="mt-1 max-w-prose">{why}</p>
        </details>
      )}
    </div>
  );
}

/** The sandboxed element itself. Presentational: no bridge, no data. */
export function SandboxedFrame({
  srcDoc,
  title,
  frameRef,
  onLoad,
  fill = false,
}: {
  srcDoc: string;
  title: string;
  frameRef?: Ref<HTMLIFrameElement>;
  onLoad?: () => void;
  /** Fill its box (the page shown full size) instead of the inline height. */
  fill?: boolean;
}) {
  return (
    <iframe
      ref={frameRef}
      title={title}
      srcDoc={srcDoc}
      sandbox={CELL_FRAME_SANDBOX}
      allow=""
      referrerPolicy="no-referrer"
      onLoad={onLoad}
      className={
        fill
          ? "block h-full w-full bg-white"
          : "block h-[min(80vh,900px)] min-h-[420px] w-full rounded-lg bg-white ring-1 ring-inset ring-foreground/10"
      }
    />
  );
}

/**
 * A page running in its frame, with the bridge answering its reads. A page
 * that loads code from the network is NOT run: the frame policy names no
 * remote origin (decision R3), so that code would never load and the frame
 * would sit blank. The reader is told why instead, next to the host's door
 * (`refusedAction`: the source, or the page's own door); the author reads the
 * same sentence in the document's diagnostics (`network_code`).
 */
export function HtmlFrame({
  html,
  workspaceId,
  title,
  refusedAction,
  fullSize,
}: {
  html: string;
  /** The page's space: the lens every read is stamped with. */
  workspaceId: string | null;
  title: string;
  /** The door shown beside the reason when the page is not run. */
  refusedAction?: ReactNode;
  /** The box the section's Full size button shows full screen. */
  fullSize?: FullSize;
}) {
  const client = trpc.useUtils().client;
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const loads = useRef(0);
  const [run, setRun] = useState(0);
  const [left, setLeft] = useState(false);
  const refusal = useMemo(() => frameNetworkCodeRefusal(html), [html]);
  const srcDoc = useMemo(() => wrapHtmlForFrame(html), [html]);

  useEffect(() => {
    if (left || refusal) return;
    const host = createCellBridgeHost({
      frameWindow: () => frameRef.current?.contentWindow ?? null,
      read: (op, params) => readForPage(client, op, params, { workspaceId }),
    });
    const onMessage = (event: MessageEvent) => void host(event);
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [client, workspaceId, left, refusal, run]);

  if (refusal) {
    const t = frameT();
    return (
      <NotRun
        mark={t("refused.mark")}
        line={t("refused.line")}
        why={refusal}
        action={refusedAction}
      />
    );
  }
  if (left) {
    return (
      <ResourceRowError
        message={frameT()("left.line")}
        onRetry={() => {
          loads.current = 0;
          setRun((n) => n + 1);
          setLeft(false);
        }}
      />
    );
  }
  // The frame sits in a box the section's Full size button shows full
  // screen. The box, not the frame, goes full screen: the frame is neither
  // moved nor remounted, so the page keeps its state and its bridge, and the
  // frame's own `allow=""` stays as it is.
  return (
    <div
      ref={fullSize?.boxRef}
      className={fullSize?.isFull ? "h-full w-full bg-white" : undefined}
    >
      <SandboxedFrame
        key={run}
        frameRef={frameRef}
        title={title}
        srcDoc={srcDoc}
        fill={fullSize?.isFull}
        onLoad={() => {
          // The srcdoc's own load is the first; any later one is the frame
          // leaving for another address.
          loads.current += 1;
          if (loads.current > 1) setLeft(true);
        }}
      />
    </div>
  );
}

/** The frame's box and whether it is the screen's full-screen element now. */
export type FullSize = {
  boxRef: RefObject<HTMLDivElement | null>;
  isFull: boolean;
};

/**
 * Full size for a running page: the browser's own full screen (Esc leaves
 * it), on the box around the frame. `isFull` follows the browser, so leaving
 * by Esc or by the browser's own control puts the frame back inline.
 */
export function useFullSize(): FullSize & { enter: () => void } {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [isFull, setIsFull] = useState(false);
  useEffect(() => {
    const onChange = () =>
      setIsFull(
        boxRef.current !== null && document.fullscreenElement === boxRef.current
      );
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const enter = useCallback(() => {
    const box = boxRef.current;
    if (!box || typeof box.requestFullscreen !== "function") return;
    void box.requestFullscreen().catch(() => {
      // Refused (no full screen in this browser or frame): the page stays inline.
    });
  }, []);
  return { boxRef, isFull, enter };
}

export type HtmlPageView = "page" | "source";

/** The page or its source, as the toggle chose. */
export function HtmlPageBody({
  view,
  html,
  bytes,
  tooLarge,
  workspaceId,
  source,
  title,
  sourceBody,
  onShowSource,
  fullSize,
}: {
  view: HtmlPageView;
  html: string;
  bytes: number;
  tooLarge: boolean;
  workspaceId: string | null;
  source: PreparedContent;
  title: string;
  /** How the console draws escaped source (`ContentBody`). */
  sourceBody: (prepared: PreparedContent) => ReactNode;
  onShowSource?: () => void;
  fullSize?: FullSize;
}) {
  if (view === "source") return <>{sourceBody(source)}</>;
  const t = frameT();
  const viewSource = onShowSource && (
    <Button size="sm" variant="flat" radius="md" onPress={onShowSource}>
      {t("viewSource")}
    </Button>
  );
  if (tooLarge) {
    return (
      <NotRun
        mark={t("tooLarge.mark")}
        line={t("tooLarge.line", {
          size: humanizeBytes(bytes),
          max: humanizeBytes(CELL_FRAME_MAX_BYTES),
        })}
        action={viewSource}
      />
    );
  }
  return (
    <HtmlFrame
      html={html}
      workspaceId={workspaceId}
      title={title}
      refusedAction={viewSource}
      fullSize={fullSize}
    />
  );
}

/** A stored page as an object-page section: Page by default, Source a toggle away. */
export function HtmlPageSection({
  title,
  html,
  bytes,
  tooLarge,
  workspaceId,
  source,
  sourceBody,
  footer,
  initialView = "page",
}: {
  title: string;
  html: string;
  bytes: number;
  tooLarge: boolean;
  workspaceId: string | null;
  source: PreparedContent;
  sourceBody: (prepared: PreparedContent) => ReactNode;
  /** Under the body (the "showing part of it" note for a cut source). */
  footer?: (view: HtmlPageView) => ReactNode;
  initialView?: HtmlPageView;
}) {
  const [view, setView] = useState<HtmlPageView>(initialView);
  const t = frameT();
  const fullSize = useFullSize();
  // Full size is offered only where a page runs: not for its source, a page
  // too large to run, or one that loads code from the network.
  const runs = useMemo(
    () => !tooLarge && !frameNetworkCodeRefusal(html),
    [html, tooLarge]
  );
  const tabs = (
    <Tabs
      size="sm"
      aria-label={t("toggle.aria")}
      selectedKey={view}
      onSelectionChange={(key) => setView(key as HtmlPageView)}
      classNames={{
        tabList: "bg-foreground/[0.04] rounded-lg",
        tab: "text-[12px]",
      }}
    >
      <Tab key="page" title={t("toggle.page")} />
      <Tab key="source" title={t("toggle.source")} />
    </Tabs>
  );
  return (
    <SectionCard
      variant="flat"
      title={title}
      actions={
        <div className="flex items-center gap-2">
          {view === "page" && runs && (
            <Button
              size="sm"
              variant="light"
              radius="md"
              startContent={<Maximize2 aria-hidden size={14} />}
              onPress={fullSize.enter}
            >
              {t("fullSize")}
            </Button>
          )}
          {tabs}
        </div>
      }
    >
      <HtmlPageBody
        view={view}
        html={html}
        bytes={bytes}
        tooLarge={tooLarge}
        workspaceId={workspaceId}
        source={source}
        title={title}
        sourceBody={sourceBody}
        onShowSource={() => setView("source")}
        fullSize={fullSize}
      />
      {footer?.(view)}
    </SectionCard>
  );
}
