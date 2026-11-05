"use client";

/**
 * Change what an existing key may do: the same access and where pickers the
 * New key page draws (`KeySections`, narrowed to those two sections), opened
 * on the key's live grants, saved through `apiKeys.setGrants`. Nothing is
 * sent until the person presses Save, and the sentence above Save says what
 * that changes. The rules (who may, what is sent, what changed) are
 * `key-edit-model`; this file only draws them.
 */

import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Spinner,
  addToast,
} from "@heroui/react";
import { useMemo, useState } from "react";
import {
  describeKey,
  type KeyDraft,
  type ListedGrantDraft,
} from "@synap-core/types/grants";
import { trpc } from "../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { useT } from "../../../../lib/i18n/locale-provider";
import { KEYS_CATALOGS } from "./copy";
import {
  capList,
  describeEdit,
  editProblems,
  keyEditDoor,
  setGrantsInput,
  type ListedKey,
} from "./key-edit-model";
import { KeySections, type KeyPlace } from "./key-sections";
import { useSetKeyGrants } from "../../../_lib/presence/use-sensitive-actions";

/** The grant is all this editor changes: a draft shell around it for the shared sections. */
const asKeyDraft = (grant: ListedGrantDraft): KeyDraft => ({
  name: "",
  uses: [],
  grant,
});

export function KeyPermissionsModal({
  keyId,
  keyName,
  confinedSpaceId,
  onClose,
}: {
  keyId: string;
  keyName: string;
  /** The space the key is confined to, when it is (its Where is that space). */
  confinedSpaceId: string | null;
  onClose: () => void;
}) {
  const t = useT(KEYS_CATALOGS);
  const list = trpc.apiKeys.list.useQuery(undefined, { staleTime: 30_000 });
  const listed = list.data?.find((k) => k.id === keyId) as
    ListedKey | undefined;
  const door = list.data ? keyEditDoor(listed) : null;

  return (
    <Modal
      isOpen
      onOpenChange={(open) => !open && onClose()}
      size="3xl"
      scrollBehavior="inside"
    >
      <ModalContent>
        <ModalHeader className="text-[15px]">
          {t("edit.title", { name: keyName })}
        </ModalHeader>
        {list.isError ? (
          <>
            <ModalBody>
              <p role="alert" className="text-[12.5px] text-danger">
                {t("edit.loadFailed")} {list.error.message}
              </p>
            </ModalBody>
            <ModalFooter>
              <Button
                size="sm"
                variant="flat"
                onPress={() => void list.refetch()}
              >
                {t("edit.retry")}
              </Button>
              <Button size="sm" variant="light" onPress={onClose}>
                {t("edit.cancel")}
              </Button>
            </ModalFooter>
          </>
        ) : !door ? (
          <ModalBody>
            <div
              role="status"
              aria-label={t("edit.loading")}
              className="flex justify-center py-8"
            >
              <Spinner size="sm" />
            </div>
          </ModalBody>
        ) : door.kind === "edit" ? (
          <Editor
            keyId={keyId}
            keyName={keyName}
            confinedSpaceId={confinedSpaceId}
            initial={door.drafts}
            onClose={onClose}
          />
        ) : (
          <>
            <ModalBody>
              <p className="text-[12.5px] text-foreground/80">
                {door.kind === "app" ? t("edit.app") : t("edit.notYours")}
              </p>
            </ModalBody>
            <ModalFooter>
              <Button size="sm" variant="light" onPress={onClose}>
                {t("edit.cancel")}
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}

function Editor({
  keyId,
  keyName,
  confinedSpaceId,
  initial,
  onClose,
}: {
  keyId: string;
  keyName: string;
  confinedSpaceId: string | null;
  initial: ListedGrantDraft[];
  onClose: () => void;
}) {
  const t = useT(KEYS_CATALOGS);
  const [drafts, setDrafts] = useState<ListedGrantDraft[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const utils = trpc.useUtils();
  // With the proof of presence (W3 slice 3): a sensitive action.
  const setGrants = useSetKeyGrants();

  const profiles = trpc.profiles.list.useQuery(undefined, {
    staleTime: 60_000,
  });
  const spacesQuery = trpc.workspaces.list.useQuery(undefined, {
    staleTime: 60_000,
  });
  const projectsQuery = trpc.projects.list.useQuery(
    { limit: 200 },
    { staleTime: 60_000 }
  );
  const kinds = useMemo(
    () =>
      (profiles.data?.profiles ?? []).map((p) => ({
        slug: p.slug,
        name: p.displayName || p.slug,
      })),
    [profiles.data]
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
  const pinnedSpace = confinedSpaceId
    ? (spaces.find((s) => s.id === confinedSpaceId) ?? {
        id: confinedSpaceId,
        name: "…",
      })
    : null;
  const placesFailed =
    spacesQuery.isError || projectsQuery.isError || profiles.isError
      ? {
          retry: () => {
            void spacesQuery.refetch();
            void projectsQuery.refetch();
            void profiles.refetch();
          },
        }
      : null;

  const change = describeEdit(initial, drafts);
  const problems = editProblems(drafts);
  const canSave =
    change.changed && !problems.empty && problems.invalid.length === 0;

  const line = (key: "edit.added" | "edit.removed", words: string[]) => {
    const { shown, more } = capList(words);
    const list = shown.join(", ");
    return t(key, {
      list: more > 0 ? t("edit.more", { list, n: more }) : list,
    });
  };
  const sentence = !change.changed
    ? t("edit.unchanged")
    : [
        change.added.length > 0 ? line("edit.added", change.added) : null,
        change.removed.length > 0 ? line("edit.removed", change.removed) : null,
        change.placeChanged ? t("edit.place") : null,
      ]
        .filter(Boolean)
        .join(" ");
  const marks = drafts.flatMap((d) =>
    describeKey(asKeyDraft(d), { kindNames }).marks.map((m) => m.label)
  );

  async function save() {
    if (!canSave || setGrants.isPending) return;
    setError(null);
    try {
      await setGrants.mutateAsync({ keyId, grants: setGrantsInput(drafts) });
      void utils.apiKeys.list.invalidate();
      void utils.apiKeys.adminKeyDetail.invalidate({ keyId });
      void utils.apiKeys.adminListAll.invalidate();
      addToast({
        title: t("edit.saved", { name: keyName }),
        color: "default",
      });
      onClose();
    } catch (err) {
      if (
        redirectToLoginIfUnauthorized(
          err as { data?: { code?: string | null } | null } | null
        )
      )
        return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <>
      <ModalBody className="gap-5">
        <p className="text-[12.5px] text-foreground/75">{t("edit.intro")}</p>
        {drafts.map((d, i) => (
          <div key={i} className="flex flex-col gap-3">
            {drafts.length > 1 ? (
              <h3 className="text-[12.5px] font-medium text-foreground">
                {d.label?.trim() || t("edit.grant", { n: i + 1 })}
              </h3>
            ) : null}
            <KeySections
              sections={["access", "where"]}
              draft={asKeyDraft(d)}
              onChange={(next) =>
                setDrafts((all) =>
                  all.map((g, j) =>
                    j === i ? { ...next.grant, roleId: g.roleId } : g
                  )
                )
              }
              kinds={kinds}
              spaces={spaces}
              projects={projects}
              placesFailed={placesFailed}
              pinnedSpace={pinnedSpace}
            />
          </div>
        ))}
      </ModalBody>
      <ModalFooter className="flex-col items-stretch gap-2">
        <div role="status" className="flex flex-col gap-1.5">
          <p
            className={`text-[12.5px] ${
              change.widens && change.changed
                ? "text-warning"
                : "text-foreground/85"
            }`}
          >
            {sentence}
            {change.widens && change.changed ? ` ${t("edit.widens")}` : ""}
          </p>
          {marks.length > 0 ? (
            <p className="text-[11.5px] text-danger">
              {[...new Set(marks)].join(" · ")}
            </p>
          ) : null}
          {problems.empty ? (
            <p className="text-[12px] text-foreground/75">{t("edit.empty")}</p>
          ) : null}
          {problems.invalid.map((m) => (
            <p key={m} className="text-[12px] text-danger">
              {m}
            </p>
          ))}
        </div>
        {error ? (
          <p role="alert" className="text-[12px] text-danger">
            {t("edit.failed")}: {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="light" onPress={onClose}>
            {t("edit.cancel")}
          </Button>
          <Button
            size="sm"
            color="primary"
            radius="md"
            isDisabled={!canSave}
            isLoading={setGrants.isPending}
            onPress={() => void save()}
          >
            {error ? t("edit.retry") : t("edit.save")}
          </Button>
        </div>
      </ModalFooter>
    </>
  );
}
