"use client";

/**
 * "Surfaces": the screens one object carries: the views,
 * bentos, boards, documents, HTML artifacts and cells attached to it, pinned
 * to it or made by it, read from `surfaces.forObject`, the one find door.
 * Each is a DOOR: an attached surface opens this page on it
 * (`?surface=<id>`), any other its own page; a row that opens nowhere here is
 * not listed. Never drawn here: a surface's body comes from its own page (the
 * renderer bundle or the view's page).
 *
 * OMIT when there is nothing, and draw nothing while the read is in flight
 * (most records carry no surface: a card that appears and vanishes would push
 * the page around). A failed read, or a read where a store failed and nothing
 * came back, is the failed state with its retry, never "nothing"; a store that
 * failed beside listed rows is one line under them, with its retry.
 *
 * Each row has a ⋯ menu: Copy link, and Detach for an attachment
 * (`surfaces-row-actions`), confirmed first: the surface itself stays.
 */

import { useState } from "react";
import Link from "next/link";
import { Button } from "@heroui/react";
import { resolveActionLabel } from "@synap-core/types/vocabulary";
import type {
  SurfaceAnchor,
  SurfacesForObject,
} from "@synap-core/types/surfaces";
import { ambientCatalogLocale } from "@synap-core/types/i18n";
import { trpc } from "../../../lib/trpc";
import { ResourceRowError } from "../../(admin)/components/resource-row";
import { SectionCard } from "../../(admin)/components/section-card";
import { ConfirmModal } from "../../(admin)/components/confirm-modal";
import { openT } from "../../open/copy";
import { kindIcon } from "./kind-icon";
import { objectPage } from "./content/markdown-model";
import {
  SURFACES_CAP,
  surfaceListRows,
  type SurfaceListRow,
} from "./surfaces-model";
import { SurfaceRowMenu, useSurfaceRowActions } from "./surfaces-row-actions";

// Focus: the one recipe (an outline in `--synap-focus-ring`, HeroUI `focus`).
const DOOR =
  "inline-flex min-w-0 items-center gap-1.5 rounded-sm text-[13px] [overflow-wrap:anywhere] text-foreground/80 underline decoration-foreground/25 underline-offset-2 hover:text-foreground hover:decoration-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

export function SurfacesSection({ anchor }: { anchor: SurfaceAnchor }) {
  const t = openT();
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState<SurfaceListRow | null>(null);
  const actions = useSurfaceRowActions(anchor);
  const query = trpc.surfaces.forObject.useQuery(
    { kind: anchor.kind, id: anchor.id },
    { retry: false }
  );
  const nameOf = (row: SurfaceListRow) => row.title || t("surfaces.untitled");

  // In flight: nothing yet (OMIT until known, so the page does not jump).
  if (query.isLoading) return null;

  const answer = query.data as SurfacesForObject | undefined;
  const rows = answer
    ? surfaceListRows(answer.rows, anchor, objectPage, ambientCatalogLocale())
    : [];
  const partial = (answer?.unavailable.length ?? 0) > 0;
  // Nothing came back and a store (or the whole read) failed: that is a
  // failed read, never an empty or "short" list.
  if (query.isError || !answer || (rows.length === 0 && partial)) {
    return (
      <SectionCard variant="flat" title={t("surfaces.title")}>
        <ResourceRowError
          message={t("surfaces.failed")}
          onRetry={() => void query.refetch()}
        />
      </SectionCard>
    );
  }
  if (rows.length === 0) return null;
  const shown = expanded ? rows : rows.slice(0, SURFACES_CAP);

  return (
    <SectionCard variant="flat" title={t("surfaces.title")}>
      <ul className="flex flex-col gap-0.5" data-testid="surfaces-list">
        {shown.map((row) => {
          const Icon = kindIcon(row.kind);
          const name = nameOf(row);
          return (
            <li
              key={row.key}
              className="flex min-h-6 min-w-0 items-center gap-2 py-0.5"
            >
              <Icon aria-hidden className="h-4 w-4 shrink-0 text-default-500" />
              {row.href ? (
                <Link href={row.href} className={DOOR}>
                  {name}
                </Link>
              ) : (
                <a
                  href={row.external ?? undefined}
                  target="_blank"
                  rel="noreferrer noopener"
                  className={DOOR}
                >
                  {name}
                </a>
              )}
              <span className="shrink-0 text-[12px] text-default-500">
                {row.label}
              </span>
              <span className="ml-auto shrink-0">
                <SurfaceRowMenu
                  row={row}
                  title={name}
                  onCopyLink={() => void actions.copyLink(row)}
                  onDetach={() => setConfirming(row)}
                />
              </span>
            </li>
          );
        })}
      </ul>
      {rows.length > SURFACES_CAP && (
        <Button
          size="sm"
          variant="light"
          className="mt-1 self-start"
          aria-expanded={expanded}
          onPress={() => setExpanded((v) => !v)}
        >
          {expanded
            ? t("surfaces.showLess")
            : t("surfaces.showAll", { n: rows.length })}
        </Button>
      )}
      {partial && (
        <p
          role="status"
          className="mt-1 flex flex-wrap items-center gap-2 text-[12.5px] text-status-down"
        >
          <span>{t("surfaces.partial")}</span>
          <Button
            size="sm"
            variant="light"
            radius="md"
            onPress={() => void query.refetch()}
          >
            {t("surfaces.retry")}
          </Button>
        </p>
      )}
      <ConfirmModal
        isOpen={confirming !== null}
        onClose={() => setConfirming(null)}
        onConfirm={() => {
          if (!confirming) return;
          actions.detach(confirming, nameOf(confirming), () =>
            setConfirming(null)
          );
        }}
        title={t("surfaces.detach.title", {
          title: confirming ? nameOf(confirming) : "",
        })}
        consequence={t("surfaces.detach.consequence")}
        confirmLabel={resolveActionLabel(
          "detach",
          "imperative",
          ambientCatalogLocale()
        )}
        isPending={confirming !== null && actions.detaching === confirming.key}
      />
    </SectionCard>
  );
}
