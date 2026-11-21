/** A `verification_report` as the close door writes it for a close-anyway. */
export const closedNotDoneReport = () => ({
  closedNotDone: { reason: "Ran out of time", criteria: [], outcomes: [] },
});
