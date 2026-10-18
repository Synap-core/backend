"use client";

/**
 * Pod-wide default models, one per slot. Part of `/intelligence` (`page.tsx`).
 */

import {
  addToast,
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from "@heroui/react";
import {
  Eye,
  Layers,
  Radio,
  Settings,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { trpc } from "../../../../lib/trpc";
import { readableError } from "../../../../lib/format";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { SectionCard } from "../../components/section-card";

/**
 * The pod-wide model defaults are now exposed by `intelligence.getPodDefaults`
 * / `intelligence.setPodDefaults`. Each slot accepts `null` to mean
 * "Inherit from default IS"; a string is the model id (free-form, since
 * the registry of valid models is provider-dependent and not enumerated
 * by the backend yet).
 */

interface ModelSlot {
  key: "chat" | "reasoning" | "embedding" | "vision";
  label: string;
  icon: LucideIcon;
  hint: string;
}

const MODEL_SLOTS: ModelSlot[] = [
  {
    key: "chat",
    label: "Chat model",
    icon: Sparkles,
    hint: "Used for general chat across new workspaces",
  },
  {
    key: "reasoning",
    label: "Reasoning model",
    icon: Layers,
    hint: "For deeper reasoning and orchestration",
  },
  {
    key: "embedding",
    label: "Embedding model",
    icon: Radio,
    hint: "Vector embeddings for memory + search",
  },
  {
    key: "vision",
    label: "Vision model",
    icon: Eye,
    hint: "Image understanding for capture + chat",
  },
];

type DefaultsState = {
  chatModelId: string | null;
  reasoningModelId: string | null;
  embeddingModelId: string | null;
  visionModelId: string | null;
};

const SLOT_TO_FIELD: Record<ModelSlot["key"], keyof DefaultsState> = {
  chat: "chatModelId",
  reasoning: "reasoningModelId",
  embedding: "embeddingModelId",
  vision: "visionModelId",
};

export function DefaultModelsSection() {
  const [editing, setEditing] = useState(false);
  const query = trpc.intelligence.getPodDefaults.useQuery(undefined, {
    staleTime: 60_000,
  });

  useEffect(() => {
    if (query.isError) {
      redirectToLoginIfUnauthorized(query.error);
    }
  }, [query.isError, query.error]);
  const isAuthRedirecting = query.error?.data?.code === "UNAUTHORIZED";

  const defaults = query.data?.defaults;

  return (
    <SectionCard
      title="Default models"
      hint="Pod-wide defaults — spaces inherit unless overridden in the app"
      actions={
        <Button
          size="sm"
          variant="flat"
          radius="md"
          color="primary"
          startContent={<Settings className="h-3 w-3" />}
          onPress={() => setEditing(true)}
          isDisabled={query.isLoading || query.isError || isAuthRedirecting}
        >
          Edit defaults
        </Button>
      }
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {MODEL_SLOTS.map((slot) => {
          const field = SLOT_TO_FIELD[slot.key];
          const value = defaults ? defaults[field] : null;
          return (
            <div
              key={slot.key}
              className="flex items-start gap-2.5 p-3 rounded-medium ring-1 ring-inset ring-foreground/10 bg-foreground/[0.02]"
            >
              <span
                aria-hidden
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-success/10"
              >
                <slot.icon
                  className="h-3.5 w-3.5 text-success"
                  strokeWidth={2}
                  aria-hidden
                />
              </span>
              <div className="flex flex-col min-w-0">
                <span className="text-[12.5px] font-medium text-foreground">
                  {slot.label}
                </span>
                <span className="text-[11px] text-foreground/65 truncate">
                  {slot.hint}
                </span>
                <span className="mt-1 text-[11.5px] text-foreground/65 tabular truncate">
                  {query.isLoading || isAuthRedirecting
                    ? "Loading…"
                    : value
                      ? value
                      : "Inherit from default IS"}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {editing && defaults ? (
        <DefaultModelsModal
          initial={defaults}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </SectionCard>
  );
}

function DefaultModelsModal({
  initial,
  onClose,
}: {
  initial: DefaultsState;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState<DefaultsState>(initial);

  const setMutation = trpc.intelligence.setPodDefaults.useMutation({
    onSuccess: () => {
      void utils.intelligence.getPodDefaults.invalidate();
      addToast({
        title: "Defaults updated",
        description: "Pod-wide model defaults saved.",
        color: "default",
      });
      onClose();
    },
    onError: (err) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      addToast({
        title: "Couldn't save the model defaults",
        description: readableError(err.message),
        color: "danger",
      });
    },
  });

  function setField(field: keyof DefaultsState, value: string) {
    setDraft((d) => ({
      ...d,
      [field]: value.trim() === "" ? null : value,
    }));
  }

  return (
    <Modal isOpen onOpenChange={(o) => !o && onClose()} size="md">
      <ModalContent className="bg-background">
        <ModalHeader className="flex flex-col gap-0.5 px-5 pt-5 pb-2">
          <span className="text-[14px] font-medium text-foreground">
            Edit pod-wide defaults
          </span>
          <span className="text-[11.5px] text-foreground/65">
            Leave a slot empty to inherit from the default IS.
          </span>
        </ModalHeader>
        <ModalBody className="flex flex-col gap-3 px-5 py-3">
          {MODEL_SLOTS.map((slot) => {
            const field = SLOT_TO_FIELD[slot.key];
            return (
              <Input
                key={slot.key}
                label={slot.label}
                placeholder="Inherit from default IS"
                size="sm"
                variant="bordered"
                radius="md"
                value={draft[field] ?? ""}
                onValueChange={(v) => setField(field, v)}
                isDisabled={setMutation.isPending}
                description={slot.hint}
              />
            );
          })}
        </ModalBody>
        <ModalFooter className="flex justify-end gap-2 px-5 pb-5 pt-2">
          <Button
            size="sm"
            variant="light"
            radius="md"
            onPress={onClose}
            isDisabled={setMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            color="primary"
            radius="md"
            isLoading={setMutation.isPending}
            onPress={() => setMutation.mutate(draft)}
          >
            Save
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
