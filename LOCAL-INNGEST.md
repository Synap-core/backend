# Local Inngest Setup

The open-source Inngest CLI makes it easy to exercise our background workers without hitting the hosted service. Follow these steps to run the full loop locally:

1. **Install the CLI (once):**
   ```bash
   npm install -g inngest-cli
   ```

2. **Start the dev server:**
   ```bash
   pnpm --filter @synap/jobs dev
   ```
   This command runs `inngest dev`, loads all functions exported from `packages/jobs`, and exposes the local event ingestion endpoint at `http://127.0.0.1:8288`.

3. **Configure your environment:**
   Add the following variables to `.env.local` (or export them in your shell) so the API publishes events to the dev server:
   ```bash
   export INNGEST_BASE_URL=http://127.0.0.1:8288
   export INNGEST_EVENT_KEY=dev-local-key
   ```
   These values match the defaults baked into `packages/api/src/event-publisher.ts`, so local development works even if the variables are omitted—but setting them keeps behaviour explicit.

4. **Run the API:**
   Start the API (e.g., `pnpm --filter @synap/api dev` or your preferred command). When the API emits domain events, they are now captured by the local dev server, which in turn triggers the workers defined in `@synap/jobs`.

5. **Verify the flow:**
   - Create a note via tRPC or the E2E scripts.
   - Observe the Inngest CLI logs showing the `entity-embedding-indexer` execution.
   - Check `entity_vectors` to confirm the embedding was stored.

> Tip: The CLI web UI is available at `http://127.0.0.1:8288` while `inngest dev` is running. Use it to replay events or inspect logs.

Production deployments must supply a real `INNGEST_EVENT_KEY`; the API will throw during boot if the key is missing and `NODE_ENV === 'production'`.


