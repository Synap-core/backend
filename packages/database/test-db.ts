
import postgres from "postgres";

async function test() {
  const urls = [
    "postgresql://postgres:synap_dev_password@localhost:5432/synap?sslmode=disable",
    "postgresql://postgres:synap_dev_password@127.0.0.1:5432/synap?sslmode=disable",
    "postgresql://postgres:synap_dev_password@[::1]:5432/synap?sslmode=disable"
  ];

  for (const url of urls) {
    console.log(`\nTesting URL: ${url.replace(/:[^:@]+@/, ":***@")}`);
    // Explicitly disable SSL in options too
    const sql = postgres(url, { 
      max: 1, 
      connect_timeout: 5,
      ssl: false,
      onnotice: (notice) => console.log('Notice:', notice)
    });
    try {
      const result = await sql`SELECT 1 as connected`;
      console.log(`✅ Success! Result:`, result);
    } catch (err) {
      console.error(`❌ Failed:`, err instanceof Error ? err.stack : err);
    } finally {
      await sql.end();
    }
  }
}

test();
