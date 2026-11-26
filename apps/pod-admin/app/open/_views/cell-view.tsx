"use client";

/**
 * `/open/cell/:key` — one cell, addressed by its type KEY (`cell:<pkg>:<name>`,
 * `generated:<slug>`), read on the viewer's own floor (`widgetDefinitions.get`).
 *
 *   a module cell (a React component, stored `frame`)
 *                 RUNS under the header, filling the card, in the module
 *                 frame on the pod's renderer bundle (`ModuleCell`): loading,
 *                 failed, not installed and refused are its own states
 *   an HTML page  RUNS in the page frame (`HtmlFrame`), as in a document
 *                 (one too large to run is handed to the app)
 *   anything else (a built-in or an app's cell)
 *                 named, and handed to the app
 *
 * Not visible to the reader, or gone: the pod answers `null` for both, and
 * the page says it could not be found. A failed read is a failure, never
 * "not found".
 */

import { cellKeyName } from "@synap-core/types/renderables";
import { humanizeToken, resolveObjectNoun } from "@synap-core/types/vocabulary";
import { trpc } from "../../../lib/trpc";
import { OpenFailure, OpenLoading, OpenObject } from "../open-shell";
import { loadFailure, notFound } from "../../_lib/object/load-failure";
import { useReauthOnUnauthorized } from "../../_lib/object/use-reauth";
import { OpenInAppLink } from "../../_lib/object/open-in-app-link";
import {
  cellEmbedRead,
  moduleCellSource,
} from "../../_lib/object/content/markdown-model";
import { ModuleCell } from "../../_lib/object/content/rendered-object";
import { HtmlFrame } from "../../_lib/object/content/html-frame";
import { openT } from "../copy";

type CellRow = { name?: unknown; description?: unknown };

/** The cell's name: its own, else the words of its key, else the noun. */
export function cellTitle(
  key: string,
  row: CellRow | null | undefined
): string {
  const name = typeof row?.name === "string" ? row.name.trim() : "";
  if (name) return name;
  const keyName = cellKeyName(key);
  return keyName ? humanizeToken(keyName) : resolveObjectNoun("cell");
}

export function CellView({ id: key }: { id: string }) {
  const query = trpc.widgetDefinitions.get.useQuery(
    { typeKey: key },
    { retry: false }
  );
  useReauthOnUnauthorized(query.error);

  const noun = resolveObjectNoun("cell");
  if (query.isLoading) return <OpenLoading />;
  const fail = loadFailure(query.error, noun);
  if (fail) return <OpenFailure kind="cell" id={key} failure={fail} />;
  if (!query.data) {
    return <OpenFailure kind="cell" id={key} failure={notFound(noun)} />;
  }

  const row = query.data as CellRow;
  const title = cellTitle(key, row);
  const openInApp = <OpenInAppLink type="cell" id={key} />;
  const source = moduleCellSource(query.data);
  const read = cellEmbedRead({
    isLoading: false,
    error: null,
    data: query.data,
  });
  // A page too large to run is handed to the app, like any cell this page
  // cannot draw.
  const page = read.state === "page" && !read.tooLarge ? read : null;
  const description =
    typeof row.description === "string" && row.description.trim()
      ? row.description.trim()
      : null;

  const t = openT();
  if (!source && !page) {
    // Neither a module nor a page: a cell only the app draws.
    return (
      <OpenObject
        header={{
          kind: "cell",
          title,
          summary: t("bounce.inApp"),
          status: { kind: "unknown", label: t("bounce.noWebPage") },
          primaryAction: openInApp,
        }}
        advanced={{ ids: [{ label: t("cell.keyLabel"), value: key }] }}
      />
    );
  }

  return (
    <OpenObject
      width="lg"
      header={{
        kind: "cell",
        title,
        summary: description,
        secondaryActions: openInApp,
      }}
      advanced={{ ids: [{ label: t("cell.keyLabel"), value: key }] }}
    >
      {source ? (
        <ModuleCell
          source={source}
          identity={{ typeKey: key }}
          title={title}
          fill
          door={openInApp}
        />
      ) : page ? (
        <HtmlFrame
          html={page.html}
          workspaceId={page.workspaceId}
          title={title}
          surface={{ kind: "cell", typeKey: key }}
          refusedAction={openInApp}
        />
      ) : null}
    </OpenObject>
  );
}
