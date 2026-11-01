/**
 * Machines router — Connected › Computers (MACHINE-IDENTITY-PLAN W5).
 *
 * A computer is an agent user of type `machine` that the person approved on
 * `/device`. This router is the person's view of THEIR computers (and, for a
 * pod admin, `adminList` — everyone's) and the acts on one: rename, set its
 * key lifetime, "Runs scripts", whose computer it is, revoke (which revokes
 * the keys of every agent it hosts — `revokeMachine`, the one door).
 *
 * Every mutation is a PERSON's, signed in: a key — a computer's own, or an
 * agent's — never renames, re-times or revokes a computer (the same rule as
 * `apiKeys.setGrants` and the device decision). Ownership is read off the
 * LOADED row (`created_by_user_id`), never off the request; a pod admin may
 * manage any computer.
 *
 * Rotation is not a procedure: a computer's new key can only reach the
 * computer through the device flow (`synap pods reconnect` on it), which
 * offers the same computer and replaces its key.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  router,
  protectedProcedure,
  podAdminProcedure,
  credentialProcedure,
} from "../trpc.js";
import { auditLog } from "../utils/audit-log.js";
import { assertSignedInPerson } from "../utils/signed-in-person.js";
import { isPodAdmin } from "../utils/workspace-role.js";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { COMPUTER_BELONGS_TO } from "@synap-core/types/computers";
import {
  revokeMachine,
  setMachineBelongsTo,
} from "../services/machine-connect.js";
import {
  listAllMachines,
  listMachines,
  loadManageableMachine,
  renameMachine,
  setMachineOwnKeyTtlDays,
  setMachineRunsScripts,
} from "../services/machine-roster.js";

const MANAGE_COMPUTER_SIGNED_IN = "Manage a computer while signed in.";

const MachineIdShape = z.string().min(1).max(200);

export const machinesRouter = router({
  /** Your computers, newest first, each with its key's state and its agents. */
  list: protectedProcedure.query(({ ctx }) => listMachines(ctx.userId)),

  /**
   * EVERY member's computers, each with its owner — the Pod Console's
   * Access › Computers. Pod admin only: `list` stays the owner-floored door
   * (the desktop's Connected › Computers and the console's "My computers").
   * The acts stay on `rename` / `setKeyTtl` / `revoke`, which already let a
   * pod admin manage any computer (`loadManageableMachine`).
   */
  adminList: podAdminProcedure.query(() => listAllMachines()),

  rename: credentialProcedure
    .input(
      z.object({
        machineId: MachineIdShape,
        name: z.string().trim().min(1).max(80),
      })
    )
    .mutation(async ({ ctx, input }) => {
      assertSignedInPerson(ctx, MANAGE_COMPUTER_SIGNED_IN);
      const machine = await loadManageableMachine(
        input.machineId,
        ctx.userId,
        await isPodAdmin(ctx.userId)
      );
      await renameMachine(machine.id, input.name);
      void auditLog({
        subjectType: "user",
        action: "update",
        phase: "completed",
        subjectId: machine.id,
        userId: ctx.userId,
        workspaceId: null,
        data: { kind: "machine_rename", from: machine.name, to: input.name },
      });
      return { status: "renamed" as const };
    }),

  /** The computer's own key lifetime; `null` = follow the pod default. */
  setKeyTtl: credentialProcedure
    .input(
      z.object({
        machineId: MachineIdShape,
        keyTtlDays: z.number().int().nullable(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      assertSignedInPerson(ctx, MANAGE_COMPUTER_SIGNED_IN);
      const machine = await loadManageableMachine(
        input.machineId,
        ctx.userId,
        await isPodAdmin(ctx.userId)
      );
      await setMachineOwnKeyTtlDays(machine.id, input.keyTtlDays);
      void auditLog({
        subjectType: "user",
        action: "update",
        phase: "completed",
        subjectId: machine.id,
        userId: ctx.userId,
        workspaceId: null,
        data: { kind: "machine_key_ttl", keyTtlDays: input.keyTtlDays },
      });
      return { status: "updated" as const };
    }),

  /**
   * "Runs scripts" (code-runtime B0): this computer may lease its person's
   * box runs (`/box-runs/*`, scope `box.runner` on its key). A person's act,
   * signed in, like rename; turning it on widens what the computer's key may
   * do, so it rides the same gate as revoke.
   */
  setRunsScripts: credentialProcedure
    .input(z.object({ machineId: MachineIdShape, enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      assertSignedInPerson(ctx, MANAGE_COMPUTER_SIGNED_IN);
      const machine = await loadManageableMachine(
        input.machineId,
        ctx.userId,
        await isPodAdmin(ctx.userId)
      );
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        subjectType: "apiKey",
        action: "update",
        data: { machineUserId: machine.id, runsScripts: input.enabled },
      });
      if ("denied" in perm && perm.denied)
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      if ("proposalId" in perm)
        return { status: "proposed" as const, proposalId: perm.proposalId };
      const { keysUpdated } = await setMachineRunsScripts(
        machine.id,
        input.enabled
      );
      void auditLog({
        subjectType: "apiKey",
        action: "update",
        phase: "completed",
        subjectId: machine.id,
        userId: ctx.userId,
        workspaceId: null,
        data: {
          kind: "machine_runs_scripts",
          enabled: input.enabled,
          keysUpdated,
        },
      });
      return { status: "updated" as const, runsScripts: input.enabled };
    }),

  /**
   * Whose computer it is (0388): the person's own, an agent's box, or shared.
   * A person's act, signed in, like rename. Setting "an agent's" widens what
   * the box may do later (a person's auto rule for an agent on it is also
   * written for the computer, host-seed.ts), so it rides the same gate as
   * `setRunsScripts`; leaving it takes back every seeded approval.
   */
  setBelongsTo: credentialProcedure
    .input(
      z.object({
        machineId: MachineIdShape,
        belongsTo: z.enum(COMPUTER_BELONGS_TO),
      })
    )
    .mutation(async ({ ctx, input }) => {
      assertSignedInPerson(ctx, MANAGE_COMPUTER_SIGNED_IN);
      const machine = await loadManageableMachine(
        input.machineId,
        ctx.userId,
        await isPodAdmin(ctx.userId)
      );
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        subjectType: "apiKey",
        action: "update",
        data: { machineUserId: machine.id, belongsTo: input.belongsTo },
      });
      if ("denied" in perm && perm.denied)
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      if ("proposalId" in perm)
        return { status: "proposed" as const, proposalId: perm.proposalId };
      const { seedsRevoked } = await setMachineBelongsTo(
        machine.id,
        input.belongsTo
      );
      void auditLog({
        subjectType: "user",
        action: "update",
        phase: "completed",
        subjectId: machine.id,
        userId: ctx.userId,
        workspaceId: null,
        data: {
          kind: "machine_belongs_to",
          belongsTo: input.belongsTo,
          seedsRevoked,
        },
      });
      return {
        status: "updated" as const,
        belongsTo: input.belongsTo,
        seedsRevoked,
      };
    }),

  /**
   * Revoke a computer: its keys AND its agents' keys stop working now. The
   * computer and its agents stay listed with their history; `synap init` on
   * that machine can connect it again (the device flow offers to reuse it).
   */
  revoke: credentialProcedure
    .input(z.object({ machineId: MachineIdShape }))
    .mutation(async ({ ctx, input }) => {
      assertSignedInPerson(ctx, MANAGE_COMPUTER_SIGNED_IN);
      const machine = await loadManageableMachine(
        input.machineId,
        ctx.userId,
        await isPodAdmin(ctx.userId)
      );
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        subjectType: "apiKey",
        action: "delete",
        data: { machineUserId: machine.id },
      });
      if ("denied" in perm && perm.denied)
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      if ("proposalId" in perm)
        return { status: "proposed" as const, proposalId: perm.proposalId };

      const revokedKeys = await revokeMachine({
        machineUserId: machine.id,
        by: ctx.userId,
        reason: "Computer revoked",
      });
      void auditLog({
        subjectType: "apiKey",
        action: "revoke",
        phase: "completed",
        subjectId: machine.id,
        userId: ctx.userId,
        workspaceId: null,
        data: { kind: "machine_revoke", revokedKeys },
      });
      return { status: "revoked" as const, revokedKeys };
    }),
});
