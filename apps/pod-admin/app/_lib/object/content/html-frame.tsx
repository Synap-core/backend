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
import {
  CELL_FRAME_MAX_BYTES,
  CELL_FRAME_SANDBOX,
  wrapHtmlForFrame,
} from "@synap-core/types/cell-bridge";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { trpc } from "../../../../lib/trpc";
import { humanizeBytes } from "../../../../lib/format";
import { SectionCard } from "../../../(admin)/components/section-card";
import { ResourceRowError } from "../../../(admin)/components/resource-row";
import { createHtmlBridgeHost } from "./html-bridge-host";
import { readForPage } from "./html-bridge-reads";
import type { PreparedContent } from "./markdown-model";

/** The sandboxed element itself. Presentational: no bridge, no data. */
export function SandboxedFrame({
  srcDoc,
  title,
  frameRef,
  onLoad,
}: {
  srcDoc: string;
  title: string;
  frameRef?: Ref<HTMLIFrameElement>;
  onLoad?: () => void;
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
      className="block h-[min(80vh,900px)] min-h-[420px] w-full rounded-lg bg-white ring-1 ring-inset ring-foreground/10"
    />
  );
}

/** A page running in its frame, with the bridge answering its reads. */
export function HtmlFrame({
  html,
  workspaceId,
  title,
}: {
  html: string;
  /** The page's space: the lens every read is stamped with. */
  workspaceId: string | null;
  title: string;
}) {
  const client = trpc.useUtils().client;
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const loads = useRef(0);
  const [run, setRun] = useState(0);
  const [left, setLeft] = useState(false);
  const srcDoc = useMemo(() => wrapHtmlForFrame(html), [html]);

  useEffect(() => {
    if (left) return;
    const host = createHtmlBridgeHost({
      frameWindow: () => frameRef.current?.contentWindow ?? null,
      read: (op, params) => readForPage(client, op, params, { workspaceId }),
    });
    const onMessage = (event: MessageEvent) => void host(event);
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [client, workspaceId, left, run]);

  if (left) {
    return (
      <ResourceRowError
        message="This page tried to open another address, so it was stopped."
        onRetry={() => {
          loads.current = 0;
          setRun((n) => n + 1);
          setLeft(false);
        }}
      />
    );
  }
  return (
    <SandboxedFrame
      key={run}
      frameRef={frameRef}
      title={title}
      srcDoc={srcDoc}
      onLoad={() => {
        // The srcdoc's own load is the first; any later one is the frame
        // leaving for another address.
        loads.current += 1;
        if (loads.current > 1) setLeft(true);
      }}
    />
  );
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
}) {
  if (view === "source") return <>{sourceBody(source)}</>;
  if (tooLarge) {
    return (
      <div className="flex flex-col items-start gap-2 rounded-lg bg-foreground/[0.04] px-3 py-3">
        <p className="text-[13px] text-foreground/85">
          This page is {humanizeBytes(bytes)}. The console runs pages up to{" "}
          {humanizeBytes(CELL_FRAME_MAX_BYTES)}.
        </p>
        {onShowSource && (
          <Button size="sm" variant="flat" radius="md" onPress={onShowSource}>
            Show source
          </Button>
        )}
      </div>
    );
  }
  return <HtmlFrame html={html} workspaceId={workspaceId} title={title} />;
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
  return (
    <SectionCard
      variant="flat"
      title={title}
      actions={
        <Tabs
          size="sm"
          aria-label="Show this page as"
          selectedKey={view}
          onSelectionChange={(key) => setView(key as HtmlPageView)}
          classNames={{
            tabList: "bg-foreground/[0.04] rounded-lg",
            tab: "text-[12px]",
          }}
        >
          <Tab key="page" title="Page" />
          <Tab key="source" title="Source" />
        </Tabs>
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
      />
      {footer?.(view)}
    </SectionCard>
  );
}
