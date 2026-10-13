"use client";

/**
 * The pieces the three app pages share between the header and the danger
 * zone: a titled section, a copyable id, a list of exact values (origins,
 * redirect URIs), the people who use an app and the keys it holds. Each page
 * composes them inside `ObjectPage` (via `consoleFrame`), so an app reads the
 * same whichever way it connects.
 */

import Link from "next/link";
import { KeyRound, User } from "lucide-react";
import type { ReactNode } from "react";
import { navHref } from "../../../../lib/console-nav";
import { formatRelative } from "../../../../lib/format";
import { CopyButton } from "../../../_lib/copy-button";
import type { ObjectFrame } from "../../../_lib/object/views/object-frame";
import type { TrpcErrorLike } from "../../../_lib/object/load-failure";
import { ResourceRow, ResourceRowEmpty } from "../../components/resource-row";
import { keyStatus } from "../../keys/_lib/key-model";
import { personName } from "./app-inventory";
import { appLoadFailure } from "./app-load-failure";

export function AppSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <h2 className="text-sm font-medium text-foreground">{title}</h2>
      {hint && (
        <p className="max-w-2xl text-[12.5px] leading-5 text-foreground/65">
          {hint}
        </p>
      )}
      {children}
    </section>
  );
}

/** An id the reader may need to paste somewhere, with its one copy. */
export function CopyableId({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/65">
        {label}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="break-all font-mono text-[12px] leading-5 text-foreground/85">
          {value}
        </span>
        <CopyButton
          text={value}
          label="Copy"
          variant="light"
          ariaLabel={`Copy ${label}`}
        />
      </div>
      {note && <p className="text-[11.5px] text-foreground/65">{note}</p>}
    </div>
  );
}

/** Exact values (origins, redirect URIs, scopes) — mono, one per line. */
export function ExactValues({
  label,
  values,
  empty = "None",
}: {
  label: string;
  values: readonly string[];
  empty?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/65">
        {label}
      </p>
      {values.length === 0 ? (
        <p className="text-[12.5px] text-foreground/65">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {values.map((v) => (
            <li
              key={v}
              className="break-all font-mono text-[12px] leading-5 text-foreground/80"
            >
              {v}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface AppPerson {
  id: string;
  name: string | null;
  email: string | null;
  /** The person's own line ("linked 3 days ago", "no live key"). */
  note?: string;
}

/** Who uses the app — each person opens on Members. */
export function PeopleList({
  people,
  empty,
}: {
  people: readonly AppPerson[];
  empty: string;
}) {
  if (people.length === 0) return <ResourceRowEmpty message={empty} />;
  return (
    <div className="-mx-2 divide-y divide-foreground/[0.05] rounded-lg ring-1 ring-inset ring-foreground/10">
      {people.map((p) => (
        <div key={p.id} data-row-id={p.id}>
          <ResourceRow
            Icon={User}
            primary={personName(p) ?? "Unknown person"}
            secondary={[p.name ? p.email : null, p.note]
              .filter(Boolean)
              .join(" · ")}
            actions={
              <Link
                href={navHref("members", { focus: p.id })}
                className="px-2 text-[12px] text-foreground/65 hover:text-foreground hover:underline"
              >
                Members
              </Link>
            }
          />
        </div>
      ))}
    </div>
  );
}

export interface AppKeyRow {
  id: string;
  keyName: string;
  createdAt: Date | string;
  lastUsedAt: Date | string | null;
  usageCount: number;
  isActive: boolean;
  expiresAt: Date | string | null;
}

/**
 * The keys the app holds, newest first. Each opens on the Keys page, where a
 * key is revoked one at a time; ending the app (danger zone) stops them all.
 */
export function KeyList({
  keys,
  empty,
}: {
  keys: readonly AppKeyRow[];
  empty: string;
}) {
  if (keys.length === 0) return <ResourceRowEmpty message={empty} />;
  return (
    <div className="-mx-2 divide-y divide-foreground/[0.05] rounded-lg ring-1 ring-inset ring-foreground/10">
      {keys.map((k) => (
        <ResourceRow
          key={k.id}
          Icon={KeyRound}
          primary={k.keyName}
          secondary={[
            `created ${formatRelative(k.createdAt)}`,
            k.lastUsedAt
              ? `last used ${formatRelative(k.lastUsedAt)}`
              : "never used",
            k.usageCount > 0
              ? `${k.usageCount.toLocaleString("en-US")} calls`
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
          status={keyStatus(k)}
          actions={
            <Link
              href={navHref("keys", { focus: k.id })}
              className="px-2 text-[12px] text-foreground/65 hover:text-foreground hover:underline"
            >
              Keys
            </Link>
          }
          wrap
        />
      ))}
    </div>
  );
}

/**
 * A failed read, drawn in the console frame. Not `frame.failure`: that one
 * offers "Open in app", and an app's page lives only here — the desktop app
 * has no page for a connected app to open (`appLoadFailure`).
 */
export function appFailure(
  frame: ObjectFrame,
  error: TrpcErrorLike
): ReactNode {
  const failure = appLoadFailure(error);
  return frame.object({
    header: {
      kind: "application",
      title: failure.title,
      summary: failure.message,
      status: { kind: "unknown", label: failure.chip },
      breadcrumb: frame.breadcrumb?.(failure.chip),
    },
  });
}
