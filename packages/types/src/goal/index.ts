/** @folder The goal display model (pure): the goal view for one viewer, header facts, Done when rows and count, Who's on it rows, status moves, verdicts and the Declare done choice, every goal mark, the management doors (edit, people, loop, Make it a goal), how a write answered, the goals collection, New goal draft (fields, refusals, which projects may hold a goal), criteria input and the "This week" proposal.
 *
 * Moved here from `@synap-core/headless/goal` (synap-app) so the desk, the phone
 * and pod-admin share ONE composition; headless re-exports it. */
export * from "./marks.js";
export * from "./model.js";
export * from "./view.js";
export * from "./criteria-input.js";
export * from "./new-goal.js";
export * from "./this-week.js";
export * from "./collection.js";
export * from "./verdict-choice.js";
export * from "./manage.js";
export * from "./write.js";
export * from "./make-them-goals.js";
