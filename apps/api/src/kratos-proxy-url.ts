import { pathToFileURL } from "node:url";

export function buildKratosProxyTargetUrl(
  kratosPublicUrl: string,
  kratosPath: string,
  requestUrl: string
) {
  const search = new URL(requestUrl).search;
  return `${kratosPublicUrl}${kratosPath}${search}`;
}

const isDirectExecution =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  const [{ default: assert }, { describe, it }] = await Promise.all([
    import("node:assert/strict"),
    import("node:test"),
  ]);
  const assertEqual: (actual: unknown, expected: unknown) => void =
    assert.equal;

  describe("buildKratosProxyTargetUrl", () => {
    it("preserves Kratos flow query params when proxying self-service requests", () => {
      const targetUrl = buildKratosProxyTargetUrl(
        "http://localhost:4433",
        "/self-service/login",
        "http://pod.local/.ory/kratos/public/self-service/login?flow=abc123"
      );

      assertEqual(
        targetUrl,
        "http://localhost:4433/self-service/login?flow=abc123"
      );
    });

    it("preserves all existing query params without decoding or dropping values", () => {
      const targetUrl = buildKratosProxyTargetUrl(
        "http://localhost:4433",
        "/self-service/registration",
        "http://pod.local/self-service/registration?flow=flow-id&return_to=https%3A%2F%2Fsynap.dev%2Fapp%3Fworkspace%3Dmain"
      );

      assertEqual(
        targetUrl,
        "http://localhost:4433/self-service/registration?flow=flow-id&return_to=https%3A%2F%2Fsynap.dev%2Fapp%3Fworkspace%3Dmain"
      );
    });
  });
}
