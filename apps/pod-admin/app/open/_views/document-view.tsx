"use client";

/**
 * `/open/document/:id` — one document, read-only: its name, where it lives,
 * and its body drawn by the console's one content renderer. Writing stays in
 * the app.
 *
 * Read door: `documents.get({ format: "readable" })`, the viewer's own floor
 * (owner, space member, a share). A document the viewer cannot read is
 * today's named card (`BounceView`) — the same card any other app-only kind
 * gets, as is a pdf or Word file — and never an admin read: a pod admin sees what the pod would show
 * them, not more.
 */

import { trpc } from "../../../lib/trpc";
import { formatRelative, humanizeBytes } from "../../../lib/format";
import { DocumentContentSection } from "../../_lib/object/content/content-block";
import { documentContent } from "../../_lib/object/content/document-model";
import { couldNotLoad, loadFailure } from "../../_lib/object/load-failure";
import { OpenInAppLink } from "../../_lib/object/open-in-app-link";
import { useReauthOnUnauthorized } from "../../_lib/object/use-reauth";
import { OpenFailure, OpenLoading, OpenObject } from "../open-shell";
import { BounceView } from "./bounce-view";

/** The stored type, as a reader calls it. */
const TYPE_LABEL: Record<string, string> = {
  markdown: "Text document",
  text: "Plain text",
  code: "Code",
  html: "Web page source",
  pdf: "PDF",
  docx: "Word document",
};

export function DocumentView({ id }: { id: string }) {
  const query = trpc.documents.get.useQuery(
    { documentId: id, format: "readable" },
    { retry: false }
  );
  const workspaceId = query.data?.document.workspaceId ?? null;
  // The one space-name door a member holds too (same as the named card).
  const spaces = trpc.workspaces.list.useQuery(undefined, {
    enabled: Boolean(workspaceId),
    retry: false,
  });
  useReauthOnUnauthorized(query.error);

  if (query.isLoading) return <OpenLoading label="Loading document…" />;
  const content = documentContent(query.error, query.data);
  // Not visible, or a pdf / Word file the readable door has no text for: the
  // named card, which still says what it is when the reader may know.
  if (content.kind === "hidden" || content.kind === "file") {
    return <BounceView type="document" id={id} viewerIsPodAdmin={false} />;
  }
  const doc = query.data?.document;
  const fail = loadFailure(query.error, "Document");
  if (fail || !doc) {
    return (
      <OpenFailure
        kind="document"
        id={id}
        failure={fail ?? couldNotLoad("Document")}
      />
    );
  }

  const spaceName = workspaceId
    ? (spaces.data ?? []).find((row) => row.id === workspaceId)?.name
    : undefined;
  const openInApp = <OpenInAppLink type="document" id={id} />;
  return (
    <OpenObject
      header={{
        kind: "document",
        title: doc.title?.trim() || "Untitled document",
        summary: query.data?.canEdit
          ? "You can read it here. Edit it in the Synap app."
          : "You can read it here.",
        primaryAction: openInApp,
      }}
      facts={[
        ...(spaceName ? [{ label: "Space", value: spaceName }] : []),
        ...(doc.updatedAt
          ? [{ label: "Updated", value: formatRelative(doc.updatedAt) }]
          : []),
        { label: "Kind", value: TYPE_LABEL[doc.type] ?? "Document" },
        ...(doc.size > 0
          ? [{ label: "Size", value: humanizeBytes(doc.size) }]
          : []),
      ]}
      advanced={{
        ids: [
          { label: "Document id", value: doc.id },
          ...(workspaceId ? [{ label: "Space id", value: workspaceId }] : []),
        ],
      }}
    >
      <DocumentContentSection
        title="Content"
        content={content}
        openInApp={openInApp}
      />
    </OpenObject>
  );
}
