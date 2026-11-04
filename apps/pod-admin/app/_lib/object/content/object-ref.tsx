"use client";

/**
 * A reference in prose, drawn: a marker (`[[entity:<id>|Ana]]`) or a bare id
 * the author wrote alone (`object://<id>`, markdown-core `linkObjectIds`).
 * What it says comes from one rule (`objectRefView`); what it names comes
 * from the page's own lookup (`EmbedHost.useObjectRef`). Without a host a
 * marker shows its label or its kind's noun and a bare id its text.
 */

import { useContext } from "react";
import Link from "next/link";
import { RotateCw } from "lucide-react";
import { resolveObjectIdentity } from "@synap-core/types/vocabulary";
import { kindIcon } from "../kind-icon";
import { EmbedHostContext, type EmbedHost } from "./embed-context";
import {
  objectRefView,
  type ObjectRef,
  type ObjectRefRead,
  type ObjectRefView,
} from "./markdown-model";

const UNRESOLVED: ObjectRefRead = { state: "unresolved" };

/** The lookup broke: the words stay, and this mark asks again. */
function RetryMark({ retry }: { retry?: () => void }) {
  const title = "Couldn’t look this up";
  return retry ? (
    <button
      type="button"
      onClick={retry}
      title={`${title}. Try again`}
      aria-label={`${title}. Try again`}
      className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded-sm align-[-2px] text-foreground/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <RotateCw aria-hidden className="h-3 w-3" />
    </button>
  ) : (
    <span
      title={title}
      aria-label={title}
      className="ml-0.5 text-foreground/50"
    >
      ·
    </span>
  );
}

function RefDrawn({ view }: { view: ObjectRefView }) {
  if (view.kind === "text") {
    return (
      <>
        {view.text}
        {view.failed && <RetryMark retry={view.failed.retry} />}
      </>
    );
  }
  const Icon = kindIcon(view.identityKind, view.profile);
  const color = resolveObjectIdentity(view.identityKind, view.profile).color;
  const body = (
    <>
      <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" style={{ color }} />
      <span className={view.pending ? "text-foreground/60" : undefined}>
        {view.text}
      </span>
    </>
  );
  const chip =
    "inline-flex max-w-full items-baseline gap-1 rounded-md bg-foreground/[0.05] px-1 align-baseline text-foreground [&>svg]:self-center";
  return (
    <>
      {view.href ? (
        <Link
          href={view.href}
          className={`${chip} underline decoration-foreground/25 underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40`}
        >
          {body}
        </Link>
      ) : (
        <span className={chip}>{body}</span>
      )}
      {view.failed && <RetryMark retry={view.failed.retry} />}
    </>
  );
}

function RefRead({
  host,
  objectRef,
  label,
}: {
  host: EmbedHost & { useObjectRef: NonNullable<EmbedHost["useObjectRef"]> };
  objectRef: ObjectRef;
  label: string;
}) {
  const read = host.useObjectRef(objectRef.id);
  return <RefDrawn view={objectRefView(objectRef, label, read)} />;
}

export function ObjectRefChip({
  objectRef,
  label,
}: {
  objectRef: ObjectRef;
  /** The marker's own words ("" for an unlabelled marker or a bare id). */
  label: string;
}) {
  const host = useContext(EmbedHostContext);
  return host?.useObjectRef ? (
    <RefRead
      host={host as Parameters<typeof RefRead>[0]["host"]}
      objectRef={objectRef}
      label={label}
    />
  ) : (
    <RefDrawn view={objectRefView(objectRef, label, UNRESOLVED)} />
  );
}
