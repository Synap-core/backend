import { describe, expect, it } from "vitest";
import { describeQueue, isQueueQuestion } from "../queue-question.js";

describe("isQueueQuestion", () => {
  it.each([
    "what is waiting on me",
    "What's waiting on me?",
    "what is pending for me",
    "anything waiting on me",
    "what do I need to review",
    "what needs my approval",
    "what's in my review queue",
    "qu'est-ce qui m'attend",
    "Qu’est-ce qui attend de moi ?",
    "qu'est-ce que je dois valider",
    "ma file d'attente",
    "mes validations en attente",
  ])("%s is a queue question", (q) => {
    expect(isQueueQuestion(q)).toBe(true);
  });

  it.each([
    "how does the review process work",
    "what is the pending proposals schema",
    "who is waiting on the invoice from Hetzner",
    "where do we host the pod",
    "comment fonctionne la validation des propositions",
    "what is waiting on me in the legacy migration plan from last quarter and who owns every step of it",
    "",
  ])("%s goes to recall", (q) => {
    expect(isQueueQuestion(q)).toBe(false);
  });
});

describe("describeQueue", () => {
  const empty = {
    pendingReview: { count: 0, lens: "authored" as const },
    owedByPerson: { count: 0, sessions: 0 },
    openSessions: { count: 0 },
  };

  it("names the review count and oldest", () => {
    const text = describeQueue({
      ...empty,
      pendingReview: {
        count: 3,
        oldestDays: 2,
        oldestLink: "synap://p/1",
        lens: "authored",
      },
    } as never);
    expect(text).toMatch(/3 proposals to review/);
    expect(text).toMatch(/oldest 2 days old/);
  });

  it("an unreadable section is never 'nothing waiting'", () => {
    const text = describeQueue({
      ...empty,
      pendingReview: { status: "unavailable" },
    } as never);
    expect(text).toMatch(/Could not read the review queue/);
    expect(text).not.toMatch(/^Nothing is waiting/);
  });

  it("all-read and all-zero says nothing is waiting", () => {
    expect(describeQueue(empty as never)).toMatch(/^Nothing is waiting/);
  });
});
