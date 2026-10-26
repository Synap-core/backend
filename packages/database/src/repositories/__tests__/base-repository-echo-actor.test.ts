/**
 * The repository echo (`BaseRepository.emitCompleted`) names the agent whose
 * request wrote it (dogfood ea47d64e, FB1020 B3).
 *
 * Every agent create emitted an UNNAMED `entity.create.completed` echo beside
 * its attributed log row; "untouched by a person since" (`isOwnFreshWork`)
 * read that echo as a person's write, so an agent could never organise a
 * record of its own. Rows that rule out a wrong rule:
 *  - inside an agent's request → the echo carries `agentUserId`;
 *  - a person's request (no agent scope) → the echo stays unnamed, so a
 *    person's edit still counts as a touch (rules out "always stamp");
 *  - never `isAgent`: that flag + no proposal is the ungoverned-write count
 *    the daily ceiling reads (rules out stamping the telemetry flag).
 */
import { describe, it, expect, vi } from "vitest";
import { BaseRepository } from "../base-repository.js";
import type { EventRepository } from "../event-repository.js";
import { runWithActingAgent } from "../../utils/request-write-context.js";

class Echo extends BaseRepository<{ id: string }, never, never> {
  emit(id: string) {
    return this.emitCompleted("create", { id }, "owner-1");
  }
  create(): never {
    throw new Error("unused");
  }
  update(): never {
    throw new Error("unused");
  }
  delete(): never {
    throw new Error("unused");
  }
}

function echoRepo() {
  const append = vi.fn(async () => ({ id: "e" }));
  const repo = new Echo(null, { append } as unknown as EventRepository, {
    subjectType: "entity",
  });
  return { repo, append };
}

const appended = (append: ReturnType<typeof vi.fn>) =>
  append.mock.calls[0]![0] as Record<string, unknown>;

describe("BaseRepository echo attribution", () => {
  it("inside an agent's request the echo names the agent", async () => {
    const { repo, append } = echoRepo();
    await runWithActingAgent("agent-1", () => repo.emit("subject-1"));
    expect(appended(append)).toMatchObject({
      type: "entity.create.completed",
      subjectId: "subject-1",
      userId: "owner-1",
      agentUserId: "agent-1",
    });
    expect(appended(append).isAgent).toBeUndefined();
  });

  it("a person's request leaves the echo unnamed (a person's edit still counts)", async () => {
    const { repo, append } = echoRepo();
    await repo.emit("subject-1");
    expect(appended(append)).toMatchObject({
      type: "entity.create.completed",
      userId: "owner-1",
    });
    expect(appended(append).agentUserId).toBeUndefined();
    expect(appended(append).isAgent).toBeUndefined();
  });
});
