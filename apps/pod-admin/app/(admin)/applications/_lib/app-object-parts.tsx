"use client";

/**
 * The pieces the three app pages share between the header and the danger
 * zone: a copyable id, a list of exact values (origins, redirect URIs), the
 * people who use an app and the keys it holds, and how a failed read reads.
 * Each page composes them inside `ObjectPage` (via `consoleFrame`), in flat
 * `SectionCard`s, so an app reads the same whichever way it connects.
 */

import Link from "next/link";
import { Button } from "@heroui/react";
import { KeyRound, User } from "lucide-react";
import type { ReactNode } from "react";
import { navHref } from "../../../../lib/console-nav";
import { formatRelative } from "../../../../lib/format";
import { CopyButton } from "../../../_lib/copy-button";
import type { ObjectFrame } from "../../../_lib/object/views/object-frame";
import {
  couldNotLoad,
  loadFailure,
  type FailureWording,
  type TrpcErrorLike,
} from "../../../_lib/object/load-failure";
import { ResourceRow, ResourceRowEmpty } from "../../components/resource-row";
import { keyStatus } from "../../keys/_lib/key-model";
import { personName } from "./app-inventory";

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

/**
 * Who uses the app — each person opens on Members. With `onUnlink`, each row
 * also offers "Unlink {email}" (the caller confirms before anything happens).
 */
export function PeopleList({
  people,
  empty,
  onUnlink,
}: {
  people: readonly AppPerson[];
  empty: string;
  onUnlink?: (person: AppPerson) => void;
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
              <div className="flex items-center gap-1">
                <Link
                  href={navHref("members", { focus: p.id })}
                  aria-label={`Open ${personName(p) ?? "this person"} on Members`}
                  className="rounded-sm px-2 text-[12px] text-foreground/65 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  Members
                </Link>
                {onUnlink ? (
                  <Button
                    size="sm"
                    variant="light"
                    color="danger"
                    onPress={() => onUnlink(p)}
                  >
                    Unlink {p.email ?? personName(p) ?? "this person"}
                  </Button>
                ) : null}
              </div>
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
              aria-label={`Open ${k.keyName} on Keys`}
              className="rounded-sm px-2 text-[12px] text-foreground/65 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
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
 * A failed app read, in the console frame. An app's page lives only here —
 * the Synap app has no page for a connected app — so neither the words nor
 * the frame offer to open it there; the sentences say where to look instead.
 */
const APP_WORDING: FailureWording = {
  inApp: false,
  notFound:
    "It may have been removed for good, or the link is stale. Every app still connected is on the Apps list.",
  forbidden:
    "An app's page is for pod admins. Your own apps are on your Connected page.",
};

export function appFailure(
  frame: ObjectFrame,
  id: string,
  error: TrpcErrorLike
): ReactNode {
  return frame.failure({
    kind: "application",
    id,
    failure:
      loadFailure(error, "App", APP_WORDING) ??
      couldNotLoad("App", APP_WORDING),
    openIn: false,
  });
}
