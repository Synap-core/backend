"use client";

/**
 * Add people — invite one email, pod-wide or into chosen workspaces, and
 * hand back the invite link(s) (the email is a bonus when the pod can send).
 */

import {
  Button,
  Checkbox,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Spinner,
} from "@heroui/react";
import { Check, Copy, Mail } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";

const ROLE_OPTIONS: Array<{
  key: "admin" | "editor" | "viewer";
  label: string;
  hint: string;
}> = [
  {
    key: "admin",
    label: "Admin",
    hint: "Full access, can sign in to the Pod Console",
  },
  { key: "editor", label: "Editor", hint: "Can read and write content" },
  { key: "viewer", label: "Viewer", hint: "Read-only access" },
];

type InviteResultItem = {
  token: string;
  emailSent: boolean;
  workspaceName?: string;
};

export function AddPeopleModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "editor" | "viewer">("editor");
  const [scope, setScope] = useState<"pod" | "workspaces">("pod");
  const [selectedWs, setSelectedWs] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<InviteResultItem[] | null>(null);
  const [sending, setSending] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const utils = trpc.useUtils();
  const wsQuery = trpc.workspaces.adminListAll.useQuery(undefined, {
    enabled: isOpen && scope === "workspaces",
    staleTime: 60_000,
  });

  useEffect(() => {
    if (wsQuery.isError) {
      redirectToLoginIfUnauthorized(wsQuery.error);
    }
  }, [wsQuery.isError, wsQuery.error]);

  const userWorkspaces = useMemo(
    () =>
      (wsQuery.data ?? []).filter((ws) => {
        const s = (ws.settings ?? {}) as Record<string, unknown>;
        return s.systemSlug !== "pod-admin";
      }),
    [wsQuery.data]
  );

  const createInvite = trpc.workspaces.createInvite.useMutation();

  const origin = typeof window !== "undefined" ? window.location.origin : "";

  async function handleSubmit() {
    const trimEmail = email.trim();
    if (!trimEmail) return;
    if (scope === "workspaces" && selectedWs.size === 0) {
      setError("Select at least one workspace.");
      return;
    }
    setError(null);
    setSending(true);
    try {
      if (scope === "pod") {
        const data = await createInvite.mutateAsync({
          type: "pod",
          email: trimEmail,
          role,
        });
        setResults([{ token: data.token, emailSent: data.emailSent }]);
      } else {
        const items: InviteResultItem[] = [];
        for (const wsId of Array.from(selectedWs)) {
          const ws = userWorkspaces.find((w) => w.id === wsId);
          const data = await createInvite.mutateAsync({
            type: "workspace",
            workspaceId: wsId,
            email: trimEmail,
            role,
          });
          items.push({
            token: data.token,
            emailSent: data.emailSent,
            workspaceName: ws?.name,
          });
        }
        setResults(items);
      }
      void utils.workspaces.listInvites.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create invite");
    } finally {
      setSending(false);
    }
  }

  function handleCopy(url: string, idx: number) {
    void navigator.clipboard.writeText(url).then(() => {
      setCopiedIdx(idx);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopiedIdx(null), 2000);
    });
  }

  function handleClose() {
    setEmail("");
    setRole("editor");
    setScope("pod");
    setSelectedWs(new Set());
    setError(null);
    setResults(null);
    setSending(false);
    onClose();
  }

  const canSubmit =
    !!email.trim() && !sending && (scope === "pod" || selectedWs.size > 0);

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      placement="center"
      size="md"
      isDismissable={!sending}
    >
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1 border-b border-foreground/[0.06] px-6 py-4">
          <h2 className="text-[15px] font-medium text-foreground">
            Add people
          </h2>
          <p className="text-[12px] text-foreground/55">
            {results
              ? "Share these invite links with the recipient."
              : "Invite links are valid for 7 days."}
          </p>
        </ModalHeader>

        <ModalBody className="gap-4 px-6 py-4">
          {results ? (
            <div className="flex flex-col gap-2">
              {results.map((r, i) => {
                const url = `${origin}/invite/${r.token}`;
                return (
                  <div key={r.token} className="flex flex-col gap-1.5">
                    {r.workspaceName ? (
                      <span className="text-[11px] font-medium text-foreground/55">
                        {r.workspaceName}
                      </span>
                    ) : null}
                    <div
                      className={`rounded-md px-3 py-1.5 text-[11.5px] ring-1 ring-inset ${r.emailSent ? "bg-status-healthy/10 text-status-healthy ring-status-healthy/20" : "bg-foreground/[0.04] text-foreground/60 ring-foreground/10"}`}
                    >
                      {r.emailSent
                        ? "Email sent — link is a backup."
                        : "No email service — share this link directly."}
                    </div>
                    <div className="flex items-center gap-2 rounded-md bg-foreground/[0.04] px-3 py-2 ring-1 ring-inset ring-foreground/10">
                      <span className="flex-1 truncate font-mono text-[11px] text-foreground/65">
                        {url}
                      </span>
                      <Button
                        isIconOnly
                        size="sm"
                        variant="flat"
                        radius="md"
                        onPress={() => handleCopy(url, i)}
                        aria-label="Copy"
                      >
                        {copiedIdx === i ? (
                          <Check className="h-3.5 w-3.5 text-status-healthy" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <>
              <Input
                label="Email"
                labelPlacement="outside"
                type="email"
                placeholder="colleague@example.com"
                value={email}
                onValueChange={setEmail}
                radius="md"
                variant="flat"
                startContent={
                  <Mail className="h-3.5 w-3.5 text-foreground/40" />
                }
                isDisabled={sending}
              />

              <div className="flex flex-col gap-1.5">
                <span className="text-[12px] font-medium text-foreground/70">
                  Role
                </span>
                <div className="flex gap-2">
                  {ROLE_OPTIONS.map((opt) => (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => setRole(opt.key)}
                      disabled={sending}
                      className={`flex-1 rounded-md border px-3 py-2 text-left transition-colors ${role === opt.key ? "border-primary/60 bg-primary/10 text-primary" : "border-foreground/10 bg-foreground/[0.03] text-foreground/70 hover:border-foreground/20"}`}
                    >
                      <div className="text-[12px] font-medium">{opt.label}</div>
                      <div className="mt-0.5 text-[10.5px] opacity-70">
                        {opt.hint}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-[12px] font-medium text-foreground/70">
                  Access scope
                </span>
                <div className="flex gap-1 rounded-md bg-foreground/[0.04] p-1">
                  {(["pod", "workspaces"] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setScope(s)}
                      disabled={sending}
                      className={`flex-1 rounded py-1.5 text-[12px] font-medium transition-colors ${scope === s ? "bg-foreground/[0.08] text-foreground" : "text-foreground/50 hover:text-foreground/70"}`}
                    >
                      {s === "pod" ? "Pod-wide" : "Specific workspaces"}
                    </button>
                  ))}
                </div>
                {scope === "pod" && (
                  <p className="text-[11.5px] text-foreground/45">
                    Person joins all existing workspaces. Admins can also sign
                    in to the Pod Console.
                  </p>
                )}
              </div>

              {scope === "workspaces" && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-[12px] font-medium text-foreground/70">
                    Workspaces
                  </span>
                  {wsQuery.isLoading ? (
                    <div className="h-20 rounded-md bg-foreground/[0.04] shimmer-pulse" />
                  ) : userWorkspaces.length === 0 ? (
                    <p className="text-[12px] text-foreground/45">
                      No workspaces found.
                    </p>
                  ) : (
                    <div className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-md bg-foreground/[0.03] p-2 ring-1 ring-inset ring-foreground/10">
                      {userWorkspaces.map((ws) => (
                        <Checkbox
                          key={ws.id}
                          size="sm"
                          isSelected={selectedWs.has(ws.id)}
                          onValueChange={(checked) => {
                            setSelectedWs((prev) => {
                              const next = new Set(prev);
                              if (checked) next.add(ws.id);
                              else next.delete(ws.id);
                              return next;
                            });
                          }}
                          classNames={{
                            label: "text-[12px] text-foreground/80",
                          }}
                        >
                          {ws.name}
                        </Checkbox>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {error ? (
                <div className="rounded-md bg-status-down/10 px-3 py-2 text-[12px] text-status-down ring-1 ring-inset ring-status-down/20">
                  {error}
                </div>
              ) : null}
            </>
          )}
        </ModalBody>

        <ModalFooter className="border-t border-foreground/[0.06] px-6 py-3">
          <Button
            variant="flat"
            radius="md"
            size="sm"
            onPress={handleClose}
            isDisabled={sending}
          >
            {results ? "Done" : "Cancel"}
          </Button>
          {!results ? (
            <Button
              color="primary"
              variant="solid"
              radius="md"
              size="sm"
              onPress={() => void handleSubmit()}
              isDisabled={!canSubmit}
              startContent={sending ? <Spinner size="sm" /> : null}
            >
              {sending ? "Sending…" : "Send invite"}
            </Button>
          ) : null}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
