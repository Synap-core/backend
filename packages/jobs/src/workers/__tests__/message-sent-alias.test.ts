import { describe, it, expect } from "vitest";
import { matchPattern } from "../automation-trigger-matcher.js";

/**
 * `message.sent` reaches the automations of a message the person SENT to
 * someone outside the pod (channels wave, lane D, design d00cd2ac §4).
 *
 * The send door (and lane C's recorder, for a message sent from the person's
 * own devices) announces `external_message.sent`; the fan-out turns it into
 * `external_message.sent.completed`. An automation authored on the
 * documented alias `message.sent` ("message sent → cadence") matched only the
 * literal `message.sent` log rows, which never reach the matcher, so it could
 * never fire for a real send.
 *
 * Still never: a "sent" trigger firing on an INBOUND message.
 */
describe("the message.sent alias", () => {
  it("matches an outbound external message", () => {
    expect(
      matchPattern("external_message.sent.completed", "message.sent")
    ).toBe(true);
    expect(
      matchPattern("external_message.sent.completed", "message.sent.*")
    ).toBe(true);
  });

  it("still matches the literal message.sent fact", () => {
    expect(matchPattern("message.sent", "message.sent")).toBe(true);
  });

  it("never fires on an inbound message", () => {
    expect(
      matchPattern("external_message.received.completed", "message.sent")
    ).toBe(false);
    expect(
      matchPattern("channel_message.created.completed", "message.sent")
    ).toBe(false);
  });

  it("message.received never fires on an outbound message", () => {
    expect(
      matchPattern("external_message.sent.completed", "message.received")
    ).toBe(false);
  });

  it("the physical pattern keeps matching on its own", () => {
    expect(
      matchPattern(
        "external_message.sent.completed",
        "external_message.sent.completed"
      )
    ).toBe(true);
    expect(
      matchPattern("external_message.sent.completed", "external_message.*")
    ).toBe(true);
  });
});
