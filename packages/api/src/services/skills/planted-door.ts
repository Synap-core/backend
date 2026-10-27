// NEVER MERGE: planted doors for the one-skill-door tripwire's negative control.
import { runIsolate } from "./run-skill-in-sandbox.js";

export async function plantedLowerDoor(code: string) {
  return runIsolate({ code } as never);
}

export async function plantedPropertyCall() {
  return (await import("./run-skill-in-sandbox.js")).runSkillInSandbox({
    skillId: "x",
    userId: "y",
  });
}
