/**
 * `resolveSessionProjectPlacement` hands an agent's DECLARED project focus to
 * the ladder (rung 3.5). Without it `synap_start_session` ignored the focus
 * while the auto-opened receipt sessions honoured it (plan A2-a, 2026-10-29).
 *
 * Mock db, as `project-resolution-service.test.ts`: rungs 2 and 3 build
 * `eq(focusSessions.id, …)`, which throws in this harness, so only rungs 1,
 * 3.5 and 4 (the subject) are driven here. The ladder's own precedence is
 * pinned in that file.
 */
import { describe, it, expect } from "vitest";
import { resolveSessionProjectPlacement } from "./resolve-session-project.js";

const USER = "user-1";
const PROJ_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PROJ_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const SUBJECT = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

function makeDb(subjectProjects: string[] = []): any {
  return {
    query: {
      relations: {
        findMany: async () =>
          subjectProjects.map((targetEntityId) => ({ targetEntityId })),
      },
    },
  };
}

describe("resolveSessionProjectPlacement — the declared focus", () => {
  it("places a session nothing else pins into the agent's focus (rung 3.5)", async () => {
    const r = await resolveSessionProjectPlacement(makeDb(), {
      userId: USER,
      focusProjectId: PROJ_A,
    });
    expect(r.projectId).toBe(PROJ_A);
    expect(r.rung).toBe(3.5);
  });

  it("an explicit project still wins over the focus (rung 1)", async () => {
    const r = await resolveSessionProjectPlacement(makeDb(), {
      userId: USER,
      explicitProjectId: PROJ_B,
      focusProjectId: PROJ_A,
    });
    expect(r.projectId).toBe(PROJ_B);
    expect(r.rung).toBe(1);
  });

  it("the focus is a declaration and ranks above the subject's project (rung 4)", async () => {
    const r = await resolveSessionProjectPlacement(makeDb([PROJ_B]), {
      userId: USER,
      subjectEntityId: SUBJECT,
      focusProjectId: PROJ_A,
    });
    expect(r.projectId).toBe(PROJ_A);
    expect(r.rung).toBe(3.5);
  });

  it("CONTROL — no focus: the subject places, and with no subject nothing does", async () => {
    expect(
      (
        await resolveSessionProjectPlacement(makeDb([PROJ_B]), {
          userId: USER,
          subjectEntityId: SUBJECT,
        })
      ).projectId
    ).toBe(PROJ_B);
    expect(
      (
        await resolveSessionProjectPlacement(makeDb(), {
          userId: USER,
          focusProjectId: null,
        })
      ).projectId
    ).toBeNull();
  });
});
