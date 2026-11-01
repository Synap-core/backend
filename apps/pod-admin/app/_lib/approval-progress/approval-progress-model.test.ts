/**
 * What a large approval SAYS while it applies — the one derivation the toast
 * and the review's decision bar share. Each row rules out a wrong rule:
 * the real numbers in the title (not a spinner), a failure never read as done,
 * a stalled run resumable like a failed one, the door to what was created.
 */
import { describe, expect, it } from "vitest";
import { setAmbientCatalogLocale } from "@synap-core/types/i18n";
import {
  approvalDoor,
  approvalProgressCopy,
  countsLine,
  isApplying,
  progressUnavailable,
  stoppedOnTwins,
  type ApprovalRun,
} from "./approval-progress-model";

const RUN: ApprovalRun = {
  runId: "r1",
  proposalId: "p1",
  state: "running",
  phase: "entities",
  total: 4222,
  done: 1240,
  created: 1180,
  linked: 52,
  failed: 8,
  error: null,
  primaryId: null,
  sessionId: null,
  relationsFailed: 0,
};

describe("approvalProgressCopy", () => {
  it("running: the real count in the title, the split under it, a bar", () => {
    const copy = approvalProgressCopy(RUN);
    expect(copy.title).toBe("Creating records: 1,240 of 4,222");
    expect(copy.detail).toBe("1,180 created · 52 already there · 8 failed");
    expect(copy).toMatchObject({ busy: true, percent: 29, door: null });
  });

  it("finishing: says so once every operation settled", () => {
    expect(
      approvalProgressCopy({ ...RUN, phase: "finishing", done: 4222 }).title
    ).toBe("Finishing up: 4,222 of 4,222");
  });

  it("queued: waiting, indeterminate, still busy", () => {
    const copy = approvalProgressCopy({ ...RUN, state: "queued", done: 0 });
    expect(copy).toMatchObject({ busy: true, percent: null });
    expect(copy.title).toBe("Waiting to start: 4,222 changes");
  });

  it("failed: never reads as done — the stop point, the reason, Resume", () => {
    const copy = approvalProgressCopy({
      ...RUN,
      state: "failed",
      error: 'Couldn\'t create — "Acme" already exists.',
    });
    expect(copy).toMatchObject({
      tone: "danger",
      busy: false,
      resumable: true,
    });
    expect(copy.title).toBe("Stopped at 1,240 of 4,222");
    expect(copy.detail).toMatch(/Acme/);
    expect(copy.door).toBeNull();
  });

  it("stalled reads like failed (the worker stopped), resumable", () => {
    const copy = approvalProgressCopy({
      ...RUN,
      state: "stalled",
      error: null,
    });
    expect(copy).toMatchObject({ tone: "danger", resumable: true });
    expect(copy.detail).toMatch(/stopped before it finished/);
  });

  it("succeeded with a dropped connection is a warning, not a clean success", () => {
    const clean = approvalProgressCopy({
      ...RUN,
      state: "succeeded",
      done: 4222,
      failed: 0,
      relationsFailed: 0,
    });
    expect(clean.tone).toBe("success");
    const partial = approvalProgressCopy({
      ...RUN,
      state: "succeeded",
      done: 4222,
      failed: 0,
      relationsFailed: 3,
    });
    expect(partial.tone).toBe("warning");
    expect(partial.detail).toMatch(/3 connections did not land/);
  });

  it("a failed READ is its own state: busy (it may still run), never done", () => {
    expect(progressUnavailable()).toMatchObject({ busy: true, door: null });
  });
});

describe("approvalDoor — where 'see what was created' goes", () => {
  it("the session first, then the first record, then the proposal", () => {
    expect(approvalDoor({ ...RUN, sessionId: "s1", primaryId: "e1" })).toEqual({
      kind: "object",
      objectKind: "session",
      id: "s1",
    });
    expect(approvalDoor({ ...RUN, primaryId: "e1" })).toEqual({
      kind: "object",
      objectKind: "entity",
      id: "e1",
    });
    expect(approvalDoor(RUN)).toEqual({
      kind: "object",
      objectKind: "proposal",
      id: "p1",
    });
  });
});

describe("helpers", () => {
  it("countsLine omits zero parts; null when nothing counted", () => {
    expect(countsLine({ ...RUN, linked: 0, failed: 0 })).toBe("1,180 created");
    expect(countsLine({ ...RUN, created: 0, linked: 0, failed: 0 })).toBeNull();
  });
  it("isApplying: queued and running only", () => {
    expect(isApplying(RUN)).toBe(true);
    expect(isApplying({ ...RUN, state: "queued" })).toBe(true);
    expect(isApplying({ ...RUN, state: "stalled" })).toBe(false);
    expect(isApplying(null)).toBe(false);
  });
});

describe("a run that stopped on a record that already exists", () => {
  const STOPPED: ApprovalRun = {
    ...RUN,
    state: "failed",
    done: 1,
    total: 358,
    error: "Couldn't create — \u201ccontactsamirt\u201d already exists.",
    twins: [{ id: "e1", title: "contactsamirt", kind: "person" }],
  };

  it("names the record and asks for one answer, never a bare Resume", () => {
    expect(stoppedOnTwins(STOPPED)).toBe(true);
    const copy = approvalProgressCopy(STOPPED);
    expect(copy.title).toBe(
      "Stopped at 1 of 358: \u201ccontactsamirt\u201d already exists"
    );
    expect(copy.detail).toMatch(/every record that already exists/);
    expect(copy).toMatchObject({ tone: "danger", resumable: true });
  });

  it("any other stop keeps the plain Resume copy", () => {
    expect(stoppedOnTwins({ ...STOPPED, twins: null })).toBe(false);
    expect(stoppedOnTwins({ ...STOPPED, twins: undefined })).toBe(false);
    expect(stoppedOnTwins({ ...STOPPED, state: "succeeded" })).toBe(false);
    expect(approvalProgressCopy({ ...STOPPED, twins: null }).title).toBe(
      "Stopped at 1 of 358"
    );
  });

  it("a finished run says what it left out", () => {
    const copy = approvalProgressCopy({
      ...RUN,
      state: "succeeded",
      failed: 0,
      skipped: 2,
    });
    expect(copy.detail).toContain(
      "2 left out: several existing records share the name"
    );
    expect(copy.tone).toBe("warning");
  });
});

describe("in French", () => {
  const withFrench = (fn: () => void) => {
    setAmbientCatalogLocale("fr");
    try {
      fn();
    } finally {
      setAmbientCatalogLocale("en");
    }
  };
  const flat = (s: string | null) => (s ?? "").replace(/\s+/g, " ");

  it("every state says its numbers and its sentence in French", () => {
    withFrench(() => {
      const running = approvalProgressCopy(RUN);
      expect(flat(running.title)).toBe("Création des fiches : 1 240 sur 4 222");
      expect(flat(running.detail)).toBe(
        "1 180 créées · 52 déjà présentes · 8 en échec"
      );
      expect(
        flat(approvalProgressCopy({ ...RUN, state: "queued" }).title)
      ).toBe("En attente de démarrage : 4 222 modifications");
      expect(
        flat(approvalProgressCopy({ ...RUN, state: "succeeded" }).title)
      ).toBe("Approuvée : 4 222 modifications appliquées");
      expect(
        flat(approvalProgressCopy({ ...RUN, state: "stalled" }).title)
      ).toBe("Arrêtée à 1 240 sur 4 222");
      expect(flat(progressUnavailable().title)).toBe(
        "Impossible de lire la progression de l’approbation"
      );
    });
  });

  it("no English sentence is left in any state", () => {
    withFrench(() => {
      const states = [
        { ...RUN, state: "queued" as const },
        RUN,
        { ...RUN, phase: "finishing" as const },
        { ...RUN, state: "succeeded" as const, relationsFailed: 3, skipped: 2 },
        { ...RUN, state: "failed" as const },
        {
          ...RUN,
          state: "failed" as const,
          twins: [{ id: "t", title: "Acme", kind: "company" }],
        },
      ];
      const seen = states
        .flatMap((run) => {
          const copy = approvalProgressCopy(run);
          return [copy.title, copy.detail];
        })
        .concat(progressUnavailable().title, progressUnavailable().detail)
        .join(" | ");
      for (const english of [
        "Creating records",
        "Waiting to start",
        "Finishing up",
        "Approved:",
        "Stopped at",
        "already exists",
        "created",
        "already there",
        "failed",
        "did not land",
        "left out",
        "Can’t read",
        "still applying",
      ]) {
        expect(seen).not.toContain(english);
      }
      expect(flat(seen)).toContain("« Acme » existe déjà");
    });
  });
});
