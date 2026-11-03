/**
 * What a key request BY PERMISSIONS may hold (2 Nov 2026: an agent asks for
 * the exact key it needs). Pure: the list is checked against the grant
 * grammar and the pod's own door registries before anything is filed; the
 * ceiling it becomes is checked here, its approval and mint in
 * `key-requests.custom.pglite.test.ts`. Each case names the rule it rules out.
 */
import { describe, expect, it } from "vitest";
import { KEY_TEMPLATES, keyTemplate } from "@synap-core/types/grants";
import {
  CUSTOM_KEY_REQUEST_MAX_DAYS,
  CUSTOM_KEY_REQUEST_TEMPLATE_ID,
  CUSTOM_KEY_REQUEST_USES,
  ceilingFromPermissions,
  requestedPermissionProblems,
} from "./key-request-permissions.js";

/** The Sillage session's ingest key (2 Nov), which no template fitted. */
const SILLAGE = [
  "entity.source.read",
  "entity.source.create",
  "entity.source.update",
  "entity.dataset-snapshot.read",
  "entity.dataset-snapshot.create",
  "entity.dataset-snapshot.update",
  "entity.company.read",
  "entity.company.create",
  "entity.company.update",
  "entity.public-contract.read",
  "entity.public-contract.create",
  "entity.public-contract.update",
  "facet.create",
];

describe("requestedPermissionProblems", () => {
  it("the Sillage ingest list passes", () => {
    expect(requestedPermissionProblems(SILLAGE)).toEqual([]);
  });

  // Rules out: a list checked only for syntax, so a door's own spelling or a
  // gate verb the pod grants is refused.
  it("door spellings and gate verbs the pod grants pass", () => {
    expect(
      requestedPermissionProblems([
        "facet.attach",
        "entity.task.transition",
        "entity.*.merge",
        "proposal.approve",
        "event.ci.create",
        "capability.*.run",
        "document",
        "entity.note",
        "session.update",
        "track.read",
      ])
    ).toEqual([]);
  });

  // Rules out: `*` slipping in through a list, which would mint full access
  // for 365 days where its own template allows 30.
  it("refuses * and points to the full-access template", () => {
    const [p] = requestedPermissionProblems(["entity.note.read", "*"]);
    expect(p).toMatch(/full access/i);
    expect(p).toContain("full-access");
    expect(p).toContain(
      String(keyTemplate("full-access")!.grant.expiresInDays)
    );
  });

  // Rules out: a typo minting a key that silently grants nothing.
  it("an unknown subject is refused by name", () => {
    const problems = requestedPermissionProblems(["entitty.read"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"entitty"');
  });

  it("an unknown verb is refused by name", () => {
    const problems = requestedPermissionProblems([
      "entity.company.frobnicate",
      "document.merge",
    ]);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('"frobnicate"');
    expect(problems[1]).toContain('"merge"');
  });

  it("a malformed pattern is refused by name; every problem is listed", () => {
    const problems = requestedPermissionProblems([
      "Entity.Read",
      "document..read",
      "note.x.read",
    ]);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain('"Entity.Read"');
    expect(problems[1]).toContain('"document..read"');
    expect(problems[2]).toContain('"note.x.read"');
  });

  it("an empty list, or more than a key holds, is refused", () => {
    expect(requestedPermissionProblems([])).toHaveLength(1);
    const many = Array.from({ length: 129 }, (_, i) => `entity.k${i}.read`);
    expect(requestedPermissionProblems(many).join(" ")).toMatch(/at most 128/);
  });
});

describe("ceilingFromPermissions", () => {
  it("the list is the ceiling: hub, 90 days by default, canonical order", () => {
    const { ceiling, problems } = ceilingFromPermissions(
      ["entity.company.update", "entity.company.read", "entity.company.read"],
      {}
    );
    expect(problems).toEqual([]);
    expect(ceiling.uses).toEqual(["hub"]);
    expect(ceiling.grant).toEqual({
      permissions: ["entity.company.read", "entity.company.update"],
      expiresInDays: 90,
    });
  });

  it("a space pins it; uses may be any the templates allow", () => {
    const W = "33333333-3333-4333-8333-333333333333";
    const { ceiling, problems } = ceilingFromPermissions(SILLAGE, {
      workspaceId: W,
      uses: ["hub", "mcp"],
      expiresInDays: 365,
    });
    expect(problems).toEqual([]);
    expect(ceiling.grant.workspaceIds).toEqual([W]);
    expect(ceiling.grant.expiresInDays).toBe(365);
    expect(ceiling.uses).toEqual(["hub", "mcp"]);
  });

  // The founder may override this choice (PR body): a list never makes a key
  // that never expires, and lives at most a year.
  it("refuses a key that never expires, or lives over 365 days", () => {
    expect(CUSTOM_KEY_REQUEST_MAX_DAYS).toBe(365);
    for (const expiresInDays of [null, 366, 36_500]) {
      const { problems } = ceilingFromPermissions(SILLAGE, { expiresInDays });
      expect(problems.join(" "), String(expiresInDays)).toMatch(/365 days/);
    }
  });

  it("refuses a use no template allows", () => {
    expect(CUSTOM_KEY_REQUEST_USES).toEqual(["hub", "mcp"]);
    const { problems } = ceilingFromPermissions(SILLAGE, {
      uses: ["n8n"],
    });
    expect(problems.join(" ")).toContain('"n8n"');
  });

  // As a template at a project (answer 26): a project key posts no activity.
  it("at a project, activity is taken off; a list that only posts is refused", () => {
    const P = "44444444-4444-4444-8444-444444444444";
    const reader = ceilingFromPermissions(
      ["document.read", "event.ci.create"],
      { projectId: P }
    );
    expect(reader.problems).toEqual([]);
    expect(reader.ceiling.grant.projectIds).toEqual([P]);
    expect(reader.ceiling.grant.permissions).toEqual(["document.read"]);
    const poster = ceilingFromPermissions(["event.create"], { projectId: P });
    expect(poster.problems.join(" ")).toMatch(/nothing/);
  });

  it("the stored template id names no template a person could pick", () => {
    expect(KEY_TEMPLATES.map((t) => t.id)).not.toContain(
      CUSTOM_KEY_REQUEST_TEMPLATE_ID
    );
  });
});
