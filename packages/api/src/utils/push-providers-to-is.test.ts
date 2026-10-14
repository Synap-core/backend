import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  endpoint: { endpoint: "http://is.test", apiKey: "pod-key" },
  rows: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", () => ({
  db: {
    query: { aiProviders: { findMany: vi.fn(async () => h.rows) } },
  },
  resolveDefaultIntelligenceEndpoint: vi.fn(async () => h.endpoint),
  decryptServiceKey: (k: string) => k,
  isEncryptedServiceKey: () => false,
}));
vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  ISProviderError,
  probeProviderOnIS,
  pushProvidersToIS,
} from "./push-providers-to-is.js";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  h.endpoint = { endpoint: "http://is.test", apiKey: "pod-key" };
  h.rows = [
    {
      providerId: "p1",
      name: "P1",
      baseUrl: "https://api.example.com",
      apiKeyEnvVar: null,
      encryptedApiKey: "sk-test",
      enabled: true,
      priority: 1,
      tags: [],
      models: [],
      rateLimit: null,
      extraBody: null,
      systemPromptPrefix: null,
    },
  ];
});

describe("pushProvidersToIS", () => {
  it("PUTs /api/provider-config with the pod's own Bearer key", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await pushProvidersToIS();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://is.test/api/provider-config");
    expect(init.method).toBe("PUT");
    expect(init.headers.Authorization).toBe("Bearer pod-key");
    expect(init.headers["X-Admin-Key"]).toBeUndefined();
    expect(JSON.parse(init.body).providers[0].id).toBe("p1");
  });

  it("throws a typed error on a non-2xx answer", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 403 }));
    await expect(pushProvidersToIS()).rejects.toMatchObject({
      name: "ISProviderError",
      code: "IS_REJECTED",
      status: 403,
    });
  });

  it("throws (never skips silently) when the pod has no IS key", async () => {
    h.endpoint = { endpoint: "http://is.test", apiKey: "" };
    await expect(pushProvidersToIS()).rejects.toBeInstanceOf(ISProviderError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("probeProviderOnIS", () => {
  it("POSTs /api/provider-config/:id/test with the Bearer key", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, models: ["m"], latencyMs: 5 }))
    );
    const out = await probeProviderOnIS("p 1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://is.test/api/provider-config/p%201/test");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer pod-key");
    expect(out.ok).toBe(true);
  });

  it("surfaces a non-2xx as ISProviderError, not an ok body", async () => {
    fetchMock.mockResolvedValue(new Response("gone", { status: 404 }));
    await expect(probeProviderOnIS("p1")).rejects.toMatchObject({
      code: "IS_REJECTED",
      status: 404,
    });
  });

  it("throws IS_NOT_CONFIGURED without a key", async () => {
    h.endpoint = { endpoint: "http://is.test", apiKey: "" };
    await expect(probeProviderOnIS("p1")).rejects.toMatchObject({
      code: "IS_NOT_CONFIGURED",
    });
  });
});
