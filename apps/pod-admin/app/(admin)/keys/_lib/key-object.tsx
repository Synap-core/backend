"use client";

/**
 * One API key, its own page (page grammar: Object; key pages plan 447800fe
 * §5.3, finding d99517f7: a person's or the pod's key row opened nothing).
 *
 *   header — the key's name, what holds it, its status; Replace beside it.
 *            A key declares no lifecycle, so there is no header primary.
 *   facts  — who holds it (a door to its holder's page), where, created,
 *            ends, last used, calls, prefix.
 *   What it can do — each live grant as families at one level
 *            (`AccessSummary`, the New key page's), or the one sentence for a
 *            key that can touch nothing. "Change" narrows it in place
 *            (`apiKeys.setGrants`, the key's own person, signed in): never
 *            wider than it is, since its doors (scopes) were set when it was
 *            made.
 *   How to use it — the Hub API address, when it is used there.
 *   Advanced (ids, scopes, raw), then Revoke / Delete record.
 */

import { Button, Snippet, addToast } from "@heroui/react";
import { KeyRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  describeKeyAccess,
  keyScope,
  type FamilyPartsContext,
  type KeyDraft,
} from "@synap-core/types/grants";
import {
  resolveActionLabel,
  resolveObjectNoun,
} from "@synap-core/types/vocabulary";
import { POD_URL, trpc } from "../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import {
  formatDate,
  formatRelative,
  readableError,
} from "../../../../lib/format";
import { keyPageHref, navHref } from "../../../../lib/console-nav";
import type { DangerAction } from "../../../_lib/object/danger-zone";
import { loadFailure, notFound } from "../../../_lib/object/load-failure";
import type { ObjectFrame } from "../../../_lib/object/views/object-frame";
import { SectionCard } from "../../components/section-card";
import { AccessEditor, AccessSummary } from "./key-access";
import {
  CATEGORY_LABEL,
  categorize,
  holderHref,
  holderName,
  isPodAppAccessKey,
  keyStatus,
  keyUsesOf,
  normalizeScopes,
  type UnifiedKey,
} from "./key-model";
import { RevealKeyModal } from "./key-modals";

const KEY_NOUN = resolveObjectNoun("api_key");

/** The key's end, as a fact and beside what it can do. */
function endWords(k: UnifiedKey): string {
  if (!k.expiresAt) return "Never expires";
  const at = new Date(k.expiresAt);
  return at.getTime() < Date.now()
    ? `Ended ${formatDate(at)}`
    : `Ends ${formatDate(at)}`;
}

export function KeyObject({
  id,
  apiKey,
  isLoading,
  error,
  frame,
  viewerId,
  ctx,
  spaces,
}: {
  id: string;
  /** The loaded row; undefined while loading, null when it is not there. */
  apiKey: UnifiedKey | null | undefined;
  isLoading: boolean;
  error: { data?: { code?: string | null } | null } | null;
  frame: ObjectFrame;
  viewerId: string | null;
  ctx: FamilyPartsContext;
  spaces: readonly { id: string; name: string }[];
}) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState<KeyDraft | null>(null);
  const [revealed, setRevealed] = useState<{
    id: string;
    plaintext: string;
  } | null>(null);
  const invalidate = () =>
    Promise.all([
      utils.apiKeys.adminListAll.invalidate(),
      utils.apiKeys.listSystemKeys.invalidate(),
    ]);
  const onError =
    (title: string) =>
    (err: { message: string; data?: { code?: string | null } | null }) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      addToast({
        title,
        description: readableError(err.message) ?? "Try again.",
        color: "danger",
      });
    };
  const setGrants = trpc.apiKeys.setGrants.useMutation({
    onError: onError("Couldn't change this key"),
  });
  const rotate = trpc.apiKeys.rotate.useMutation({
    onError: onError("Couldn't replace this key"),
  });
  const revoke = trpc.apiKeys.revoke.useMutation({
    onError: onError("Couldn't revoke this key"),
  });
  const deleteRevoked = trpc.apiKeys.adminDeleteRevoked.useMutation({
    onError: onError("Couldn't delete this key"),
  });

  if (isLoading) return frame.loading(`Loading ${KEY_NOUN}…`);
  if (!apiKey) {
    return frame.failure({
      kind: "api_key",
      id,
      failure:
        loadFailure(error, KEY_NOUN, { inApp: false }) ??
        notFound(KEY_NOUN, { inApp: false }),
      openIn: false,
    });
  }

  const k = apiKey;
  const category = categorize(k);
  const status = keyStatus(k);
  const live =
    k.isActive &&
    !(k.expiresAt && new Date(k.expiresAt).getTime() <= Date.now());
  const holder = holderName(k);
  const holderPage = holderHref(k);
  const uses = keyUsesOf(k);
  const access = k.access
    ? describeKeyAccess({ access: k.access, grants: k.grants ?? [] })
    : null;
  const grants = k.access === "granted" ? (k.grants ?? []) : [];
  // Its own person changes it, signed in (`setGrants`); an app's key is
  // changed on the app's page, where its approved requests live.
  const own =
    !!viewerId && (k.userId === viewerId || k.linkedUserId === viewerId);
  const canChange =
    own &&
    live &&
    grants.length === 1 &&
    k.holder?.kind !== "app" &&
    !isPodAppAccessKey(k);
  const space = k.workspaceId
    ? (spaces.find((s) => s.id === k.workspaceId) ?? null)
    : null;

  async function save(draft: KeyDraft) {
    const g = draft.grant;
    await setGrants.mutateAsync({
      keyId: k.id,
      grants: [
        {
          permissions: [...g.permissions],
          ...(g.workspaceIds?.length
            ? { workspaceIds: [...g.workspaceIds] }
            : {}),
          ...(g.projectIds?.length ? { projectIds: [...g.projectIds] } : {}),
          ...(g.entityIds?.length ? { entityIds: [...g.entityIds] } : {}),
          ...(grants[0]?.label ? { label: grants[0].label } : {}),
        },
      ],
    });
    await invalidate();
    setEditing(null);
    addToast({ title: "Key changed", color: "default" });
  }

  const danger: DangerAction[] = k.isActive
    ? [
        {
          key: "revoke",
          label: `${resolveActionLabel("revoke")} this key`,
          description: "It stops working at once, wherever it is kept.",
          confirmLabel: resolveActionLabel("revoke"),
          isPending: revoke.isPending,
          consequence: (
            <p>
              Anything that uses {k.keyName} is refused from its next call. A
              revoked key cannot be switched on again: make a new one.
            </p>
          ),
          onConfirm: async () => {
            await revoke.mutateAsync({
              keyId: k.id,
              reason: "Revoked on its page",
            });
            await invalidate();
            addToast({ title: "Key revoked", color: "default" });
          },
        },
      ]
    : [
        {
          key: "delete",
          label: "Delete its record",
          description: "It no longer works; this removes it from the list.",
          confirmLabel: "Delete permanently",
          isPending: deleteRevoked.isPending,
          consequence: (
            <p>The record of {k.keyName} is removed. This cannot be undone.</p>
          ),
          onConfirm: async () => {
            await deleteRevoked.mutateAsync({ keyId: k.id });
            await invalidate();
            router.push(navHref("keys"));
          },
        },
      ];

  return (
    <>
      {frame.object({
        header: {
          kind: "api_key",
          icon: KeyRound,
          noun: `${KEY_NOUN} · ${CATEGORY_LABEL[category]}`,
          title: k.keyName,
          summary:
            holder && category !== "operator"
              ? `Held by ${holder}.`
              : category === "system"
                ? "A system key of this pod."
                : undefined,
          status,
          breadcrumb: frame.breadcrumb?.(k.keyName),
          secondaryActions:
            k.isActive && category !== "system" ? (
              <Button
                size="sm"
                radius="md"
                variant="flat"
                isLoading={rotate.isPending}
                onPress={async () => {
                  const res = await rotate.mutateAsync({ keyId: k.id });
                  await invalidate();
                  if (res.status === "proposed") {
                    addToast({
                      title: "Sent for review",
                      description: "Nothing is replaced until it is approved.",
                      color: "default",
                    });
                    return;
                  }
                  if (res.key) setRevealed({ id: res.id, plaintext: res.key });
                }}
              >
                {resolveActionLabel("rotate")}
              </Button>
            ) : undefined,
        },
        facts: [
          ...(holder
            ? [
                {
                  label: "Held by",
                  value: holderPage ? (
                    <Link
                      href={holderPage}
                      className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                    >
                      {holder}
                    </Link>
                  ) : (
                    holder
                  ),
                },
              ]
            : []),
          {
            label: "Where",
            value: k.workspaceId ? (
              <Link
                href={`${navHref("spaces")}/${encodeURIComponent(k.workspaceId)}`}
                className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                {space?.name ?? resolveObjectNoun("workspace")}
              </Link>
            ) : (
              "The whole pod"
            ),
          },
          ...(k.createdAt
            ? [{ label: "Created", value: formatDate(k.createdAt) }]
            : []),
          { label: "Ends", value: endWords(k) },
          {
            label: "Last used",
            value: formatRelative(k.lastUsedAt, { empty: "Never" }),
          },
          ...(k.usageCount
            ? [
                {
                  label: "Calls",
                  value: k.usageCount.toLocaleString("en-US"),
                },
              ]
            : []),
          { label: "Prefix", value: `${k.keyPrefix}…`, mono: true },
        ],
        factColumns: 4,
        children: (
          <div className="flex flex-col gap-5">
            <SectionCard
              title="What it can do"
              actions={
                canChange && !editing ? (
                  <Button
                    size="sm"
                    radius="md"
                    variant="flat"
                    onPress={() =>
                      setEditing({
                        name: k.keyName,
                        uses,
                        grant: grants[0]!,
                      })
                    }
                  >
                    Change
                  </Button>
                ) : undefined
              }
            >
              {editing ? (
                <div className="flex flex-col gap-3">
                  <p className="text-[12px] text-foreground/65">
                    You can narrow a live key here. For more, make a new key.
                  </p>
                  <AccessEditor
                    draft={editing}
                    scope={keyScope(editing.grant)}
                    ctx={ctx}
                    ceiling={{ grant: grants[0]!, uses }}
                    lifetime={false}
                    doors={false}
                    onChange={setEditing}
                  />
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      size="sm"
                      radius="md"
                      variant="light"
                      onPress={() => setEditing(null)}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      radius="md"
                      color="primary"
                      isLoading={setGrants.isPending}
                      isDisabled={editing.grant.permissions.length === 0}
                      onPress={() => void save(editing)}
                    >
                      Save
                    </Button>
                  </div>
                </div>
              ) : access === null ? (
                // A list that does not carry access: say so, never "nothing".
                <p className="text-[12.5px] text-foreground/70">
                  This pod did not say what this key can do. Its scopes are in
                  Advanced.
                </p>
              ) : grants.length === 0 ? (
                <p className="text-[12.5px] text-foreground/80">
                  {access.sentence}
                </p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {grants.map((g, i) => (
                    <li key={i} className="flex flex-col gap-1">
                      {g.label ? (
                        <span className="text-[12px] font-medium text-foreground/75">
                          {g.label}
                        </span>
                      ) : null}
                      <AccessSummary
                        draft={{ name: k.keyName, uses, grant: g }}
                        scope={keyScope(g)}
                        ctx={ctx}
                        lifetime={endWords(k)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
            {uses.includes("hub") && k.isActive ? (
              <SectionCard title="How to use it">
                <div className="flex flex-col gap-1">
                  <span className="text-[11.5px] text-foreground/65">
                    Hub API address
                  </span>
                  <Snippet
                    symbol=""
                    size="sm"
                    className="overflow-hidden font-mono"
                    classNames={{ base: "bg-foreground/[0.05]" }}
                  >
                    {`${POD_URL}/api/hub`}
                  </Snippet>
                </div>
              </SectionCard>
            ) : null}
          </div>
        ),
        advanced: {
          ids: [
            { label: "Key id", value: k.id },
            { label: "Scopes", value: normalizeScopes(k.scope).join(", ") },
            ...grants.map((g, i) => ({
              label: grants.length > 1 ? `Permissions ${i + 1}` : "Permissions",
              value: g.permissions.join(", "),
            })),
          ],
          raw: k,
        },
        danger,
      })}
      {revealed ? (
        <RevealKeyModal
          keyName={k.keyName}
          plaintext={revealed.plaintext}
          note="rotated"
          onClose={() => {
            const next = revealed.id;
            setRevealed(null);
            router.push(keyPageHref(next));
          }}
        />
      ) : null}
    </>
  );
}
