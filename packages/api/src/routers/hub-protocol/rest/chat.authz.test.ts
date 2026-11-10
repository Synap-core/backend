import { describe, expect, it } from "vitest";
import { restDoorAllowed } from "../../../access/grant-door-fence.js";
import { chatStreamPermitted } from "./chat.js";

const WS_A = "00000000-0000-4000-8000-00000000000a";
const WS_B = "00000000-0000-4000-8000-00000000000b";
const scope = (
  permissions: string[],
  workspaceIds: string[] | null = null
) => ({
  permissions,
  workspaceIds,
  projectIds: null,
  entityIds: null,
});
const grantOf = (...scopes: ReturnType<typeof scope>[]) => ({
  scopes,
  clientId: null,
});

describe("POST /api/hub/chat/stream: the app's grant decides", () => {
  it("(d) refused without chat.stream in the workspace", () => {
    expect(chatStreamPermitted(grantOf(scope(["entity.read"])), WS_A)).toBe(
      false
    );
  });

  it("admitted with chat.stream in that workspace", () => {
    expect(
      chatStreamPermitted(grantOf(scope(["chat.stream"], [WS_A])), WS_A)
    ).toBe(true);
  });

  it("(e) refused for a workspace outside the grant", () => {
    expect(
      chatStreamPermitted(grantOf(scope(["chat.stream"], [WS_A])), WS_B)
    ).toBe(false);
  });

  it("a bare `chat` covers nothing: a gate verb is named", () => {
    expect(chatStreamPermitted(grantOf(scope(["chat"])), WS_A)).toBe(false);
  });

  it("a person's own session (no grant) is not narrowed here", () => {
    expect(chatStreamPermitted(null, WS_A)).toBe(true);
  });

  it("the fence admits the route only to a grant that holds chat.stream", () => {
    expect(
      restDoorAllowed(
        "POST",
        "/chat/stream",
        grantOf(scope(["chat.stream"], [WS_A]))
      )
    ).toBe(true);
    expect(
      restDoorAllowed("POST", "/chat/stream", grantOf(scope(["entity.read"])))
    ).toBe(false);
  });
});
