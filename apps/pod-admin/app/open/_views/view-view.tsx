"use client";

/**
 * `/open/view/:id` — a saved view's identity card. The view itself (a table,
 * a board, a canvas) renders in the app; this page says which view it is and
 * hands it over. `views.get` re-checks access server-side.
 */

import { humanizeToken } from "@synap-core/types/vocabulary";
import { trpc } from "../../../lib/trpc";
import { formatRelative } from "../../../lib/format";
import { couldNotLoad, loadFailure, shortDescription } from "../open-model";
import {
  OpenFailure,
  OpenInAppLink,
  OpenLoading,
  OpenObject,
} from "../open-shell";
import { useReauthOnUnauthorized } from "./use-reauth";

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
  };
};

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
  const lens = view.type?.trim() || null;
  const canvas = lens ? CANVAS_VIEW_TYPES.has(lens) : false;
  return (
    <OpenObject
      header={{
        kind: "view",
        title: view.name?.trim() || "Untitled view",
        summary: canvas
          ? "This view opens in the Synap app."
          : shortDescription(view.description),
        primaryAction: <OpenInAppLink type="view" id={id} />,
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
    />
  );
}
