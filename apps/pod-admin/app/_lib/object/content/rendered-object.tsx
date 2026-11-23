"use client";

/**
 * An object drawn by a renderer cell, or its identity card when none draws
 * it. The one place pod admin mounts a module frame (`ModuleFrame`): a cell
 * embedded in a body, a cell's own page, a view's page and an entity's
 * detail all come through here.
 *
 *   RenderedObject  which renderer draws it (`use-object-renderer`), then
 *                   that cell, else the page's own fallback
 *   CellByKey       one cell by its type key: its source on the viewer's
 *                   floor (`widgetDefinitions.get`), then `ModuleCell`
 *   ModuleCell      a module cell's source + the bundle's host modules
 *                   (`use-host-modules`) → the frame
 *
 * Every state is its own drawing, never folded into another:
 *   loading        a view: a skeleton in the frame's shape. A record (its
 *                  card or detail): the page's OWN content, swapped only
 *                  once a cell is ready, so a pod with no bundle never sees a
 *                  skeleton at all
 *   failed         `ResourceRowError` with Try again, beside the page's door;
 *                  for a record, its own content with one quiet line
 *   partly read    the bindings read failed (`readFailed`): one quiet line,
 *                  "Showing the default", never an error above a drawn cell
 *   not installed  the page's own content; `fallback` is told, so a view's
 *                  hand-off card can say it to a pod admin
 *   refused        the cell needs the network or a module the bundle lacks
 *                  (`ModuleFrame`'s own state)
 *   not drawn      the cell says it does not draw this object: the page's
 *                  own content, as with no renderer
 */

import { useMemo, type ReactNode } from "react";
import type { RendererSubject } from "@synap-core/types/renderer-resolution";
import { trpc } from "../../../../lib/trpc";
import { ResourceRowError } from "../../../(admin)/components/resource-row";
import { StatusPill } from "../../../(admin)/components/status-pill";
import { frameT, type RendererWordSubject } from "./frame-copy";
import {
  HIDDEN_CODES,
  moduleCellSource,
  type ModuleCellSource,
} from "./markdown-model";
import {
  ModuleFrame,
  RendererSkeleton,
  useFocusAfterRetry,
  type ModuleFrameIdentity,
} from "./module-frame";
import { useHostModules } from "./use-host-modules";
import { useObjectRenderer, type RenderersStatus } from "./use-object-renderer";

export { RendererSkeleton };

/**
 * Synap's renderers are not on this pod: a mark and one line, beside the
 * door. For a cell that only a renderer can run (an embedded module cell, a
 * cell's own page).
 */
export function RendererNotice({ action }: { action?: ReactNode }) {
  const t = frameT();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-content2 px-3 py-2">
      <StatusPill kind="unknown" label={t("renderer.refused.mark")} />
      <p className="text-small text-foreground/85">
        {t("renderer.notInstalled")}
      </p>
      {action}
    </div>
  );
}

/** The quiet line over the default when the kind's choice could not be read. */
function PartlyRead() {
  return (
    <p className="text-tiny text-foreground/55">
      {frameT()("renderer.partly")}
    </p>
  );
}

/** An error with Retry, the door beside it; focus returns to it after Retry. */
function FailedWithDoor({
  message,
  retry,
  door,
}: {
  message: string;
  retry?: () => void;
  door?: ReactNode;
}) {
  const area = useFocusAfterRetry<HTMLDivElement>();
  return (
    <div
      ref={area.ref}
      tabIndex={-1}
      className="flex flex-col items-center gap-1 rounded-lg focus:outline-none"
    >
      <ResourceRowError message={message} onRetry={area.retrying(retry)} />
      {door}
    </div>
  );
}

/** A module cell's source + the bundle's host modules → the running frame. */
export function ModuleCell({
  source,
  identity,
  workspaceId,
  title,
  fill = false,
  door,
  subject = "cell",
  cover,
  notDrawn,
}: {
  source: ModuleCellSource;
  identity: ModuleFrameIdentity;
  /** The host's lens; the cell's own space when omitted. */
  workspaceId?: string | null;
  title: string;
  fill?: boolean;
  /** The host's door beside a cell that does not run (its page, the app). */
  door?: ReactNode;
  subject?: RendererWordSubject;
  /** Drawn while it loads and starts (default: the skeleton). */
  cover?: ReactNode;
  /** The page's own content, when the cell says it does not draw this object. */
  notDrawn?: ReactNode;
}) {
  const modules = useHostModules();
  const t = frameT();
  switch (modules.state) {
    case "loading":
      return <>{cover ?? <RendererSkeleton fill={fill} subject={subject} />}</>;
    case "failed":
      return (
        <FailedWithDoor
          message={t("renderer.failed", { subject })}
          retry={modules.retry}
          door={door}
        />
      );
    case "none":
      return <RendererNotice action={door} />;
    case "ready":
      return (
        <ModuleFrame
          code={source.code}
          deps={source.deps}
          externalHosts={source.externalHosts}
          hostModules={modules.modules}
          identity={identity}
          workspaceId={
            workspaceId === undefined ? source.workspaceId : workspaceId
          }
          title={title}
          fill={fill}
          refusedAction={door}
          subject={subject}
          cover={cover}
          notDrawn={notDrawn}
        />
      );
  }
}

/**
 * One cell by its type key, read on the viewer's own floor. A cell that is
 * not a module frame cell (or not visible) draws `fallback`; a failed read is
 * an error with Try again, never the fallback.
 */
export function CellByKey({
  cellKey,
  identity,
  workspaceId,
  title,
  fill,
  fallback,
  footer,
  subject = "cell",
  cover,
}: {
  cellKey: string;
  identity: Omit<ModuleFrameIdentity, "typeKey">;
  workspaceId: string | null;
  title: string;
  fill?: boolean;
  fallback: ReactNode;
  /** Under the cell when it runs (the object's own door). */
  footer?: ReactNode;
  subject?: RendererWordSubject;
  /** Drawn while it loads and starts (default: the skeleton). */
  cover?: ReactNode;
}) {
  const query = trpc.widgetDefinitions.get.useQuery(
    { typeKey: cellKey },
    { retry: false }
  );
  const source = useMemo(() => moduleCellSource(query.data), [query.data]);
  const t = frameT();
  if (query.error) {
    const code = query.error.data?.code;
    if (code && HIDDEN_CODES.has(code)) return <>{fallback}</>;
    return (
      <FailedWithDoor
        message={t("renderer.failed", { subject })}
        retry={() => void query.refetch()}
        door={footer}
      />
    );
  }
  if (query.isLoading) {
    return <>{cover ?? <RendererSkeleton fill={fill} subject={subject} />}</>;
  }
  if (!source) return <>{fallback}</>;
  return (
    <div className="flex flex-col gap-2">
      <ModuleCell
        source={source}
        identity={{ ...identity, typeKey: cellKey }}
        workspaceId={workspaceId}
        title={title}
        fill={fill}
        subject={subject}
        cover={cover}
        notDrawn={fallback}
      />
      {/* The door stays under the cell in every state it draws. */}
      {footer && <div className="flex justify-end">{footer}</div>}
    </div>
  );
}

/**
 * The resolved cell's key when pod admin can run it: one of the pod's
 * installed FRAME cells. A binding to a cell only another host draws (the
 * desktop's own `entity-detail-task`) is not a frame here: the page keeps its
 * identity card rather than reading a source it cannot run.
 */
export function drawableCellKey(
  ref: { cellKey?: unknown },
  status: RenderersStatus
): string | null {
  const key = typeof ref.cellKey === "string" ? ref.cellKey : null;
  if (!key) return null;
  return status.installed.some((c) => c.key === key && c.runtime === "frame")
    ? key
    : null;
}

/**
 * Whether a renderer cell will draw `subject` here (the resolution picked a
 * frame cell this pod runs). A page reads it to place what sits around the
 * drawing (its header's door), from the same reads `RenderedObject` makes.
 */
export function useDrawsCell(
  subject: RendererSubject,
  workspaceId: string | null
): boolean {
  const state = useObjectRenderer(subject, { workspaceId });
  return (
    state.state === "resolved" &&
    state.resolution.kind === "cell" &&
    drawableCellKey(state.resolution.ref, state.status) !== null
  );
}

/** What the page's own content is told: whether no bundle is on this pod. */
export interface FallbackContext {
  notInstalled: boolean;
}

/**
 * An object drawn by whichever renderer the one resolution picks, else the
 * page's own `fallback` (its identity card, or a record's fields).
 */
export function RenderedObject({
  subject,
  workspaceId,
  title,
  fill,
  fallback,
  drawnFooter,
}: {
  subject: RendererSubject;
  workspaceId: string | null;
  title: string;
  fill?: boolean;
  fallback: ReactNode | ((context: FallbackContext) => ReactNode);
  /** Under a drawn cell (the object's own door). */
  drawnFooter?: ReactNode;
}) {
  const state = useObjectRenderer(subject, { workspaceId });
  const t = frameT();
  const words: RendererWordSubject =
    subject.kind === "view" ? "view" : "entity";
  const own = (notInstalled: boolean): ReactNode =>
    typeof fallback === "function" ? fallback({ notInstalled }) : fallback;
  // A record's own content is complete without a renderer: it is drawn
  // while the reads load, and stays when they fail.
  const record = subject.kind === "entity";
  if (state.state === "loading") {
    return record ? (
      <>{own(false)}</>
    ) : (
      <RendererSkeleton fill={fill} subject={words} />
    );
  }
  if (state.state === "failed") {
    if (record) {
      return (
        <div className="flex flex-col gap-3">
          <PartlyRead />
          {own(false)}
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-3">
        <FailedWithDoor
          message={t("renderer.failed", { subject: words })}
          retry={state.retry}
        />
        {own(false)}
      </div>
    );
  }
  const { resolution, status } = state;
  const partly = resolution.readFailed ? <PartlyRead /> : null;
  const cellKey =
    resolution.kind === "cell" ? drawableCellKey(resolution.ref, status) : null;
  if (cellKey) {
    const identity: Omit<ModuleFrameIdentity, "typeKey"> =
      subject.kind === "view"
        ? { viewId: subject.viewId }
        : { entityId: subject.entityId, profileSlug: subject.profileSlug };
    const fallbackNode = own(false);
    return (
      <div className="flex flex-col gap-3">
        {partly}
        <CellByKey
          cellKey={cellKey}
          identity={identity}
          workspaceId={workspaceId}
          title={title}
          fill={fill}
          fallback={fallbackNode}
          footer={drawnFooter}
          subject={words}
          {...(record ? { cover: fallbackNode } : {})}
        />
      </div>
    );
  }
  const node = own(!status.bundle);
  if (!partly) return <>{node}</>;
  return (
    <div className="flex flex-col gap-3">
      {partly}
      {node}
    </div>
  );
}
