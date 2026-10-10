"use client";

import { Chip } from "@heroui/react";
import { AlertTriangle, Clock, ShieldCheck } from "lucide-react";
import type { PendingAccessView } from "./pending-access";

/** What a pending key would be allowed to do: one sentence per grant, its expiry. */
export function PendingAccessBlock({ view }: { view: PendingAccessView }) {
  return (
    <div className="flex flex-col gap-2">
      {view.fullLabel ? (
        <Chip
          color="danger"
          variant="flat"
          size="sm"
          startContent={<AlertTriangle className="ml-1 h-3.5 w-3.5" />}
        >
          {view.fullLabel}
        </Chip>
      ) : null}
      {view.lines.map((line, i) => (
        <p
          key={i}
          className="flex items-start gap-1.5 text-small text-foreground/85"
        >
          <ShieldCheck
            aria-hidden
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground/65"
          />
          <span>{line}</span>
        </p>
      ))}
      <p
        className={`flex items-center gap-1.5 text-tiny ${
          view.expired ? "text-danger" : "text-foreground/65"
        }`}
      >
        <Clock aria-hidden className="h-3.5 w-3.5 shrink-0" />
        {view.when}
      </p>
      {view.scopeLabels.length > 0 ? (
        <details className="text-tiny text-foreground/65">
          <summary className="cursor-pointer select-none">
            Technical details
          </summary>
          <p className="pt-1">Scopes: {view.scopeLabels.join(", ")}</p>
        </details>
      ) : null}
    </div>
  );
}
