"use client";

/**
 * `/open/view/:id` — a saved view. When a renderer cell draws its type (the
 * view's own bound cell, else the installed bundle's default for its type,
 * picked by the one resolution in `RenderedObject`), the view itself runs in
 * the full-window reader (`OpenReader`, View template: fill): a slim bar with
 * its title, Share, "Open in app" and ⋯ (its facts and Advanced), and the
 * module frame filling the rest of the window. Otherwise this
 * page says which view it is and hands it to the app in ONE card; a pod
 * admin also reads there, in one line, that the renderers are not on this
 * pod. `views.get` re-checks access server-side; the frame reads through
 * the same floored doors.
 */

import { humanizeToken } from "@synap-core/types/vocabulary";
import { trpc } from "../../../lib/trpc";
import { formatRelative } from "../../../lib/format";
import { shortDescription } from "../../_lib/object/object-summaries";
import { OpenFailure, OpenLoading, OpenObject } from "../open-shell";
import { couldNotLoad, loadFailure } from "../../_lib/object/load-failure";
import type { ObjectCrumb } from "../../_lib/object/object-header";
import { useReauthOnUnauthorized } from "../../_lib/object/use-reauth";
import { HandoffCard } from "../../(admin)/components/handoff-card";
import { openIn } from "../../../lib/open-in";
import { openT } from "../copy";
import { describeView, viewKind } from "./view-summary";
import { ViewPipelineSnapshot } from "./view-pipeline-snapshot";
import {
  RenderedObject,
  useDrawsCell,
} from "../../_lib/object/content/rendered-object";
import { frameT } from "../../_lib/object/content/frame-copy";
import { OpenInAppLink } from "../../_lib/object/open-in-app-link";
import { useConsoleRole } from "../../(admin)/components/side-nav-role";
import { readerLayout } from "../reader-model";

/** Canvas lenses have no prose description worth showing on the web. */
const CANVAS_VIEW_TYPES = new Set(["whiteboard", "mindmap"]);

type ViewPayload = {
  view?: {
    id?: string;
    name?: string | null;
    type?: string | null;
    description?: string | null;
    workspaceId?: string | null;
    updatedAt?: Date | string | null;
    config?: unknown;
  };
};

/** The view's `config.render` (its bound renderer, read by the resolution only). */
function viewRender(config: unknown): unknown {
  return config && typeof config === "object"
    ? (config as { render?: unknown }).render
    : undefined;
}

export function ViewView({
  id,
  breadcrumb,
}: {
  id: string;
  /** The trail back, when this view opened on an object (`?surface=`). */
  breadcrumb?: ObjectCrumb[];
}) {
  const query = trpc.views.get.useQuery({ id });
  useReauthOnUnauthorized(query.error);
  const loaded = (query.data as ViewPayload | undefined)?.view;
  const subject = {
    kind: "view" as const,
    viewId: loaded?.id ?? id,
    viewType: loaded?.type?.trim() ?? "",
    render: viewRender(loaded?.config),
  };
  // Whether a renderer draws it decides what sits around the drawing.
  const drawn = useDrawsCell(subject, loaded?.workspaceId ?? null);
  const isPodAdmin = useConsoleRole() === "admin";

  if (query.isLoading) return <OpenLoading label="Loading view…" />;
  const data = query.data as ViewPayload | undefined;
  const fail = loadFailure(query.error, "View");
  if (fail || !data?.view) {
    return (
      <OpenFailure
        kind="view"
        id={id}
        failure={fail ?? couldNotLoad("View")}
        breadcrumb={breadcrumb}
      />
    );
  }

  const view = data.view;
  const t = openT();
  const lens = view.type?.trim() || null;
  const canvas = lens ? CANVAS_VIEW_TYPES.has(lens) : false;
  // A written description wins; a generated view has none, so the page says
  // what the view is from its own layout and config (never an empty card).
  const written = canvas ? null : shortDescription(view.description);
  // Only a pipeline gets a snapshot: its content is a kind's declared flow,
  // which `flow.of` reads. Every other layout is handed over, never half-drawn.
  const snapshotKind = lens === "pipeline" ? viewKind(view.config) : null;
  const title = view.name?.trim() || t("view.untitled");
  const identity = (notInstalled: boolean) => (
    <div className="flex flex-col gap-4">
      {snapshotKind && (
        <ViewPipelineSnapshot
          kind={snapshotKind}
          workspaceId={view.workspaceId ?? null}
        />
      )}
      <HandoffCard
        title={t("view.handoff.title")}
        body={
          snapshotKind ? t("view.handoff.bodySnapshot") : t("view.handoff.body")
        }
        exit={openIn({ kind: "objectInApp", objectKind: "view", id })}
        cta={t("view.handoff.cta")}
        {...(notInstalled && isPodAdmin
          ? { note: frameT()("renderer.notInstalled") }
          : {})}
      />
    </div>
  );
  return (
    <OpenObject
      width="auto"
      // Drawn by a renderer: the view reads in the whole window, full width
      // (`readerLayout`); handed to the app, it keeps its card.
      reader={readerLayout("view", { drawn })}
      header={{
        kind: "view",
        title,
        breadcrumb,
        summary: written ?? describeView(view, t),
        ...(drawn
          ? { secondaryActions: <OpenInAppLink type="view" id={id} /> }
          : {}),
      }}
      facts={[
        ...(lens ? [{ label: "Layout", value: humanizeToken(lens) }] : []),
        ...(view.updatedAt
          ? [{ label: "Updated", value: formatRelative(view.updatedAt) }]
          : []),
      ]}
      advanced={{
        ids: [
          { label: "View id", value: view.id ?? id },
          ...(view.workspaceId
            ? [{ label: "Space id", value: view.workspaceId }]
            : []),
        ],
      }}
    >
      <RenderedObject
        subject={subject}
        workspaceId={view.workspaceId ?? null}
        title={title}
        fill
        fallback={({ notInstalled }) => identity(notInstalled)}
      />
    </OpenObject>
  );
}
