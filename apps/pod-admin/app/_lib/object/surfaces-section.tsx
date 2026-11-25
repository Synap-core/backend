"use client";

/**
 * "Surfaces": the screens one object carries (Surfaces P3) — the views,
 * bentos, boards, documents, HTML artifacts and cells attached to it, pinned
 * to it or made by it — read from `surfaces.forObject`, the one find door.
 * Each is a DOOR: an attached surface opens this page on it
 * (`?surface=<id>`), any other its own page. Never drawn here: a surface's
 * body comes from its own page (the renderer bundle or the view's page).
 *
 * OMIT when there is nothing; a store that could not be read is said, never
 * read as "nothing" (`unavailable`); a failed read keeps its retry.
 */

import { useState } from "react";
import Link from "next/link";
import { Button } from "@heroui/react";
import type {
  SurfaceAnchor,
  SurfacesForObject,
} from "@synap-core/types/surfaces";
import { trpc } from "../../../lib/trpc";
import { ResourceRowError } from "../../(admin)/components/resource-row";
import { SectionCard } from "../../(admin)/components/section-card";
import { openT } from "../../open/copy";
import { kindIcon, kindLabel } from "./kind-icon";
import { objectPage } from "./content/markdown-model";
import { SURFACES_CAP, surfaceListRows } from "./surfaces-model";

const DOOR =
  "inline-flex min-w-0 items-center gap-1.5 rounded-sm text-[13px] [overflow-wrap:anywhere] text-foreground/80 underline decoration-foreground/25 underline-offset-2 hover:text-foreground hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

export function SurfacesSection({ anchor }: { anchor: SurfaceAnchor }) {
  const t = openT();
  const [expanded, setExpanded] = useState(false);
  const query = trpc.surfaces.forObject.useQuery(
    { kind: anchor.kind, id: anchor.id },
    { retry: false }
  );

  if (query.isLoading) {
    return (
      <SectionCard variant="flat" title={t("surfaces.title")}>
        <div
          role="status"
          aria-busy="true"
          aria-label={t("surfaces.loading")}
          className="flex flex-col gap-2"
        >
          <div className="h-4 w-1/3 rounded bg-foreground/[0.07] shimmer-pulse" />
          <div className="h-4 w-1/2 rounded bg-foreground/[0.07] shimmer-pulse" />
        </div>
      </SectionCard>
    );
  }
  if (query.isError || !query.data) {
    return (
      <SectionCard variant="flat" title={t("surfaces.title")}>
        <ResourceRowError
          message={t("surfaces.failed")}
          onRetry={() => void query.refetch()}
        />
      </SectionCard>
    );
  }

  const answer = query.data as SurfacesForObject;
  const rows = surfaceListRows(answer.rows, anchor, objectPage);
  const partial = answer.unavailable.length > 0;
  if (rows.length === 0 && !partial) return null;
  const shown = expanded ? rows : rows.slice(0, SURFACES_CAP);

  return (
    <SectionCard variant="flat" title={t("surfaces.title")}>
      <ul className="flex flex-col gap-0.5" data-testid="surfaces-list">
        {shown.map((row) => {
          const Icon = kindIcon(row.kind);
          const name = row.title || t("surfaces.untitled");
          return (
            <li
              key={row.key}
              className="flex min-h-6 min-w-0 items-center gap-2 py-0.5"
            >
              <Icon
                aria-hidden
                className="h-4 w-4 shrink-0 text-foreground/50"
              />
              {row.href ? (
                <Link href={row.href} className={DOOR}>
                  {name}
                </Link>
              ) : row.external ? (
                <a
                  href={row.external}
                  target="_blank"
                  rel="noreferrer noopener"
                  className={DOOR}
                >
                  {name}
                </a>
              ) : (
                <span className="text-[13px] text-foreground/70 [overflow-wrap:anywhere]">
                  {name}
                </span>
              )}
              <span className="shrink-0 text-[12px] text-foreground/50">
                {kindLabel(row.kind)}
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
          onPress={() => setExpanded((v) => !v)}
        >
          {expanded
            ? t("surfaces.showLess")
            : t("surfaces.showAll", { n: rows.length })}
        </Button>
      )}
      {partial && (
        <p className="mt-1.5 text-[12px] text-foreground/55">
          {t("surfaces.partial")}
        </p>
      )}
    </SectionCard>
  );
}
