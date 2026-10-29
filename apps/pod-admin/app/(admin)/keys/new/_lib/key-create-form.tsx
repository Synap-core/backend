"use client";

/**
 * The New key page's state: the draft (the shared key model), where it acts
 * and who holds it, which steps are answered, the reads the steps need, and
 * the ONE mint. Layout is `key-steps.tsx` + `KeyReviewBar`; which door mints
 * what is `key-form-model`.
 *
 * Purpose first (decision a29a40d4, finding 44a38552): the four steps of
 * `KEY_DRAFT_STEPS` close as they are answered. `?space=` answers "Where it
 * acts", `?template=` answers "What it is for", so a door from a space or a
 * link lands on the next open step.
 */

import { Snippet, addToast } from "@heroui/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  EMPTY_KEY_DRAFT,
  keyDraftFromTemplateAt,
  keyHoldersForScope,
  keyScope,
  keyStepStates,
  setGrantPermissions,
  setKeyGrant,
  setKeyScope,
  templateFitsScope,
  templatesForScope,
  validateKeyDraft,
  type GrantRole,
  type KeyDraft,
  type KeyDraftStepId,
  type KeyScope,
} from "@synap-core/types/grants";
import { buildObjectActionTitle } from "@synap-core/types/vocabulary";
import { POD_URL, trpc } from "../../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../../lib/auth-redirect";
import { PageHeader, PageShell } from "../../../components/page-header";
import { RevealKeyModal } from "../../_lib/key-modals";
import { AccessEditor, AccessSummary } from "../../_lib/key-access";
import {
  KeyReviewBar,
  KeyStep,
  NameStepBody,
  PurposeStepBody,
  WhereStepBody,
  placeWords,
  type KeyPlace,
  type KeyStepView,
} from "../../_lib/key-steps";
import {
  afterCreateHref,
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
  const ctx = useMemo(
    () => ({
      kinds: (profilesQuery.data?.profiles ?? []).map((p) => ({
        slug: p.slug,
        name: p.displayName || undefined,
      })),
    }),
    [profilesQuery.data]
  );
  const kindNames = useMemo(
    () =>
      Object.fromEntries(
        ctx.kinds.flatMap((k) => (k.name ? [[k.slug, k.name]] : []))
      ),
    [ctx]
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

  const templateFor = (id: string | null) =>
    id ? templates.find((t) => t.id === id) : undefined;
  const [draft, setDraft] = useState<KeyDraft>(() => {
    const named = params.name
      ? { ...EMPTY_KEY_DRAFT, name: params.name }
      : EMPTY_KEY_DRAFT;
    const base = params.workspaceId
      ? setKeyScope(named, "space", params.workspaceId)
      : named;
    const t = templateFor(params.templateId);
    return t && templateFitsScope(t, keyScope(base.grant))
      ? keyDraftFromTemplateAt(t, base)
      : base;
  });
  // What the person answered that the draft cannot say by itself.
  const [answers, setAnswers] = useState(() => ({
    where: !!params.workspaceId,
    purpose: !!templateFor(params.templateId),
    somethingElse: false,
  }));
  // A closed step the person reopened ("Change", "Adjust").
  const [editing, setEditing] = useState<KeyDraftStepId | null>(null);

  // A `?template=` naming a stored role is applied when the roles arrive.
  const pending = useRef(
    !!params.templateId && !templateFor(params.templateId)
  );
  useEffect(() => {
    if (!pending.current) return;
    const t = templates.find((r) => r.id === params.templateId);
    if (!t) return;
    pending.current = false;
    setDraft((d) =>
      templateFitsScope(t, keyScope(d.grant)) ? keyDraftFromTemplateAt(t, d) : d
    );
    setAnswers((a) => ({ ...a, purpose: true }));
  }, [templates, params.templateId]);

  const scope: KeyScope = keyScope(draft.grant);
  const placeId =
    scope === "space"
      ? (draft.grant.workspaceIds?.[0] ?? null)
      : scope === "project"
        ? (draft.grant.projectIds?.[0] ?? null)
        : null;
  const holders = keyHoldersForScope(scope);
  const { offered, hidden } = templatesForScope(templates, scope);
  const steps = keyStepStates(draft, answers);
  const answered = (id: KeyDraftStepId) =>
    steps.find((s) => s.id === id)!.answered;
  const firstOpen = steps.find((s) => s.open)?.id ?? null;
  /** A step is open when it is the first unanswered one, or reopened; the name stays open once reached. */
  const view = (id: KeyDraftStepId): KeyStepView => {
    if (editing === id) return "open";
    if (id === "name")
      return steps.slice(0, 3).every((s) => s.answered) ? "open" : "later";
    if (firstOpen === id) return "open";
    return answered(id) ? "closed" : "later";
  };

  // A name the template filled follows the next template; a typed one stays.
  const templateName = templateFor(draft.templateId ?? null)?.name;
  const untyped = (d: KeyDraft) => (d.name === templateName ? "" : d.name);

  function pickScope(next: KeyScope, id: string | null) {
    let d = setKeyScope(draft, next, id);
    const t = templateFor(d.templateId ?? null);
    const fits = !t || templateFitsScope(t, next);
    if (!fits) {
      // The template does not work here: ask what the key is for again.
      d = {
        ...setKeyGrant(d, setGrantPermissions(d.grant, [])),
        templateId: null,
        name: untyped(d),
      };
    }
    setDraft(d);
    if (!keyHoldersForScope(next).some((h) => h.id === holder))
      setHolder("person");
    setAnswers((a) => ({
      ...a,
      where: true,
      purpose: fits && a.purpose,
      somethingElse: fits && a.somethingElse,
    }));
    setEditing(null);
  }

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
  const ready = validation.ok && answers.where && answers.purpose;

  async function submit() {
    if (!ready || busy) return;
    const call = keyMintCall(holder, draft, scope === "space" ? placeId : null);
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
      if (
        redirectToLoginIfUnauthorized(
          err as { data?: { code?: string | null } | null } | null
        )
      )
        return;
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
  const holderWords =
    holders.find((h) => h.id === holder)?.label ?? holders[0]!.label;

  return (
    <PageShell>
      <PageHeader
        title="New key"
        description={
          <>
            Say what the key is for; it is shown once.{" "}
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
        <KeyStep
          id="where"
          view={view("where")}
          summary={`${placeWords(scope, placeId, spaces, projects)} · ${holderWords}`}
          onChange={() => setEditing("where")}
        >
          <WhereStepBody
            scope={answers.where ? scope : null}
            placeId={placeId}
            spaces={spaces}
            projects={projects}
            placesFailed={placesFailed}
            holder={holder}
            holders={holders}
            onPick={pickScope}
            onHolder={setHolder}
          />
        </KeyStep>
        <KeyStep
          id="purpose"
          view={view("purpose")}
          summary={
            answers.somethingElse
              ? "Something else"
              : (templateFor(draft.templateId ?? null)?.name ?? null)
          }
          onChange={() => setEditing("purpose")}
        >
          <PurposeStepBody
            offered={offered}
            hidden={hidden}
            selectedId={answers.purpose ? (draft.templateId ?? null) : null}
            somethingElse={answers.somethingElse}
            rolesFailed={rolesFailed}
            onTemplate={(t) => {
              setDraft(
                keyDraftFromTemplateAt(t, { ...draft, name: untyped(draft) })
              );
              setAnswers((a) => ({
                ...a,
                purpose: true,
                somethingElse: false,
              }));
              setEditing(null);
            }}
            onSomethingElse={() => {
              setDraft({
                ...setKeyGrant(draft, setGrantPermissions(draft.grant, [])),
                templateId: null,
                name: untyped(draft),
              });
              setAnswers((a) => ({
                ...a,
                purpose: true,
                somethingElse: true,
              }));
              setEditing("access");
            }}
          />
        </KeyStep>
        <KeyStep
          id="access"
          view={view("access")}
          summary={<AccessSummary draft={draft} scope={scope} ctx={ctx} />}
          changeLabel="Adjust"
          onChange={() => setEditing("access")}
        >
          <AccessEditor
            draft={draft}
            scope={scope}
            ctx={ctx}
            onChange={setDraft}
          />
          {editing === "access" && answered("access") ? (
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="text-[12.5px] font-medium text-primary underline-offset-2 hover:underline"
              >
                Done
              </button>
            </div>
          ) : null}
        </KeyStep>
        <KeyStep id="name" view={view("name")}>
          <NameStepBody draft={draft} onChange={setDraft} />
        </KeyStep>
        <KeyReviewBar
          draft={draft}
          validation={validation}
          unanswered={[
            ...(answers.where ? [] : (["where"] as const)),
            ...(answers.purpose ? [] : (["purpose"] as const)),
          ]}
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
            router.push(afterCreateHref(id));
          }}
        />
      ) : null}
    </PageShell>
  );
}
