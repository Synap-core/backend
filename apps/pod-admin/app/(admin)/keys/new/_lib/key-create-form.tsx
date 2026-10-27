"use client";

/**
 * The New key page's state: the draft (the shared key model), who holds the
 * key, the reads the sections need, and the ONE mint. Layout is
 * `KeySections` + `KeyReviewBar`; which door mints what is `key-form-model`.
 */

import { Snippet, addToast } from "@heroui/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  EMPTY_KEY_DRAFT,
  keyDraftFromTemplate,
  validateKeyDraft,
  type GrantRole,
  type KeyDraft,
} from "@synap-core/types/grants";
import { buildObjectActionTitle } from "@synap-core/types/vocabulary";
import { POD_URL, trpc } from "../../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../../lib/auth-redirect";
import { PageHeader, PageShell } from "../../../components/page-header";
import { RevealKeyModal } from "../../_lib/key-modals";
import {
  ChoiceCard,
  KeyReviewBar,
  KeySections,
  type KeyPlace,
} from "../../_lib/key-sections";
import {
  afterCreateHref,
  defaultTemplateId,
  holderChoices,
  keyMintCall,
  keyPageParams,
  keyTemplates,
  keysListHref,
  type KeyHolder,
} from "../../_lib/key-form-model";

export function KeyCreateForm() {
  const router = useRouter();
  const search = useSearchParams();
  const params = useMemo(() => keyPageParams((k) => search.get(k)), [search]);
  const [holder, setHolder] = useState<KeyHolder>(params.holder);

  const rolesQuery = trpc.grantRoles.list.useQuery(undefined, {
    staleTime: 60_000,
  });
  const profilesQuery = trpc.profiles.list.useQuery(undefined, {
    staleTime: 60_000,
  });
  const spacesQuery = trpc.workspaces.list.useQuery(undefined, {
    staleTime: 60_000,
  });
  const projectsQuery = trpc.projects.list.useQuery(
    { limit: 200 },
    { staleTime: 60_000 }
  );

  const templates = useMemo(
    () => keyTemplates((rolesQuery.data ?? []) as GrantRole[]),
    [rolesQuery.data]
  );
  const kinds = useMemo(
    () =>
      (profilesQuery.data ?? []).map((p) => ({
        slug: p.slug,
        name: p.displayName || p.slug,
      })),
    [profilesQuery.data]
  );
  const kindNames = useMemo(
    () => Object.fromEntries(kinds.map((k) => [k.slug, k.name])),
    [kinds]
  );
  const spaces = useMemo<KeyPlace[]>(
    () => (spacesQuery.data ?? []).map((w) => ({ id: w.id, name: w.name })),
    [spacesQuery.data]
  );
  const projects = useMemo<KeyPlace[]>(
    () =>
      (projectsQuery.data?.items ?? []).map((p) => ({
        id: p.id,
        name: p.name,
      })),
    [projectsQuery.data]
  );
  const pinnedSpace = params.workspaceId
    ? (spaces.find((s) => s.id === params.workspaceId) ?? {
        id: params.workspaceId,
        name: "this space",
      })
    : null;

  const templateFor = (id: string | null) =>
    id ? templates.find((t) => t.id === id) : undefined;
  const [draft, setDraft] = useState<KeyDraft>(() => {
    const t = templateFor(
      params.templateId ?? defaultTemplateId(params.holder)
    );
    const base = params.name
      ? { ...EMPTY_KEY_DRAFT, name: params.name }
      : EMPTY_KEY_DRAFT;
    return t ? keyDraftFromTemplate(t, base) : base;
  });
  // A `?template=` naming a stored role is applied when the roles arrive.
  const pending = useRef(
    !!params.templateId && !templateFor(params.templateId)
  );
  useEffect(() => {
    if (!pending.current) return;
    const t = templates.find((r) => r.id === params.templateId);
    if (!t) return;
    pending.current = false;
    setDraft((d) => keyDraftFromTemplate(t, d));
  }, [templates, params.templateId]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{
    id: string;
    key: string;
    name: string;
    hub: boolean;
  } | null>(null);

  const utils = trpc.useUtils();
  const create = trpc.apiKeys.create.useMutation();
  const createSystem = trpc.apiKeys.createSystemKey.useMutation();
  const createService = trpc.apiKeys.adminCreateServiceKey.useMutation();

  const validation = validateKeyDraft(draft);

  async function submit() {
    if (!validation.ok || busy) return;
    const call = keyMintCall(holder, draft, params.workspaceId);
    setBusy(true);
    setError(null);
    try {
      const res =
        call.door === "createSystemKey"
          ? await createSystem.mutateAsync(call.input)
          : call.door === "adminCreateServiceKey"
            ? await createService.mutateAsync(call.input)
            : await create.mutateAsync(call.input);
      void utils.apiKeys.adminListAll.invalidate();
      void utils.apiKeys.listSystemKeys.invalidate();
      if ("proposalId" in res && res.proposalId) {
        addToast({
          title: "Sent for approval",
          description: "Making this key needs an approval on this pod.",
          color: "default",
        });
        router.push(`/proposal/${encodeURIComponent(res.proposalId)}`);
        return;
      }
      if (res.key)
        setCreated({
          id: res.id,
          key: res.key,
          name: call.input.keyName,
          hub: call.input.uses.includes("hub"),
        });
    } catch (err) {
      if (redirectToLoginIfUnauthorized(err)) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const rolesFailed = rolesQuery.isError
    ? { retry: () => void rolesQuery.refetch() }
    : null;
  const placesFailed =
    spacesQuery.isError || projectsQuery.isError
      ? {
          retry: () => {
            void spacesQuery.refetch();
            void projectsQuery.refetch();
          },
        }
      : null;

  return (
    <PageShell>
      <PageHeader
        title="New key"
        description={
          <>
            Start from a template, then narrow it. The key is shown once.{" "}
            <Link
              href={keysListHref(params.workspaceId)}
              className="underline decoration-foreground/30 underline-offset-2"
            >
              Back to the keys
            </Link>
          </>
        }
      />
      <div className="mx-auto flex max-w-3xl flex-col">
        <KeySections
          draft={draft}
          onChange={setDraft}
          kinds={kinds}
          templates={templates}
          rolesFailed={rolesFailed}
          spaces={spaces}
          projects={projects}
          placesFailed={placesFailed}
          pinnedSpace={pinnedSpace}
          holderSlot={
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-foreground/85">
                Who holds it
              </span>
              <div className="grid gap-2 sm:grid-cols-2">
                {holderChoices(!!params.workspaceId).map((h) => (
                  <ChoiceCard
                    key={h.id}
                    title={h.label}
                    description={h.description}
                    selected={holder === h.id}
                    onPress={() => setHolder(h.id)}
                  />
                ))}
              </div>
            </div>
          }
        />
        <KeyReviewBar
          draft={draft}
          validation={validation}
          kindNames={kindNames}
          primaryLabel={buildObjectActionTitle({
            action: "create",
            objectKind: "api_key",
          })}
          onPrimary={() => void submit()}
          busy={busy}
          error={error}
        />
      </div>
      {created ? (
        <RevealKeyModal
          keyName={created.name}
          plaintext={created.key}
          note="created"
          usage={
            created.hub ? (
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
            ) : null
          }
          onClose={() => {
            const id = created.id;
            setCreated(null);
            router.push(afterCreateHref(params.workspaceId, id));
          }}
        />
      ) : null}
    </PageShell>
  );
}
