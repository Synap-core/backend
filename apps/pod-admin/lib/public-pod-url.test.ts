import { afterEach, describe, expect, it, vi } from "vitest";
import {
  POD_PUBLIC_URL_CONFIGURATION_ERROR,
  publicPodUrl,
} from "./public-pod-url";
import { createLoginFlow } from "./kratos-flow";

const initialPublicPodUrl = process.env.POD_PUBLIC_URL;

afterEach(() => {
  vi.restoreAllMocks();
  if (initialPublicPodUrl === undefined) {
    delete process.env.POD_PUBLIC_URL;
  } else {
    process.env.POD_PUBLIC_URL = initialPublicPodUrl;
  }
});

describe("publicPodUrl", () => {
  it("rejects an insecure remote Pod URL instead of falling back to Pod Admin", () => {
    process.env.POD_PUBLIC_URL = "http://pod.example.test";

    expect(publicPodUrl()).toBe("");
  });

  it("keeps a canonical HTTPS Pod URL", () => {
    process.env.POD_PUBLIC_URL = "https://pod.example.test/";

    expect(publicPodUrl()).toBe("https://pod.example.test");
  });

  it("surfaces deployment configuration before attempting a Kratos request", async () => {
    process.env.POD_PUBLIC_URL = "http://pod.example.test";
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(createLoginFlow()).rejects.toThrow(
      POD_PUBLIC_URL_CONFIGURATION_ERROR
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("creates a JSON browser flow through the configured Pod API", async () => {
    process.env.POD_PUBLIC_URL = "https://pod.example.test";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "login-flow",
          ui: {
            action: "https://pod.example.test/login",
            method: "POST",
            nodes: [],
          },
        }),
        { headers: { "content-type": "application/json" } }
      )
    );

    await expect(createLoginFlow()).resolves.toEqual({
      flow: expect.objectContaining({ id: "login-flow" }),
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://pod.example.test/.ory/kratos/public/self-service/login/browser",
      expect.objectContaining({
        credentials: "include",
        headers: { Accept: "application/json" },
      })
    );
  });
});
