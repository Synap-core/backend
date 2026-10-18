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
 */

import { Card, CardBody, CardHeader } from "@heroui/react";
import type { ReactNode } from "react";

interface SectionCardProps {
  title: string;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  variant?: "card" | "flat";
}

export function SectionCard({
  title,
  hint,
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
            <h3 className="text-[14px] font-medium tracking-tight text-foreground">
              {title}
            </h3>
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
      <CardHeader className="flex items-baseline justify-between gap-3 px-5 pt-4 pb-2">
        <div className="flex flex-col gap-0.5 min-w-0">
          <h3 className="text-[14px] font-medium tracking-tight text-foreground truncate">
            {title}
          </h3>
          {hint && (
            <p className="text-[11.5px] text-foreground/65 truncate">{hint}</p>
          )}
        </div>
        {actions && (
          <div className="flex items-center gap-1 shrink-0">{actions}</div>
        )}
      </CardHeader>
      <CardBody className="px-5 pb-5 pt-0">{children}</CardBody>
    </Card>
  );
}
