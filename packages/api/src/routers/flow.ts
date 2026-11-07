/**
 * flow — the one read an app or an agent fetches to draw a kind's or role's
 * work (One model plan, S1): `flow.of` → `readFlowOf`
 * (`services/lifecycle/flow-read.ts`). Hub `GET /flow` and MCP `synap_get_flow`
 * are the same function behind their own doors: one service, three doors.
 */
import { router, podProcedure } from "../trpc.js";
import { flowOfInput, readFlowOf } from "../services/lifecycle/flow-read.js";

export const flowRouter = router({
  of: podProcedure
    .input(flowOfInput)
    .query(({ input, ctx }) => readFlowOf(input, ctx)),
});
