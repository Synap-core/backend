"use client";

/**
 * `SectionCard` — the dashboard card shape used in Overview and reused
 * throughout the shell.
 *
 *   bg-foreground/[0.04]
 *   ring-1 ring-inset ring-foreground/10
 *   radius="lg"  (16 — pane 24 - 8 = 16, concentric ✓)
 *   shadow="none"
 *
 * Title slot + content slot. Optional right-side header slot for actions
 * (e.g. a refresh button or a deep-link "View all").
 *
 * `variant="flat"` is the same title, hint and actions without the card:
 * for a section of an object page whose body already draws its own framed
 * rows (an app's people and keys), where a card around them would nest. Its
 * hint wraps — there it is a sentence, not a caption.
 *
 * `count` is how many the section lists. It sits in the title row, after the
 * words (decision 488216a3). A hint stays under the title: it is a sentence,
 * never the tally.
 */

import { Card, CardBody, CardHeader } from "@heroui/react";
import type { ReactNode } from "react";
import { sectionCountLabel } from "./section-count";

interface SectionCardProps {
  title: string;
  /** A sentence under the title. Not a tally — pass `count` for how many. */
  hint?: ReactNode;
  /**
   * How many this section lists. Drawn after the title; 0 and an unmeasured
   * count draw nothing.
   */
  count?: number | null;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  variant?: "card" | "flat";
}

function SectionHeading({
  title,
  count,
  truncate = false,
}: {
  title: string;
  count?: number | null;
  truncate?: boolean;
}) {
  const label = sectionCountLabel(count);
  if (!label) {
    return (
      <h3
        className={`text-[14px] font-medium tracking-tight text-foreground${
          truncate ? " truncate" : ""
        }`}
      >
        {title}
      </h3>
    );
  }
  return (
    <h3 className="flex min-w-0 items-baseline gap-1.5 text-[14px] font-medium tracking-tight text-foreground">
      <span className="min-w-0 truncate">{title}</span>
      <span className="shrink-0 text-[13px] tabular-nums text-foreground/45">
        {label}
      </span>
    </h3>
  );
}

export function SectionCard({
  title,
  hint,
  count,
  actions,
  children,
  className,
  variant = "card",
}: SectionCardProps) {
  if (variant === "flat") {
    return (
      <section
        aria-label={title}
        className={`flex flex-col gap-2 ${className ?? ""}`}
      >
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <SectionHeading title={title} count={count} />
            {hint && (
              <p className="max-w-2xl text-[12.5px] leading-5 text-foreground/65">
                {hint}
              </p>
            )}
          </div>
          {actions && (
            <div className="flex shrink-0 items-center gap-1">{actions}</div>
          )}
        </div>
        {children}
      </section>
    );
  }
  return (
    <Card
      radius="lg"
      shadow="none"
      className={[
        "bg-foreground/[0.04]",
        "ring-1 ring-inset ring-foreground/10",
        "transition-colors",
        className ?? "",
      ].join(" ")}
    >
      {/* The title keeps at least 10rem: on a narrow card the actions wrap
          under it instead of squeezing it to an ellipsis. */}
      <CardHeader className="flex flex-wrap items-baseline justify-between gap-3 px-5 pt-4 pb-2">
        <div className="flex min-w-0 flex-1 basis-40 flex-col gap-0.5">
          <SectionHeading title={title} count={count} truncate />
          {hint && (
            <p className="text-[11.5px] text-foreground/65 truncate">{hint}</p>
          )}
        </div>
        {actions && (
          <div className="flex max-w-full items-center gap-1">{actions}</div>
        )}
      </CardHeader>
      <CardBody className="px-5 pb-5 pt-0">{children}</CardBody>
    </Card>
  );
}
