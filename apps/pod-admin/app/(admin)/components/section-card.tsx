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
 */

import { Card, CardBody, CardHeader } from "@heroui/react";
import type { ReactNode } from "react";

interface SectionCardProps {
  title: string;
  hint?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function SectionCard({
  title,
  hint,
  actions,
  children,
  className,
}: SectionCardProps) {
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
            <p className="text-[11.5px] text-foreground/55 truncate">{hint}</p>
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
