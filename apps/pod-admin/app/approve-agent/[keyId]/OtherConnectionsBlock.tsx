"use client";

import type { ReactNode } from "react";
import { Checkbox, Chip } from "@heroui/react";
import { AlertTriangle, Laptop, RefreshCw, Unplug } from "lucide-react";
import type { ConnectionRow, ConnectionsView } from "./other-connections";

/**
 * What approving does to the agent's other connections.
 *
 *  - this computer's live connection: listed, marked "Will be replaced"
 *    (no choice — it is the same computer reconnecting);
 *  - every other live connection (another computer, or an older CLI's
 *    unlabelled one): kept, with an "Also disconnect" box, unticked; a ticked
 *    one is marked "Will disconnect" (danger);
 *  - a request with a newer one from the same computer: a banner that links
 *    to the newer request (the form offers no approval here).
 *
 * OMIT when there is nothing: no other connection means no section, and an
 * older pod that sends no facts shows none (it cannot say).
 */
export function OtherConnectionsBlock({
  view,
  chosen,
  onChosen,
  newerHref,
  isDisabled,
}: {
  view: ConnectionsView;
  chosen: string[];
  onChosen: (ids: string[]) => void;
  /** The newer request's page, when this one is superseded. */
  newerHref: string | null;
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
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-small text-foreground">
              A newer request from this computer is waiting. This one will
              expire.
            </p>
            {newerHref && (
              <a
                href={newerHref}
                className="text-small font-medium text-primary underline-offset-2 hover:underline"
              >
                Open the newer request
              </a>
            )}
          </div>
        </div>
      )}

      {!view.superseded &&
        view.known &&
        (view.replaced.length > 0 || view.others.length > 0) && (
          <section className="flex flex-col gap-3 rounded-lg bg-foreground/[0.03] px-4 py-3 ring-1 ring-inset ring-foreground/10">
            <p className="text-tiny font-medium uppercase tracking-wide text-foreground/65">
              {view.agent} on your computers
            </p>
            {view.replaced.map((r) => (
              <ConnectionLine
                key={r.keyId}
                row={r}
                name={`${r.computer} · earlier connection`}
              >
                <Chip
                  size="sm"
                  variant="flat"
                  startContent={<RefreshCw className="ml-1 h-3 w-3" />}
                >
                  Will be replaced
                </Chip>
              </ConnectionLine>
            ))}
            {view.others.map((r) => {
              const on = chosen.includes(r.keyId);
              return (
                <ConnectionLine key={r.keyId} row={r} name={r.computer}>
                  <Checkbox
                    size="sm"
                    color="danger"
                    isDisabled={isDisabled}
                    isSelected={on}
                    onValueChange={(next) =>
                      onChosen(
                        next
                          ? [...chosen, r.keyId]
                          : chosen.filter((id) => id !== r.keyId)
                      )
                    }
                  >
                    {/* HeroUI names the box by this label (aria-labelledby
                        outranks aria-label): the computer and its day ride in
                        it, so two "unlabelled" boxes are told apart. */}
                    <span className="text-tiny text-foreground/85">
                      Also disconnect
                      <span className="sr-only">
                        {` ${r.computer}${r.connected ? `, ${r.connected}` : ""}`}
                      </span>
                    </span>
                  </Checkbox>
                  {on && (
                    <Chip
                      size="sm"
                      variant="flat"
                      color="danger"
                      startContent={<Unplug className="ml-1 h-3 w-3" />}
                    >
                      Will disconnect
                    </Chip>
                  )}
                </ConnectionLine>
              );
            })}
          </section>
        )}
    </>
  );
}

/**
 * One connection, two lines: the computer (truncated, full name on hover)
 * over when it was last used and connected; its mark or choice trailing,
 * top-aligned — so a long name never pushes the time or the choice off.
 */
function ConnectionLine({
  row,
  name,
  children,
}: {
  row: ConnectionRow;
  name: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <Laptop
        aria-hidden
        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground/65"
      />
      {/* Below 400px the mark/choice drops under the text, so the name
          keeps the full row instead of a third of it. */}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 min-[400px]:flex-row min-[400px]:items-start min-[400px]:gap-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="truncate text-small text-foreground/85" title={name}>
            {name}
          </p>
          <p className="text-tiny text-foreground/65">
            {[row.lastUsed, row.connected].filter(Boolean).join(" · ")}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 min-[400px]:flex-col min-[400px]:items-end min-[400px]:gap-1">
          {children}
        </div>
      </div>
    </div>
  );
}
