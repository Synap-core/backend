/**
 * entities.create — refuses a reserved kind BEFORE governance files a proposal.
 *
 * `project` is reserved (`@synap/database` reserved-profile-slugs.ts): projects
 * live in the `projects` TABLE and are created through the project door. The
 * floor (`EntityRepository.create`) refuses it, but the floor only runs at
 * MATERIALIZE time — after `checkPermissionOrPropose` has already filed an
 * agent's create as a pending proposal that can never be approved. This is
 * the one tRPC door every caller-facing create reaches (MCP
 * `synap_create_entity` → `lensCaller.entities.createEntity`, hub REST
 * POST /entities, the `entity/create` approve executor), so it is where the
 * refusal has to happen first.
 *
 * Drives the REAL `entitiesRouter.create` procedure. `checkPermissionOrPropose`
 * is spied (importOriginal + spread) only to prove it is never reached. No
 * database is needed: the refusal precedes every DB read on the slug path.
 *
 * WHAT THIS DOES NOT COVER: a caller passing a profile UUID in `profileSlug`
 * (the text is not the slug). That case is still refused by the floor — at
 * approve time, recorded as APPROVAL_FAILED with the same wording.
 */

import { describe, it, expect, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { reservedEntityKindReason } from "@synap/database";

vi.mock("../utils/permission-check.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../utils/permission-check.js")>();
  return {
    ...actual,
    checkPermissionOrPropose: vi.fn(async () => {
      throw new Error("checkPermissionOrPropose must not be reached");
    }),
  };
});

// `protectedProcedure`'s read-only guard reads `sync_generation` on every
// mutation. Stub only that read (the guard itself stays in the chain) so the
// test needs no database.
vi.mock("../utils/split-brain-service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../utils/split-brain-service.js")>();
  return { ...actual, isPodReadOnly: vi.fn(async () => false) };
});

const { entitiesRouter } = await import("./entities.js");
const { checkPermissionOrPropose } =
  await import("../utils/permission-check.js");

function caller() {
  return entitiesRouter.createCaller({
    authenticated: true,
    userId: "e0000000-0000-0000-0000-0000000000c1",
    workspaceId: null,
  } as never);
}

describe("entities.create — reserved kind is refused at the door", () => {
  it.each(["project", "projects", "Project"])(
    "refuses profileSlug '%s' with BAD_REQUEST and the reservation's wording, before any proposal",
    async (slug) => {
      const err = await caller()
        .create({
          profileSlug: slug,
          title: "Launch The Architech",
          agentUserId: "3f1c2b7e-9a4d-4c21-8b6e-2d5f0a9c7e12",
          source: "agent",
        })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(TRPCError);
      // Code + message + cause in ONE assertion, so a failure shows WHAT threw.
      expect({
        code: (err as TRPCError).code,
        message: (err as TRPCError).message,
        cause: String((err as TRPCError).cause ?? ""),
      }).toEqual({
        code: "BAD_REQUEST",
        message: reservedEntityKindReason(slug),
        cause: "",
      });
      expect((err as TRPCError).message).toContain("synap_create_project");
      expect(checkPermissionOrPropose).not.toHaveBeenCalled();
    }
  );
});
