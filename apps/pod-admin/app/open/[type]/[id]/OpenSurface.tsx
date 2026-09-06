"use client";

import { useEffect, type ReactNode } from "react";
import {
  Accordion,
  AccordionItem,
  CardBody,
  CardHeader,
  Chip,
  Spinner,
} from "@heroui/react";
import { Box, LayoutGrid } from "lucide-react";
import { openIn } from "../../../../lib/open-in";
import { ExitLink } from "../../../../lib/exit-link";
import {
  ReceiverIdentityProvider,
  ReceiverShell,
} from "../../../_lib/receiver-shell";
import { trpc } from "../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { isUuid, labelForOpenType, type ParsedOpen } from "../../open-params";

const PLACEHOLDER_UUID = "00000000-0000-4000-8000-000000000000";
const CANVAS_VIEW_TYPES = new Set(["whiteboard", "mindmap"]);
const MAX_PROPS = 6;
const MAX_DESCRIPTION = 280;
const ID_KEY_RE = /(^id$|_id$|Id$|Ids$|ID$)/;

type TrpcError = { data?: { code?: string | null } | null } | null | undefined;

type EntityPayload = {
  entity?: {
    id?: string;
    title?: string | null;
    type?: string | null;
    profileSlug?: string | null;
    preview?: string | null;
    description?: string | null;
    properties?: Record<string, unknown> | null;
    updatedAt?: Date | string | null;
    facetSlugs?: string[];
  };
  profile?: { slug?: string; displayName?: string };
  effectiveProperties?: Array<{
    slug?: string;
    valueType?: string;
    displayOrder?: number;
    uiHints?: Record<string, unknown>;
  }>;
  facets?: Array<{ profile?: Record<string, unknown> }>;
};

type ViewPayload = {
  view?: {
    id?: string;
    name?: string | null;
    type?: string | null;
    description?: string | null;
    updatedAt?: Date | string | null;
  };
};

/** The four facts a bounce card needs to stop being anonymous. */
type BounceReceipt = {
  title: string;
  workspaceId: string | null;
  updatedAt: Date | string | null;
};

/** Every bounce lookup below reduces to this shape before it is read. */
type NamedRow = {
  workspaceId?: string | null;
  updatedAt?: Date | string | null;
} | null;

export function OpenSurface({
  parsed,
  podHost,
  identity,
}: {
  parsed: ParsedOpen;
  podHost?: string;
  identity?: string;
}) {
  return (
    <ReceiverIdentityProvider podHost={podHost} identity={identity}>
      <OpenSurfaceBody parsed={parsed} />
    </ReceiverIdentityProvider>
  );
}

function OpenSurfaceBody({ parsed }: { parsed: ParsedOpen }) {
  const entityEnabled = parsed.status === "host" && parsed.type === "entity";
  const viewEnabled = parsed.status === "host" && parsed.type === "view";
  const queryId = parsed.status === "host" ? parsed.id : PLACEHOLDER_UUID;

  const entityQuery = trpc.entities.get.useQuery(
    { id: queryId, includeProfile: true },
    { enabled: entityEnabled }
  );
  const viewQuery = trpc.views.get.useQuery(
    { id: queryId },
    { enabled: viewEnabled }
  );

  /* A bounce card that can't say WHICH object it bounced is an ask to install a
     desktop app to find out what you were sent. Six of the seven bounce kinds
     have a `get` this client can already reach, so the card names the object and
     still bounces. `cell` is deliberately absent: `synap://open/cell/<id>`
     addresses a registered cell TYPE KEY (browser `object-nav.ts`, `case 'cell'`),
     not a `cell_instances` row, so `cellInstances.get` would resolve a different
     object — a confidently wrong name is worse than no name.
     Gated on `isUuid` because a bounce id only has to pass `SAFE_ID_RE`, and
     every one of these inputs is a uuid. */
  const bounceType = parsed.status === "bounce" ? parsed.type : null;
  const bounceId =
    parsed.status === "bounce" && isUuid(parsed.id)
      ? parsed.id
      : PLACEHOLDER_UUID;
  const bounceOn = (type: string) =>
    bounceType === type && bounceId !== PLACEHOLDER_UUID;

  // WHY the whole document: `documents.get` is the only door this client can
  // reach (`getInWorkspace` is a workspaceProcedure and pod-admin sets no
  // X-Workspace-Id), and it returns the resolved body alongside the row. We read
  // only `document`; the body is the cost of the one reachable door.
  const documentQuery = trpc.documents.get.useQuery(
    { documentId: bounceId },
    { enabled: bounceOn("document"), retry: false }
  );
  const sessionQuery = trpc.focusSessions.get.useQuery(
    { id: bounceId },
    { enabled: bounceOn("session"), retry: false }
  );
  const projectQuery = trpc.projects.get.useQuery(
    { id: bounceId },
    { enabled: bounceOn("project"), retry: false }
  );
  const workspaceQuery = trpc.workspaces.get.useQuery(
    { id: bounceId },
    { enabled: bounceOn("workspace"), retry: false }
  );
  const channelQuery = trpc.chat.getChannel.useQuery(
    { channelId: bounceId, includeContext: false, includeBranches: false },
    { enabled: bounceOn("channel"), retry: false }
  );
  const capabilityQuery = trpc.capabilities.containers.get.useQuery(
    { id: bounceId },
    { enabled: bounceOn("capability"), retry: false }
  );

  const bounceQuery = bounceOn("document")
    ? documentQuery
    : bounceOn("session")
      ? sessionQuery
      : bounceOn("project")
        ? projectQuery
        : bounceOn("workspace")
          ? workspaceQuery
          : bounceOn("channel")
            ? channelQuery
            : bounceOn("capability")
              ? capabilityQuery
              : null;

  const receipt = bounceType
    ? bounceReceipt(bounceType, bounceQuery?.data)
    : null;

  /* The row carries a workspace UUID, and a UUID is not a workspace. `list` is
     the cheapest name resolver the client already holds — one cached array
     shared by every kind — and it is only asked for once a receipt resolved. */
  const workspaceNamesQuery = trpc.workspaces.list.useQuery(undefined, {
    enabled: Boolean(receipt?.workspaceId),
    retry: false,
  });
  const workspaceName = receipt?.workspaceId
    ? (workspaceNamesQuery.data ?? []).find(
        (row) => row.id === receipt.workspaceId
      )?.name
    : undefined;

  useEffect(() => {
    // An expired cookie still passes the middleware's presence check, so every
    // lookup on this route — host card or bounce receipt — re-auths the same way
    // rather than reporting a load failure the operator can't act on.
    const err = entityQuery.error ?? viewQuery.error ?? bounceQuery?.error;
    if (err) {
      redirectToLoginIfUnauthorized(err);
    }
  }, [entityQuery.error, viewQuery.error, bounceQuery?.error]);

  if (parsed.status === "invalid-id") {
    return shell(
      emptyBody({
        eyebrow: labelForOpenType(parsed.type),
        title: "This link isn’t valid",
        message:
          "The address doesn\u2019t look like a Synap object. Check the link and try again.",
        chip: "Invalid link",
      })
    );
  }

  if (parsed.status === "not-found") {
    return shell(
      emptyBody({
        eyebrow: "Open",
        title: "Nothing here",
        message: "This address isn\u2019t a Synap object this page can open.",
        chip: "Not found",
      })
    );
  }

  if (parsed.status === "bounce") {
    if (bounceQuery?.isLoading) {
      return shell(
        <CardBody className="items-center gap-3 px-7 py-16">
          <Spinner label="Loading…" />
        </CardBody>
      );
    }
    // Failed, forbidden, or nameless → exactly today's card. A receipt that
    // errors is worse than a bounce that works, so nothing here is conditional
    // on the lookup SUCCEEDING for the exit to render.
    return shell(
      emptyBody({
        eyebrow: labelForOpenType(parsed.type),
        title: receipt?.title ?? `This ${parsed.type} opens in the Synap app`,
        message:
          "The web host only shows entities and views. Open it in the Synap app for the full surface.",
        chip: "Opens in app",
        details: receipt
          ? detailRows(
              parsed.id,
              receipt.updatedAt,
              workspaceName
                ? [{ label: "Workspace", value: workspaceName }]
                : []
            )
          : undefined,
        deepLink: { type: parsed.type, id: parsed.id },
      })
    );
  }

  if (parsed.type === "entity") {
    return (
      <EntityCard
        id={parsed.id}
        isLoading={entityQuery.isLoading}
        error={entityQuery.error}
        data={entityQuery.data as EntityPayload | undefined}
      />
    );
  }

  return (
    <ViewCard
      id={parsed.id}
      isLoading={viewQuery.isLoading}
      error={viewQuery.error}
      data={viewQuery.data as ViewPayload | undefined}
    />
  );
}

function EntityCard({
  id,
  isLoading,
  error,
  data,
}: {
  id: string;
  isLoading: boolean;
  error: TrpcError;
  data: EntityPayload | undefined;
}) {
  if (isLoading) {
    return shell(
      <CardBody className="items-center gap-3 px-7 py-16">
        <Spinner label="Loading entity…" />
      </CardBody>
    );
  }

  const fail = loadFailure(error, "entity");
  if (fail || !data?.entity) {
    return shell(
      emptyBody({
        eyebrow: "Entity",
        title: fail?.title ?? "This entity couldn’t be loaded",
        message:
          fail?.message ??
          "Something went wrong while loading this entity. Try again, or open it in the Synap app.",
        chip: fail?.chip ?? "Couldn’t load",
        deepLink: { type: "entity", id },
      })
    );
  }

  const entity = data.entity;
  const title = stringOrFallback(entity.title, "Untitled");
  const kind =
    stringOrFallback(data.profile?.displayName) ||
    stringOrFallback(entity.profileSlug) ||
    stringOrFallback(entity.type) ||
    "Entity";
  const description = shortDescription(
    entity.preview ??
      entity.description ??
      stringProp(entity.properties, "description") ??
      stringProp(entity.properties, "content")
  );
  const fields = pickReadableProperties(
    entity.properties ?? {},
    data.effectiveProperties
  );
  const roles = facetRoleSlugs(data);
  const details = detailRows(entity.id ?? id, entity.updatedAt, fields.rest);

  return shell(
    <>
      <CardHeader className="flex items-start justify-between gap-3 px-7 pb-0 pt-7">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {kindIcon(<Box className="h-5 w-5" strokeWidth={2} />)}
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground/65">
              Entity
            </p>
            <h1 className="break-words text-balance font-heading text-[22px] font-medium leading-tight tracking-tight text-foreground">
              {title}
            </h1>
          </div>
        </div>
        <Chip variant="flat" size="sm">
          {kind}
        </Chip>
      </CardHeader>
      <CardBody className="flex flex-col gap-5 px-7 pb-7 pt-5">
        {description ? (
          <p className="text-[13px] leading-relaxed text-foreground/65">
            {description}
          </p>
        ) : null}
        {roles.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {roles.map((slug) => (
              <Chip
                key={slug}
                size="sm"
                variant="flat"
                className="text-foreground/60"
              >
                {slug}
              </Chip>
            ))}
          </div>
        ) : null}
        {fields.shown.length > 0 ? (
          <dl className="grid grid-cols-[minmax(6rem,9rem)_1fr] gap-x-4 gap-y-2">
            {fields.shown.map((row) => (
              <Field key={row.label} label={row.label} value={row.value} />
            ))}
          </dl>
        ) : null}
        {details.length > 0 ? <DetailsWell rows={details} /> : null}
        <div className="pt-1">
          <OpenInAppLink type="entity" id={id} />
        </div>
      </CardBody>
    </>
  );
}

function ViewCard({
  id,
  isLoading,
  error,
  data,
}: {
  id: string;
  isLoading: boolean;
  error: TrpcError;
  data: ViewPayload | undefined;
}) {
  if (isLoading) {
    return shell(
      <CardBody className="items-center gap-3 px-7 py-16">
        <Spinner label="Loading view…" />
      </CardBody>
    );
  }

  const fail = loadFailure(error, "view");
  if (fail || !data?.view) {
    return shell(
      emptyBody({
        eyebrow: "View",
        title: fail?.title ?? "This view couldn’t be loaded",
        message:
          fail?.message ??
          "Something went wrong while loading this view. Try again, or open it in the Synap app.",
        chip: fail?.chip ?? "Couldn’t load",
        deepLink: { type: "view", id },
      })
    );
  }

  const view = data.view;
  const name = stringOrFallback(view.name, "Untitled view");
  const viewType = stringOrFallback(view.type, "view");
  const canvas = CANVAS_VIEW_TYPES.has(viewType);
  const description = canvas ? null : shortDescription(view.description);
  const details = detailRows(view.id ?? id, view.updatedAt, []);

  return shell(
    <>
      <CardHeader className="flex items-start justify-between gap-3 px-7 pb-0 pt-7">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {kindIcon(<LayoutGrid className="h-5 w-5" strokeWidth={2} />)}
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground/65">
              View
            </p>
            <h1 className="break-words text-balance font-heading text-[22px] font-medium leading-tight tracking-tight text-foreground">
              {name}
            </h1>
          </div>
        </div>
        <Chip variant="flat" size="sm">
          {viewType}
        </Chip>
      </CardHeader>
      <CardBody className="flex flex-col gap-5 px-7 pb-7 pt-5">
        {canvas ? (
          <p className="text-[13px] leading-relaxed text-foreground/65">
            This view opens in the Synap app
          </p>
        ) : description ? (
          <p className="text-[13px] leading-relaxed text-foreground/65">
            {description}
          </p>
        ) : null}
        {details.length > 0 ? <DetailsWell rows={details} /> : null}
        <div className="pt-1">
          <OpenInAppLink type="view" id={id} />
        </div>
      </CardBody>
    </>
  );
}

/* Shared with /proposal and the other inbound routes — see
   `app/_lib/receiver-shell.tsx` for why these pages need chrome at all.
   Pod identity comes from the route-level provider, so the three components
   that call this all render the same header without threading props. */
function shell(children: ReactNode) {
  return <ReceiverShell>{children}</ReceiverShell>;
}

function kindIcon(icon: ReactNode) {
  return (
    <span
      aria-hidden
      className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-inset ring-primary/20"
    >
      {icon}
    </span>
  );
}

function emptyBody({
  eyebrow,
  title,
  message,
  chip,
  details,
  deepLink,
}: {
  eyebrow: string;
  title: string;
  message: string;
  chip: string;
  /** Present only when a bounce lookup resolved — same rows the host cards use. */
  details?: Array<{ label: string; value: string }>;
  deepLink?: { type: string; id: string };
}) {
  return (
    <>
      <CardHeader className="flex items-start justify-between gap-3 px-7 pb-0 pt-7">
        <div className="min-w-0 flex-1 flex flex-col gap-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground/65">
            {eyebrow}
          </p>
          <h1 className="break-words text-balance font-heading text-[22px] font-medium leading-tight tracking-tight text-foreground">
            {title}
          </h1>
        </div>
        <Chip variant="flat" size="sm">
          {chip}
        </Chip>
      </CardHeader>
      <CardBody className="flex flex-col gap-5 px-7 pb-7 pt-5">
        <p className="text-[13px] leading-relaxed text-foreground/70">
          {message}
        </p>
        {details && details.length > 0 ? <DetailsWell rows={details} /> : null}
        {deepLink ? (
          <OpenInAppLink type={deepLink.type} id={deepLink.id} />
        ) : null}
      </CardBody>
    </>
  );
}

/**
 * The only affordance on a bounce card — so it had better not be a dead end.
 *
 * Seven of the nine typed kinds (document, cell, channel, session, project,
 * workspace, capability) have no web renderer here. A bare `synap://` link
 * does NOTHING when the desktop app is not installed — no navigation, no
 * error — and these links arrive by email and CLI, so "not installed" is the
 * common case. `ExitLink` is what guarantees the way out travels with it.
 */
function OpenInAppLink({ type, id }: { type: string; id: string }) {
  return (
    <ExitLink
      exit={openIn({ kind: "objectInApp", objectKind: type, id })}
      label="Open in the Synap app"
    />
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/45">
        {label}
      </dt>
      <dd
        className={
          label === "Id"
            ? "min-w-0 break-all font-mono text-[12px] tabular-nums leading-relaxed text-foreground/80"
            : "min-w-0 break-words text-[13px] leading-relaxed text-foreground/80"
        }
      >
        {value}
      </dd>
    </>
  );
}

function DetailsWell({
  rows,
}: {
  rows: Array<{ label: string; value: string }>;
}) {
  return (
    <Accordion className="px-0" variant="light">
      <AccordionItem
        key="details"
        aria-label="Details"
        title={<span className="text-[12px] text-foreground/55">Details</span>}
      >
        <dl className="grid grid-cols-[minmax(6rem,9rem)_1fr] gap-x-4 gap-y-2 pb-2">
          {rows.map((row) => (
            <Field key={row.label} label={row.label} value={row.value} />
          ))}
        </dl>
      </AccordionItem>
    </Accordion>
  );
}

/**
 * One bounce payload → the receipt, or null.
 *
 * Null on ANY doubt — no data, or a row whose name is empty (an untitled channel
 * is the real case). The caller then renders today's card, so the worst outcome
 * of a miss is the status quo. Never falls back to the id: a raw UUID is not a
 * name, it is the thing the receipt exists to replace.
 */
function bounceReceipt(type: string, data: unknown): BounceReceipt | null {
  if (data == null || typeof data !== "object") return null;
  const payload = data as Record<string, unknown>;

  // Each door's own return shape, verified against its router:
  //   document   documents.get           → { document, content }
  //   session    focusSessions.get       → the row (its name is `goal`)
  //   project    projects.get            → { project, subject, phaseCategory }
  //   workspace  workspaces.get          → the projected row
  //   channel    chat.getChannel         → { channel, … }  (title is NULLABLE)
  //   capability capabilities.containers.get → { capability, parts }
  const [name, row]: [unknown, NamedRow] = (() => {
    const nested = (key: string): [unknown, NamedRow] => {
      const inner = payload[key];
      if (inner == null || typeof inner !== "object") return [null, null];
      const record = inner as Record<string, unknown>;
      return [record.name ?? record.title ?? record.goal, record as NamedRow];
    };
    switch (type) {
      case "document":
        return nested("document");
      case "project":
        return nested("project");
      case "channel":
        return nested("channel");
      case "capability":
        return nested("capability");
      case "session":
        return [payload.goal, payload as NamedRow];
      case "workspace":
        return [payload.name, payload as NamedRow];
      default:
        return [null, null];
    }
  })();

  const title = stringOrFallback(name);
  if (!title || !row) return null;
  return {
    title,
    // A workspace IS the scope — it has no workspace of its own to name.
    workspaceId:
      type === "workspace" ? null : stringOrFallback(row.workspaceId) || null,
    updatedAt: row.updatedAt ?? null,
  };
}

function loadFailure(
  error: TrpcError,
  noun: "entity" | "view"
): { title: string; message: string; chip: string } | null {
  const code = error?.data?.code;
  if (code === "UNAUTHORIZED") {
    return {
      title: "Signing you in",
      message: "Your session expired. Taking you to sign in…",
      chip: "Sign in required",
    };
  }
  if (code === "NOT_FOUND") {
    return {
      title: `This ${noun} couldn’t be found`,
      message: `It may have been deleted, or the link is stale. You can still try opening it in the Synap app.`,
      chip: "Not found",
    };
  }
  if (code === "FORBIDDEN") {
    return {
      title: `You don’t have access to this ${noun}`,
      message: `You’re signed in, but this ${noun} isn’t visible to you. Ask the owner to share it, or open it in the Synap app if you have access there.`,
      chip: "No access",
    };
  }
  if (error) {
    return {
      title: `This ${noun} couldn’t be loaded`,
      message: `Something went wrong while loading this ${noun}. Try again, or open it in the Synap app.`,
      chip: "Couldn’t load",
    };
  }
  return null;
}

function shortDescription(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_DESCRIPTION)
    return `${trimmed.slice(0, MAX_DESCRIPTION).trimEnd()}…`;
  return trimmed;
}

function stringOrFallback(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringProp(
  properties: Record<string, unknown> | null | undefined,
  key: string
): string | undefined {
  const value = properties?.[key];
  return typeof value === "string" ? value : undefined;
}

function facetRoleSlugs(data: EntityPayload): string[] {
  const slugs = new Set<string>();
  for (const slug of data.entity?.facetSlugs ?? []) {
    if (slug) slugs.add(slug);
  }
  for (const row of data.facets ?? []) {
    const slug = row.profile?.slug;
    if (typeof slug === "string" && slug) slugs.add(slug);
  }
  return [...slugs];
}

function pickReadableProperties(
  properties: Record<string, unknown>,
  defs: EntityPayload["effectiveProperties"]
): {
  shown: Array<{ label: string; value: string }>;
  rest: Array<{ label: string; value: string }>;
} {
  const defBySlug = new Map(
    (defs ?? [])
      .filter((d): d is typeof d & { slug: string } => Boolean(d.slug))
      .map((d) => [d.slug, d])
  );
  const skipKeys = new Set(["description", "content", "body", "preview"]);
  const candidates: Array<{ label: string; value: string }> = [];

  // No defs → do not dump undeclared keys (secrets would leak as strings).
  const slugs =
    defBySlug.size > 0
      ? [...defBySlug.values()]
          .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0))
          .map((d) => d.slug)
      : [];

  for (const slug of slugs) {
    if (skipKeys.has(slug) || ID_KEY_RE.test(slug)) continue;
    const def = defBySlug.get(slug);
    if (def?.valueType === "secret" || def?.valueType === "entity_id") continue;
    const formatted = formatPropertyValue(properties[slug]);
    if (!formatted) continue;
    candidates.push({
      label: propertyLabel(slug, def?.uiHints),
      value: formatted,
    });
  }

  const shown = candidates.slice(0, MAX_PROPS);
  const rest = candidates.slice(MAX_PROPS);
  return { shown, rest };
}

function propertyLabel(
  slug: string,
  uiHints: Record<string, unknown> | undefined
): string {
  const label = uiHints?.label;
  if (typeof label === "string" && label.trim()) return label.trim();
  const displayName = uiHints?.displayName;
  if (typeof displayName === "string" && displayName.trim()) {
    return displayName.trim();
  }
  return slug
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatPropertyValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.length > 160) return `${trimmed.slice(0, 160).trimEnd()}…`;
    return trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toLocaleString();
  }
  if (Array.isArray(value)) {
    if (value.length === 0 || value.length > 8) return null;
    if (!value.every((item) => isPrimitive(item))) return null;
    return value.map((item) => String(item)).join(", ");
  }
  if (typeof value === "object") return null;
  return null;
}

function isPrimitive(value: unknown): boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function detailRows(
  id: string,
  updatedAt: Date | string | null | undefined,
  extra: Array<{ label: string; value: string }>
): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  if (id) rows.push({ label: "Id", value: id });
  const when = formatWhen(updatedAt);
  if (when) rows.push({ label: "Updated", value: when });
  return [...rows, ...extra];
}

function formatWhen(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
}
