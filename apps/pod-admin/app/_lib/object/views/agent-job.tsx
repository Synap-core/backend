"use client";

/**
 * The Job door on the agent page (0395, plan "Computer once, agents inside"
 * §6-§7): what this agent is FOR on its computer — its job and name, and,
 * for an agent made before seats, the OS user it runs as. Same agent, same
 * key: nothing is re-keyed (`agentUsers.setJob`, person-only, owner-only).
 */

import { Button, Input } from "@heroui/react";
import { useState } from "react";
import {
  agentRoleSlug,
  isUnclaimedSeat,
  seatLine,
} from "@synap-core/types/agents";
import { trpc } from "../../../../lib/trpc";

export function AgentJob({
  agentUserId,
  computerName,
  role,
  name,
  seat,
}: {
  agentUserId: string;
  computerName: string;
  role: string | null;
  name: string | null;
  seat: string | null;
}) {
  const utils = trpc.useUtils();
  const [label, setLabel] = useState(role ? (name ?? "") : "");
  const [osUser, setOsUser] = useState(
    isUnclaimedSeat(seat) ? "" : (seat ?? "")
  );
  const save = trpc.agentUsers.setJob.useMutation({
    onSuccess: () => void utils.agentUsers.list.invalidate(),
  });
  const slug = agentRoleSlug(label);
  const seatEditable = isUnclaimedSeat(seat);
  const changed =
    (slug || null) !== role ||
    (slug && label.trim() !== (name ?? "")) ||
    (seatEditable && osUser.trim() !== "");
  return (
    <section className="flex flex-col gap-2.5" data-testid="agent-job">
      <h2 className="text-tiny font-medium uppercase tracking-wide text-foreground/65">
        Job on {computerName}
      </h2>
      <Input
        size="sm"
        label="Job"
        placeholder="None — its engine's own agent"
        value={label}
        maxLength={80}
        onValueChange={setLabel}
        isDisabled={save.isPending}
      />
      {seatEditable ? (
        <Input
          size="sm"
          label="Runs as OS user"
          placeholder="e.g. antoine"
          value={osUser}
          maxLength={64}
          onValueChange={setOsUser}
          isDisabled={save.isPending}
        />
      ) : (
        <p className="text-small text-foreground/65">
          Runs as {seatLine(seat)}.
        </p>
      )}
      <p className="text-small text-foreground/65">
        Same agent and key: nothing is reconnected.
      </p>
      {save.error && (
        <p role="alert" className="text-small text-danger">
          {save.error.message}
        </p>
      )}
      <Button
        size="sm"
        variant="flat"
        className="self-start"
        isDisabled={!changed}
        isLoading={save.isPending}
        onPress={() =>
          save.mutate({
            agentUserId,
            role: slug || null,
            label: slug ? label.trim() : null,
            ...(seatEditable && osUser.trim() ? { seat: osUser.trim() } : {}),
          })
        }
      >
        Save job
      </Button>
    </section>
  );
}
