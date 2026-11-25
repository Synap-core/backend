"use client";

/**
 * WHAT IT MADE: each object an applied proposal landed (`madeRows` over the
 * read's `landed`), its name, what approving did, a door to it, the mark of
 * its next step and at most one act (`NextStepAction`). The objects that need
 * the person come first. Omitted when nothing landed that the reader may see.
 */

import { useEffect, useRef, useState } from "react";
import { resolveActionLabel } from "@synap-core/types/vocabulary";
import { ResourceRow } from "../../(admin)/components/resource-row";
import { SectionCard } from "../../(admin)/components/section-card";
import { kindIcon } from "../../_lib/object/kind-icon";
import { NextStepAction } from "../../_lib/object/next-step";
import { ExitLink } from "../../../lib/exit-link";
import { openIn } from "../../../lib/open-in";
import { proposalPageT } from "./copy";
import { madeRows, type LandedInput } from "./proposal-review-model";

const SHOWN = 5;

export function MadeSection({
  landed,
}: {
  landed: readonly LandedInput[] | undefined;
}) {
  const [all, setAll] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The press unmounts "Show all": focus goes to the first row it showed.
    if (all) list.current?.children[SHOWN]?.querySelector("a")?.focus();
  }, [all]);
  const rows = madeRows(landed);
  if (rows.length === 0) return null;
  const t = proposalPageT();
  const shown = all ? rows : rows.slice(0, SHOWN);
  return (
    <SectionCard variant="flat" title={t("made.title")} count={rows.length}>
      <div
        ref={list}
        data-made=""
        className="-mx-3 flex flex-col divide-y divide-foreground/[0.05]"
      >
        {shown.map((row) => (
          <div key={`${row.openKind}:${row.id}`} data-made-object={row.id}>
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
                      objectKind: row.openKind,
                      id: row.id,
                    })}
                    label={resolveActionLabel("open", "imperative")}
                  />
                </span>
              }
              status={row.step?.pill}
              actions={
                row.step?.act ? (
                  <NextStepAction act={row.step.act} name={row.title} />
                ) : undefined
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
