"use client";

/**
 * MADE — what an applied proposal landed, one row per object (`madeRows`
 * over the read's `landed`): its name, what approving did, a door to it, its
 * next step's mark and its ONE act (Turn on, or a door to where the step is
 * taken). The objects that still need the person come first. Omitted when
 * nothing landed that the reader may see.
 */

import { useState } from "react";
import { resolveActionLabel } from "@synap-core/types/vocabulary";
import { ResourceRow } from "../../(admin)/components/resource-row";
import { SectionCard } from "../../(admin)/components/section-card";
import { kindIcon } from "../../_lib/object/kind-icon";
import { NextStepAction } from "../../_lib/object/next-step";
import { objectViewsT } from "../../_lib/object/views/copy";
import { ExitLink } from "../../../lib/exit-link";
import { openIn } from "../../../lib/open-in";
import { madeRows, type LandedInput } from "./proposal-review-model";

const SHOWN = 5;

export function MadeSection({
  landed,
}: {
  landed: readonly LandedInput[] | undefined;
}) {
  const [all, setAll] = useState(false);
  const rows = madeRows(landed);
  if (rows.length === 0) return null;
  const t = objectViewsT();
  const shown = all ? rows : rows.slice(0, SHOWN);
  return (
    <SectionCard variant="flat" title={t("made.title")} count={rows.length}>
      <div
        data-made=""
        className="-mx-3 flex flex-col divide-y divide-foreground/[0.05]"
      >
        {shown.map((row) => (
          <div key={`${row.kind}:${row.id}`} data-made-object={row.id}>
            <ResourceRow
              wrap
              Icon={kindIcon(row.kind)}
              primary={row.title}
              secondary={
                <span className="inline-flex items-center gap-x-3">
                  <span>{row.done}</span>
                  <ExitLink
                    exit={openIn({
                      kind: "object",
                      objectKind: row.kind,
                      id: row.id,
                    })}
                    label={resolveActionLabel("open", "imperative")}
                  />
                </span>
              }
              status={row.step?.pill}
              actions={
                row.step ? <NextStepAction step={row.step} /> : undefined
              }
            />
          </div>
        ))}
      </div>
      {!all && rows.length > SHOWN && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="self-start text-[13px] text-foreground/80 underline decoration-foreground/25 underline-offset-2 hover:text-foreground"
        >
          {t("made.showAll", { n: rows.length })}
        </button>
      )}
    </SectionCard>
  );
}
