/**
 * Tripwire: a shell on the pod host is a POD-level operator switch plus a
 * pod-admin check, decided before the WebSocket upgrade is accepted.
 *
 * Pre-launch audit 2026-10-28, F2: the only gate was
 * `workspace.settings.devplane.localTerminalEnabled`, which any member sets on
 * a workspace they create, so any member got a shell in the production
 * backend container (its env, Kratos admin, Postgres).
 *
 * Behavioural: a real HTTP server runs the production upgrade router
 * (`handleWebSocketUpgrade`) and a real `ws` client connects to it. Mocked
 * only at the edges: the ticket lookup, the pod-admin read, the database
 * row, and `spawnPodPty` (so "a shell was spawned" is an observable call).
 * The workspace row the caller owns ALWAYS carries
 * `devplane.localTerminalEnabled: true`, the attacker's setup: the old gate
 * spawned for every case here except the unauthenticated one.
 *
 * Not covered here: the switch's own predicate (local-shell-switch.test.ts in
 * @synap/api) and the settings strip (server-owned-settings.test.ts).
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { WebSocket } from "ws";

const state = vi.hoisted(() => ({
  switchOn: false,
  podAdmin: false as boolean | "throw",
  ownerOf: new Set<string>(),
  spawn: vi.fn(),
  resolveUserId: vi.fn(),
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ error: () => {}, warn: () => {}, info: () => {} }),
}));
vi.mock("@synap/database/schema", () => ({ workspaces: {} }));
vi.mock("@synap/database", () => ({
  // The WHERE is opaque here: `and(eq(id), eq(ownerId))` is captured as the
  // two values, so the fake answers "does this caller own this workspace".
  eq: (_col: unknown, value: unknown) => value,
  and: (...values: unknown[]) => values,
  db: {
    query: {
      workspaces: {
        findFirst: vi.fn(async ({ where }: { where: unknown }) => {
          const [workspaceId, userId] = Array.isArray(where)
            ? (where as string[])
            : [where as string, undefined];
          if (
            userId !== undefined &&
            !state.ownerOf.has(`${userId}:${workspaceId}`)
          ) {
            return undefined;
          }
          return {
            id: workspaceId,
            settings: { devplane: { localTerminalEnabled: true } },
          };
        }),
      },
    },
  },
}));
vi.mock("@synap/api", () => ({
  isLocalShellAllowed: () => state.switchOn,
  isPodAdmin: async () => {
    if (state.podAdmin === "throw") throw new Error("db down");
    return state.podAdmin;
  },
  resolveVaultSecret: async () => null,
}));
vi.mock("./ws-auth.js", () => ({ resolveUserId: state.resolveUserId }));
vi.mock("./dev-cwd.js", () => ({ resolveDevCwd: async () => "/tmp" }));
vi.mock("./ssh-proxy.js", () => ({ handleSshUpgrade: vi.fn() }));
vi.mock("./recipe-runner.js", () => ({ handleRecipeRunUpgrade: vi.fn() }));
vi.mock("./pod-pty.js", () => ({
  sanitizePresetCommand: (cmd: string) => cmd,
  spawnPodPty: state.spawn,
}));

import { handleLocalTerminalUpgrade } from "./local-terminal.js";
import { handleWebSocketUpgrade } from "./ws-router.js";

type Outcome = number | "ready" | "reset" | string;

let server: Server;
let port = 0;
let direct = false; // route through the handler itself, bypassing the router

beforeAll(async () => {
  server = createServer((_req, res) => res.writeHead(404).end());
  server.on("upgrade", (req, socket, head) =>
    direct
      ? handleLocalTerminalUpgrade(req, socket, head)
      : handleWebSocketUpgrade(req, socket, head)
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  direct = false;
  state.switchOn = false;
  state.podAdmin = false;
  state.ownerOf = new Set(["member-1:ws-own", "admin-1:ws-own"]);
  state.resolveUserId.mockReset();
  state.spawn.mockReset();
  state.spawn.mockResolvedValue({
    shell: "/bin/sh",
    pty: {
      pid: 4242,
      onData: () => {},
      onExit: () => {},
      write: () => {},
      resize: () => {},
      kill: () => {},
    },
  });
});

function attempt(workspaceId = "ws-own"): Promise<Outcome> {
  return new Promise((resolve) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/api/devplane/local-terminal?ticket=t&workspaceId=${workspaceId}`
    );
    let done = false;
    const finish = (o: Outcome) => {
      if (done) return;
      done = true;
      resolve(o);
      ws.terminate();
    };
    ws.on("unexpected-response", (_req, res) => finish(res.statusCode ?? 0));
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as { type: string };
      finish(msg.type);
    });
    ws.on("error", () => finish("reset"));
    ws.on("close", () => finish("reset"));
  });
}

describe("DevPlane local terminal: pod-level gate before the upgrade", () => {
  it("non-vacuity: a pod admin owning the workspace on a local pod gets a shell", async () => {
    state.switchOn = true;
    state.podAdmin = true;
    state.resolveUserId.mockResolvedValue("admin-1");
    expect(await attempt()).toBe("ready");
    expect(state.spawn).toHaveBeenCalledTimes(1);
  });

  it("a cloud pod (switch off) does not route the path: no auth read, no spawn", async () => {
    state.podAdmin = true;
    state.resolveUserId.mockResolvedValue("admin-1");
    expect(await attempt()).toBe("reset");
    expect(state.resolveUserId).not.toHaveBeenCalled();
    expect(state.spawn).not.toHaveBeenCalled();
  });

  it("the handler itself refuses with 404 when the switch is off (router bypassed)", async () => {
    direct = true;
    state.podAdmin = true;
    state.resolveUserId.mockResolvedValue("admin-1");
    expect(await attempt()).toBe(404);
    expect(state.resolveUserId).not.toHaveBeenCalled();
    expect(state.spawn).not.toHaveBeenCalled();
  });

  it("a member who is not a pod admin is refused even with the workspace flag set", async () => {
    state.switchOn = true;
    state.podAdmin = false;
    state.resolveUserId.mockResolvedValue("member-1");
    expect(await attempt()).toBe(403);
    expect(state.spawn).not.toHaveBeenCalled();
  });

  it("a pod admin is refused on a workspace they do not own", async () => {
    state.switchOn = true;
    state.podAdmin = true;
    state.resolveUserId.mockResolvedValue("admin-1");
    expect(await attempt("ws-someone-else")).toBe(403);
    expect(state.spawn).not.toHaveBeenCalled();
  });

  it("a failed pod-admin read refuses (503); it never reads as allowed", async () => {
    state.switchOn = true;
    state.podAdmin = "throw";
    state.resolveUserId.mockResolvedValue("admin-1");
    expect(await attempt()).toBe(503);
    expect(state.spawn).not.toHaveBeenCalled();
  });

  it("no valid ticket is a 401 before any socket opens", async () => {
    state.switchOn = true;
    state.podAdmin = true;
    state.resolveUserId.mockResolvedValue(null);
    expect(await attempt()).toBe(401);
    expect(state.spawn).not.toHaveBeenCalled();
  });
});
