import { describe, expect, it } from "vitest";
import { initialVersionAuthor } from "./document-repository.js";

// W5f F7: an MCP agent's document showed v1 as "A collaborator" — the v1 row was
// stamped `user` + the OWNER's id although the document row says an agent wrote
// it. The version rail reads `author`/`authorId`, so they must carry the agent.
describe("initialVersionAuthor", () => {
  it("an agent-created document's v1 is authored by the agent", () => {
    expect(
      initialVersionAuthor(
        { createdByKind: "ai_agent", agentUserId: "agent-1" },
        "owner-1"
      )
    ).toEqual({
      author: "ai",
      authorId: "agent-1",
    });
  });

  it("stays `ai` even when the caller did not name the agent user", () => {
    expect(
      initialVersionAuthor({ createdByKind: "ai_agent" }, "owner-1")
    ).toEqual({
      author: "ai",
      authorId: "owner-1",
    });
  });

  it("a human's (or unstated) document stays `user`; a system one `system`", () => {
    expect(initialVersionAuthor({ createdByKind: "human" }, "u")).toEqual({
      author: "user",
      authorId: "u",
    });
    expect(initialVersionAuthor({}, "u")).toEqual({
      author: "user",
      authorId: "u",
    });
    expect(initialVersionAuthor({ createdByKind: "system" }, "u")).toEqual({
      author: "system",
      authorId: "u",
    });
  });
});
