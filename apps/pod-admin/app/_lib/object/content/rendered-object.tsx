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
 *   loading        a skeleton in the frame's shape ("Drawing this view…")
 *   failed         `ResourceRowError` with Try again; a resolution that
 *                  only partly read (`readFailed`) says so too
 *   not installed  the page's identity card and its "Open in app" (an
 *                  explicit cell also says "Synap's renderers aren't on
 *                  this pod.")
 *   refused        the cell needs the network or a module the bundle lacks
 *                  (`ModuleFrame`'s own state)
 *   managed-only   the bundle is offered only to pods Synap hosts
 */

import { useMemo, type ReactNode } from "react";
import type { RendererSubject } from "@synap-core/types/renderer-resolution";
import { trpc } from "../../../../lib/trpc";
import { ResourceRowError } from "../../../(admin)/components/resource-row";
import { StatusPill } from "../../../(admin)/components/status-pill";
import { frameT } from "./frame-copy";
import {
  HIDDEN_CODES,
  moduleCellSource,
  type ModuleCellSource,
} from "./markdown-model";
import { ModuleFrame, type ModuleFrameIdentity } from "./module-frame";
import { useHostModules } from "./use-host-modules";
import { useObjectRenderer, type RenderersStatus } from "./use-object-renderer";

/** The loading state, in the frame's shape. */
export function RendererSkeleton({ fill = false }: { fill?: boolean }) {
  const t = frameT();
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t("renderer.loading")}
      className={`w-full rounded-lg bg-foreground/[0.05] shimmer-pulse ${fill ? "h-[min(80vh,900px)] min-h-[420px]" : "h-40"}`}
    />
  );
}

export type RendererNoticeKind = "notInstalled" | "managedOnly";

/**
 * Why Synap's renderers are not drawing here: not installed on this pod, or
 * offered only to pods Synap hosts (an install refused with the reason code
 * `renderer_bundle_managed_only`). A mark and one line, beside the door.
 */
export function RendererNotice({
  kind,
  action,
}: {
  kind: RendererNoticeKind;
  action?: ReactNode;
}) {
  const t = frameT();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-content2 px-3 py-2">
      <StatusPill kind="unknown" label={t("renderer.refused.mark")} />
      <p className="text-small text-foreground/85">
        {kind === "managedOnly"
          ? t("renderer.managedOnly")
          : t("renderer.notInstalled")}
      </p>
      {action}
    </div>
  );
}

/** The install refusal's reason code → its notice, or null for any other. */
export function rendererNoticeFor(
  reasonCode: string | null | undefined
): RendererNoticeKind | null {
  if (reasonCode === "renderer_bundle_managed_only") return "managedOnly";
  if (reasonCode === "renderer_bundle_no_control_plane") return "notInstalled";
  return null;
}

/** A module cell's source + the bundle's host modules → the running frame. */
export function ModuleCell({
  source,
  identity,
  workspaceId,
  title,
  fill = false,
  door,
}: {
  source: ModuleCellSource;
  identity: ModuleFrameIdentity;
  /** The host's lens; the cell's own space when omitted. */
  workspaceId?: string | null;
  title: string;
  fill?: boolean;
  /** The host's door beside a cell that does not run (its page, the app). */
  door?: ReactNode;
}) {
  const modules = useHostModules();
  const t = frameT();
  switch (modules.state) {
    case "loading":
      return <RendererSkeleton fill={fill} />;
    case "failed":
      return (
        <ResourceRowError
          message={t("renderer.failed")}
          onRetry={modules.retry}
        />
      );
    case "none":
      return <RendererNotice kind="notInstalled" action={door} />;
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
}: {
  cellKey: string;
  identity: Omit<ModuleFrameIdentity, "typeKey">;
  workspaceId: string | null;
  title: string;
  fill?: boolean;
  fallback: ReactNode;
  /** Under the cell when it runs (the object's own "Open in app"). */
  footer?: ReactNode;
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
      <ResourceRowError
        message={t("renderer.failed")}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (query.isLoading) return <RendererSkeleton fill={fill} />;
  if (!source) return <>{fallback}</>;
  return (
    <div className="flex flex-col gap-2">
      <ModuleCell
        source={source}
        identity={{ ...identity, typeKey: cellKey }}
        workspaceId={workspaceId}
        title={title}
        fill={fill}
      />
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
 * An object drawn by whichever renderer the one resolution picks, else the
 * page's own `fallback` (its identity card). `notInstalledNote` says so when
 * no bundle is on the pod (a view, which only a renderer can draw).
 */
export function RenderedObject({
  subject,
  workspaceId,
  title,
  fill,
  fallback,
  notInstalledNote = false,
  drawnFooter,
}: {
  subject: RendererSubject;
  workspaceId: string | null;
  title: string;
  fill?: boolean;
  fallback: ReactNode;
  notInstalledNote?: boolean;
  /** Under a drawn cell (the object's own "Open in app"). */
  drawnFooter?: ReactNode;
}) {
  const state = useObjectRenderer(subject, { workspaceId });
  const t = frameT();
  if (state.state === "loading") return <RendererSkeleton fill={fill} />;
  if (state.state === "failed") {
    return (
      <div className="flex flex-col gap-3">
        <ResourceRowError
          message={t("renderer.failed")}
          onRetry={state.retry}
        />
        {fallback}
      </div>
    );
  }
  const { resolution, status } = state;
  const partly = resolution.readFailed ? (
    <ResourceRowError message={t("renderer.failed")} onRetry={state.retry} />
  ) : null;
  const cellKey =
    resolution.kind === "cell" ? drawableCellKey(resolution.ref, status) : null;
  if (cellKey) {
    const identity: Omit<ModuleFrameIdentity, "typeKey"> =
      subject.kind === "view"
        ? { viewId: subject.viewId }
        : { entityId: subject.entityId, profileSlug: subject.profileSlug };
    return (
      <div className="flex flex-col gap-3">
        {partly}
        <CellByKey
          cellKey={cellKey}
          identity={identity}
          workspaceId={workspaceId}
          title={title}
          fill={fill}
          fallback={fallback}
          footer={drawnFooter}
        />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {partly}
      {notInstalledNote && !status.bundle && (
        <RendererNotice kind="notInstalled" />
      )}
      {fallback}
    </div>
  );
}
