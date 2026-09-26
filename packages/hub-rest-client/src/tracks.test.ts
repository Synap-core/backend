/**
 * HubRestClient track methods — the ONE client door IS and the CLI share.
 *
 * Driven from the real wire shapes the Hub `/tracks` routes answer
 * (rest/tracks.ts), asserting what the caller actually receives: the advisory
 * `missingDomains` / `domainFallback` must arrive untouched, a proposal must
 * resolve (not throw), and an omitted stage key must resolve to the track's
 * current stage because the Hub route names the stage in its path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubRestClient } from "./client.js";
import { HubApiError } from "./errors.js";

type Reply = { status: number; body: unknown };
let replies: Reply[];
let calls: Array<{ url: string; method: string; body: unknown }>;
let client: HubRestClient;

beforeEach(() => {
  replies = [];
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const reply = replies.shift() ?? { status: 200, body: {} };
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "Content-Type": "application/json" },
      });
    })
  );
  client = new HubRestClient({
    podUrl: "https://pod.example.test",
    apiKey: "synap_hub_test_key",
    workspaceId: "ws-1",
    maxAttempts: 1,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const TRACK = {
  id: "11111111-1111-4111-8111-111111111111",
  projectId: "p-1",
  name: "Business model",
  playbookId: "pb-1",
  methodVersion: "1",
  currentStage: "interrogate",
  status: "active",
  pausedBy: null,
  stages: [],
  params: {},
  declaredParams: [],
  stageHistory: [],
  createdAt: "2026-09-25T00:00:00Z",
  updatedAt: "2026-09-25T00:00:00Z",
};

describe("listTracks", () => {
  it("GETs /tracks?projectId and unwraps `items`", async () => {
    replies.push({ status: 200, body: { items: [TRACK] } });
    const tracks = await client.listTracks("p-1", { includeArchived: true });
    expect(tracks).toEqual([TRACK]);
    expect(calls[0].url).toBe(
      "https://pod.example.test/api/hub/tracks?projectId=p-1&includeArchived=true"
    );
  });
});

describe("startTrack", () => {
  it("returns missingDomains + domainsNote untouched on a started track", async () => {
    const body = {
      status: "started",
      track: TRACK,
      missingDomains: ["market"],
      domainsNote: 'No workspace is installed for this stage domain: "market".',
    };
    replies.push({ status: 201, body });
    await expect(
      client.startTrack({ projectId: "p-1", playbookId: "pb-1" })
    ).resolves.toEqual(body);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://pod.example.test/api/hub/tracks",
      body: { projectId: "p-1", playbookId: "pb-1" },
    });
  });

  it("resolves a proposed 202 (success, queued) with its review link", async () => {
    const body = {
      status: "proposed",
      proposalId: "prop-1",
      reviewUrl: "https://pod.example.test/open/prop-1",
      missingDomains: [],
    };
    replies.push({ status: 202, body });
    await expect(
      client.startTrack({ projectId: "p-1", playbookId: "pb-1" })
    ).resolves.toEqual(body);
  });
});

describe("startStageSession", () => {
  it("resolves an omitted stageKey to the track's current stage", async () => {
    replies.push({ status: 200, body: TRACK });
    replies.push({
      status: 201,
      body: {
        status: "created",
        stageKey: "interrogate",
        session: { id: "s-1" },
      },
    });
    await client.startStageSession(TRACK.id);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET https://pod.example.test/api/hub/tracks/${TRACK.id}`,
      `POST https://pod.example.test/api/hub/tracks/${TRACK.id}/stages/interrogate/sessions`,
    ]);
  });

  it("refuses (no guess) when the track stands on no stage", async () => {
    replies.push({ status: 200, body: { ...TRACK, currentStage: null } });
    await expect(client.startStageSession(TRACK.id)).rejects.toBeInstanceOf(
      HubApiError
    );
    expect(calls).toHaveLength(1);
  });

  it("passes domainFallback + domainNote through untouched", async () => {
    const body = {
      status: "created",
      stageKey: "market-scan",
      session: { id: "s-2" },
      domainFallback: { wanted: "market", reason: "no_workspace" },
      domainNote: "…started in the project's home workspace instead.",
    };
    replies.push({ status: 201, body });
    await expect(
      client.startStageSession(TRACK.id, {
        stageKey: "market-scan",
        goal: "Scan",
      })
    ).resolves.toEqual(body);
    expect(calls[0].body).toEqual({ goal: "Scan" });
  });
});

describe("advance / status / params", () => {
  it("POSTs advance and PATCHes status and params on their own routes", async () => {
    replies.push({ status: 200, body: { status: "advanced", offer: null } });
    replies.push({
      status: 202,
      body: { status: "proposed", proposalId: "p" },
    });
    replies.push({ status: 200, body: { status: "updated", track: TRACK } });
    await client.advanceTrack(TRACK.id, { toStage: "build" });
    const st = await client.setTrackStatus(TRACK.id, "paused", "waiting");
    await client.setTrackParams(TRACK.id, { market: null });
    expect(st).toMatchObject({ status: "proposed", proposalId: "p" });
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      [
        "POST",
        `https://pod.example.test/api/hub/tracks/${TRACK.id}/advance`,
        { toStage: "build" },
      ],
      [
        "PATCH",
        `https://pod.example.test/api/hub/tracks/${TRACK.id}`,
        { status: "paused", reasoning: "waiting" },
      ],
      [
        "PATCH",
        `https://pod.example.test/api/hub/tracks/${TRACK.id}/params`,
        { params: { market: null } },
      ],
    ]);
  });
});

describe("createFocusSession — born in a track", () => {
  it("forwards trackId and does NOT stamp the client's default workspace", async () => {
    replies.push({ status: 200, body: { id: "user-1" } }); // GET /users/me
    replies.push({ status: 201, body: { id: "s-1" } });
    await client.createFocusSession({ goal: "g", trackId: TRACK.id });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({ trackId: TRACK.id, goal: "g" });
    expect(post.body).not.toHaveProperty("workspaceId");
  });
});
