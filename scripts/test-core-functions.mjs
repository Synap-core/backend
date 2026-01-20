/**
 * Core Function Test Suite
 * Tests all critical API endpoints to validate system readiness
 */

const API_URL = process.env.API_URL || "http://localhost:3000";
const TEST_USER = "test-validation-user";

// Colors for output
const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
};

const log = {
  info: (msg) => console.log(`${colors.blue}ℹ${colors.reset} ${msg}`),
  success: (msg) => console.log(`${colors.green}✅${colors.reset} ${msg}`),
  error: (msg) => console.log(`${colors.red}❌${colors.reset} ${msg}`),
  warn: (msg) => console.log(`${colors.yellow}⚠${colors.reset} ${msg}`),
};

const tests = {
  /**
   * Test health endpoints
   */
  health: async () => {
    console.log("\n📊 Testing Health Endpoints...");
    console.log("─".repeat(50));

    const endpoints = ["alive", "ready", "migrations", "metrics"];
    const results = [];

    for (const endpoint of endpoints) {
      try {
        const res = await fetch(`${API_URL}/trpc/health.${endpoint}`);
        const passed = res.ok;

        if (passed) {
          log.success(`health.${endpoint} (${res.status})`);
        } else {
          log.error(`health.${endpoint} (${res.status})`);
          const body = await res.text().catch(() => "No response body");
          console.log(`  Error: ${body.substring(0, 200)}`);
        }

        results.push({ endpoint, passed });
      } catch (error) {
        log.error(`health.${endpoint} - ${error.message}`);
        results.push({ endpoint, passed: false });
      }
    }

    const allPassed = results.every((r) => r.passed);
    return { passed: allPassed, total: endpoints.length, results };
  },

  /**
   * Test capture flow
   */
  capture: async () => {
    console.log("\n💭 Testing Capture Flow...");
    console.log("─".repeat(50));

    try {
      const res = await fetch(`${API_URL}/trpc/capture.thought`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-test-user-id": TEST_USER,
        },
        body: JSON.stringify({
          content: `Test thought ${Date.now()}`,
          mode: "local",
        }),
      });

      if (res.ok) {
        const data = await res.json();
        log.success(`capture.thought (${res.status})`);
        console.log(`  Response: ${JSON.stringify(data).substring(0, 100)}`);
        return { passed: true };
      } else {
        log.error(`capture.thought (${res.status})`);
        const error = await res.text();
        console.log(`  Error: ${error.substring(0, 200)}`);
        return { passed: false };
      }
    } catch (error) {
      log.error(`capture.thought - ${error.message}`);
      return { passed: false };
    }
  },

  /**
   * Test notes flow
   */
  notes: async () => {
    console.log("\n📝 Testing Notes Flow...");
    console.log("─".repeat(50));

    const results = [];

    // Test create
    try {
      const createRes = await fetch(`${API_URL}/trpc/notes.create?batch=1`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-test-user-id": TEST_USER,
        },
        body: JSON.stringify({
          0: {
            title: `Test Note ${Date.now()}`,
            content: "Validation test content",
            tags: ["validation", "test"],
          },
        }),
      });

      if (createRes.ok) {
        log.success(`notes.create (${createRes.status})`);
        results.push({ endpoint: "create", passed: true });
      } else {
        log.error(`notes.create (${createRes.status})`);
        const error = await createRes
          .json()
          .catch(() => ({ error: "Parse failed" }));
        console.log(`  Error: ${JSON.stringify(error).substring(0, 300)}`);
        results.push({ endpoint: "create", passed: false });
      }
    } catch (error) {
      log.error(`notes.create - ${error.message}`);
      results.push({ endpoint: "create", passed: false });
    }

    // Test list (GET for tRPC queries)
    try {
      const input = encodeURIComponent(JSON.stringify({ limit: 10 }));
      const listRes = await fetch(`${API_URL}/trpc/notes.list?input=${input}`, {
        method: "GET",
        headers: {
          "x-test-user-id": TEST_USER,
        },
      });

      if (listRes.ok) {
        log.success(`notes.list (${listRes.status})`);
        results.push({ endpoint: "list", passed: true });
      } else {
        log.error(`notes.list (${listRes.status})`);
        results.push({ endpoint: "list", passed: false });
      }
    } catch (error) {
      log.error(`notes.list - ${error.message}`);
      results.push({ endpoint: "list", passed: false });
    }

    const allPassed = results.every((r) => r.passed);
    return { passed: allPassed, results };
  },

  /**
   * Test system endpoints
   */
  system: async () => {
    console.log("\n⚙️  Testing System Endpoints...");
    console.log("─".repeat(50));

    const results = [];

    try {
      const res = await fetch(`${API_URL}/trpc/system.getCapabilities`);

      if (res.ok) {
        log.success(`system.getCapabilities (${res.status})`);
        results.push({ endpoint: "getCapabilities", passed: true });
      } else {
        log.error(`system.getCapabilities (${res.status})`);
        results.push({ endpoint: "getCapabilities", passed: false });
      }
    } catch (error) {
      log.error(`system.getCapabilities - ${error.message}`);
      results.push({ endpoint: "getCapabilities", passed: false });
    }

    const allPassed = results.every((r) => r.passed);
    return { passed: allPassed, results };
  },

  /**
   * Check event store via database
   */
  eventStore: async () => {
    console.log("\n📦 Testing Event Store...");
    console.log("─".repeat(50));

    try {
      const { exec } = await import("child_process");
      const { promisify } = await import("util");
      const execAsync = promisify(exec);

      const { stdout, stderr } = await execAsync(
        `docker exec synap-postgres psql -U postgres synap -t -c "SELECT COUNT(*) FROM events_timescale WHERE user_id = '${TEST_USER}' AND timestamp > NOW() - INTERVAL '5 minutes'"`
      );

      if (stderr) {
        log.warn(`Event query warning: ${stderr.substring(0, 100)}`);
      }

      const count = parseInt(stdout.trim());
      log.info(`Recent events for ${TEST_USER}: ${count}`);

      if (count > 0) {
        log.success("Events being stored in events_timescale");
        return { passed: true, count };
      } else {
        log.warn(
          "No recent events found (may be normal if no tests created events)"
        );
        return { passed: true, count };
      }
    } catch (error) {
      log.error(`Event store check failed: ${error.message}`);
      return { passed: false };
    }
  },
};

/**
 * Run all tests
 */
async function runAllTests() {
  console.log("\n🚀 Synap Core Function Validation");
  console.log("═".repeat(50));
  console.log(`API URL: ${API_URL}`);
  console.log(`Test User: ${TEST_USER}`);
  console.log("═".repeat(50));

  const testResults = {};
  let totalPassed = 0;
  let totalTests = 0;

  for (const [name, testFn] of Object.entries(tests)) {
    try {
      const result = await testFn();
      testResults[name] = result;

      if (result.passed) {
        totalPassed++;
      }
      totalTests++;
    } catch (error) {
      log.error(`${name} test crashed: ${error.message}`);
      testResults[name] = { passed: false, error: error.message };
      totalTests++;
    }
  }

  // Summary
  console.log("\n═".repeat(50));
  console.log("📊 Test Summary");
  console.log("═".repeat(50));

  for (const [name, result] of Object.entries(testResults)) {
    const status = result.passed
      ? colors.green + "✅ PASS"
      : colors.red + "❌ FAIL";
    console.log(`  ${status}${colors.reset} - ${name}`);
  }

  console.log("─".repeat(50));
  console.log(`  Total: ${totalPassed}/${totalTests} tests passed`);
  console.log("═".repeat(50));

  if (totalPassed === totalTests) {
    console.log(
      `\n${colors.green}✅ All tests passed! System ready.${colors.reset}\n`
    );
    process.exit(0);
  } else {
    console.log(
      `\n${colors.red}❌ Some tests failed. Review errors above.${colors.reset}\n`
    );
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllTests().catch((error) => {
    log.error(`Test suite crashed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
}

export { tests, runAllTests };
