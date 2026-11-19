"use client";

/**
 * `/open/view/:id` — a saved view. When a renderer cell draws its type (the
 * view's own bound cell, else the installed bundle's default for its type,
 * picked by the one resolution in `RenderedObject`), the view itself runs
 * under the header, filling the card, in the module frame. Otherwise this
 * page says which view it is and hands it to the app. `views.get` re-checks
 * access server-side; the frame reads through the same floored doors.
 */

import { humanizeToken } from "@synap-core/types/vocabulary";
import { trpc } from "../../../lib/trpc";
import { formatRelative } from "../../../lib/format";
import { shortDescription } from "../../_lib/object/object-summaries";
import { OpenFailure, OpenLoading, OpenObject } from "../open-shell";
import { couldNotLoad, loadFailure } from "../../_lib/object/load-failure";
import { useReauthOnUnauthorized } from "../../_lib/object/use-reauth";
import { HandoffCard } from "../../(admin)/components/handoff-card";
import { openIn } from "../../../lib/open-in";
import { openT } from "../copy";
import { describeView, viewKind } from "./view-summary";
import { ViewPipelineSnapshot } from "./view-pipeline-snapshot";
import { RenderedObject } from "../../_lib/object/content/rendered-object";
import { OpenInAppLink } from "../../_lib/object/open-in-app-link";

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

export function ViewView({ id }: { id: string }) {
  const query = trpc.views.get.useQuery({ id });
  useReauthOnUnauthorized(query.error);

  if (query.isLoading) return <OpenLoading label="Loading view…" />;
  const data = query.data as ViewPayload | undefined;
  const fail = loadFailure(query.error, "View");
  if (fail || !data?.view) {
    return (
      <OpenFailure kind="view" id={id} failure={fail ?? couldNotLoad("View")} />
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
  const title = view.name?.trim() || "Untitled view";
  const identity = (
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
      />
    </div>
  );
  return (
    <OpenObject
      width="lg"
      header={{
        kind: "view",
        title,
        summary: written ?? describeView(view, t),
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
        subject={{
          kind: "view",
          viewId: view.id ?? id,
          viewType: lens ?? "",
          render: viewRender(view.config),
        }}
        workspaceId={view.workspaceId ?? null}
        title={title}
        fill
        fallback={identity}
        notInstalledNote
        drawnFooter={<OpenInAppLink type="view" id={id} />}
      />
    </OpenObject>
  );
}
