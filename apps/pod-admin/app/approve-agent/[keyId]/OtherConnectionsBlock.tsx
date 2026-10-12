"use client";

import { Checkbox, Chip } from "@heroui/react";
import { AlertTriangle, Laptop, RefreshCw } from "lucide-react";
import type { ConnectionRow, ConnectionsView } from "./other-connections";

/**
 * What approving does to the agent's other connections.
 *
 *  - this computer's live connection: listed, marked "Will be replaced"
 *    (no choice — it is the same computer reconnecting);
 *  - every other live connection (another computer, or an older CLI's
 *    unlabelled one): kept, with an "Also disconnect" box, unticked;
 *  - a request with a newer one from the same computer: a banner, and the
 *    page offers no approval (the form disables it).
 *
 * OMIT when there is nothing: no other connection means no section, and an
 * older pod that sends no facts shows none (it cannot say).
 */
export function OtherConnectionsBlock({
  view,
  chosen,
  onChosen,
  isDisabled,
}: {
  view: ConnectionsView;
  chosen: string[];
  onChosen: (ids: string[]) => void;
  isDisabled?: boolean;
}) {
  return (
    <>
      {view.superseded && (
        <div
          role="status"
          className="flex items-start gap-2.5 rounded-lg bg-warning/10 px-3.5 py-3 ring-1 ring-inset ring-warning/30"
        >
          <AlertTriangle
            aria-hidden
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning"
            strokeWidth={2.2}
          />
          <p className="text-small text-foreground">
            A newer request from this computer is waiting — approve that one.
            This request expires when it is.
          </p>
        </div>
      )}

      {!view.superseded &&
        view.known &&
        (view.replaced.length > 0 || view.others.length > 0) && (
          <section className="flex flex-col gap-2.5 rounded-lg bg-foreground/[0.03] px-4 py-3 ring-1 ring-inset ring-foreground/10">
            <p className="text-tiny font-medium uppercase tracking-wide text-foreground/65">
              Its other connections
            </p>
            {view.replaced.map((r) => (
              <div key={r.keyId} className="flex items-center gap-2">
                <ConnectionLine row={r} />
                <Chip
                  size="sm"
                  variant="flat"
                  startContent={<RefreshCw className="ml-1 h-3 w-3" />}
                >
                  Will be replaced
                </Chip>
              </div>
            ))}
            {view.others.map((r) => (
              <div key={r.keyId} className="flex items-center gap-2">
                <ConnectionLine row={r} />
                <Checkbox
                  size="sm"
                  isDisabled={isDisabled}
                  isSelected={chosen.includes(r.keyId)}
                  onValueChange={(on) =>
                    onChosen(
                      on
                        ? [...chosen, r.keyId]
                        : chosen.filter((id) => id !== r.keyId)
                    )
                  }
                  aria-label={`Also disconnect ${r.computer}`}
                >
                  <span className="text-tiny text-foreground/85">
                    Also disconnect
                  </span>
                </Checkbox>
              </div>
            ))}
          </section>
        )}
    </>
  );
}

function ConnectionLine({ row }: { row: ConnectionRow }) {
  return (
    <p className="flex min-w-0 flex-1 items-center gap-1.5 text-small text-foreground/85">
      <Laptop aria-hidden className="h-3.5 w-3.5 shrink-0 text-foreground/65" />
      <span className="truncate">{row.computer}</span>
      <span className="shrink-0 text-tiny text-foreground/65">
        · {row.lastUsed}
      </span>
    </p>
  );
}
