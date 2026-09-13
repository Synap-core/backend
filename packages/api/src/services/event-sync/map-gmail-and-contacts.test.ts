import { describe, it, expect } from "vitest";
import {
  mapGmailThreadToGraph,
  type GmailThreadItem,
} from "./map-gmail-thread-to-graph.js";
import { mapGoogleContactToGraph } from "./map-google-contact-to-graph.js";
import {
  mergeSyncGraph,
  emptySyncGraph,
  parseAddressList,
  isAutomatedAddress,
} from "./sync-graph.js";
import { mapGcalToGraph } from "./map-gcal-to-graph.js";

// Literal `threads.list` item expanded with `threads.get?format=metadata`
// (messages[].id / internalDate / labelIds / payload.headers → `headers`).
const thread: GmailThreadItem = {
  id: "18f2a1b3c4d5e6f7",
  snippet: "Thanks, see you Tuesday",
  messages: [
    {
      id: "m1",
      internalDate: "1784000000000",
      labelIds: ["INBOX", "IMPORTANT"],
      headers: [
        { name: "From", value: '"Bets, Jelle" <Jelle@acme-corp.io>' },
        { name: "To", value: "Owner <owner@perso.me>" },
        {
          name: "Cc",
          value: "Ana Lima <ana@acme-corp.io>, no-reply@acme-corp.io",
        },
        { name: "Subject", value: "Proposal" },
      ],
    },
    {
      id: "m2",
      internalDate: "1784000500000",
      labelIds: ["SENT"],
      headers: [
        { name: "From", value: "Owner <owner@perso.me>" },
        { name: "To", value: "jelle@acme-corp.io, sam@gmail.com" },
      ],
    },
  ],
};

describe("parseAddressList", () => {
  it("does not split on commas inside quotes or angle brackets", () => {
    expect(
      parseAddressList('"Bets, Jelle" <Jelle@acme-corp.io>, bare@x.com, junk')
    ).toEqual([
      { email: "jelle@acme-corp.io", name: "Bets, Jelle" },
      { email: "bare@x.com" },
    ]);
  });

  it("flags automated local parts only", () => {
    expect(isAutomatedAddress("no-reply@acme.io")).toBe(true);
    expect(isAutomatedAddress("notifications+x@github.com")).toBe(true);
    expect(isAutomatedAddress("noreen@acme.io")).toBe(false);
  });
});

describe("mapGmailThreadToGraph", () => {
  const g = mapGmailThreadToGraph(thread)!;
  const refs = g.graph.entities.map((e) => e.ref).sort();

  it("yields correspondents, never the owner or an automated sender", () => {
    expect(refs).toEqual([
      "company:acme-corp.io",
      "person:ana@acme-corp.io",
      "person:jelle@acme-corp.io",
      "person:sam@gmail.com",
    ]);
  });

  it("keeps the display name and links people to their company", () => {
    const jelle = g.graph.entities.find(
      (e) => e.ref === "person:jelle@acme-corp.io"
    )!;
    expect(jelle.title).toBe("Bets, Jelle");
    expect(g.graph.relations).toEqual(
      expect.arrayContaining([
        {
          sourceRef: "person:jelle@acme-corp.io",
          targetRef: "company:acme-corp.io",
          type: "works_at",
        },
        {
          sourceRef: "person:ana@acme-corp.io",
          targetRef: "company:acme-corp.io",
          type: "works_at",
        },
      ])
    );
    expect(g.graph.relations).toHaveLength(2);
  });

  it("reports the latest message time for the cursor", () => {
    expect(g.lastMessageMs).toBe(1784000500000);
  });

  it("skips a thread the user never wrote in, or whose detail failed", () => {
    expect(
      mapGmailThreadToGraph({ ...thread, messages: [thread.messages![0]!] })
    ).toBeNull();
    expect(mapGmailThreadToGraph({ id: "x", error: "403" })).toBeNull();
  });
});

describe("mapGoogleContactToGraph", () => {
  it("maps a contact to a person keyed on its resourceName", () => {
    const c = mapGoogleContactToGraph({
      resourceName: "people/c123",
      names: [{ displayName: "Jelle Bets", metadata: { primary: true } }],
      emailAddresses: [{ value: "Jelle@acme-corp.io" }],
      phoneNumbers: [{ value: "+33 6 12 34 56 78" }],
      organizations: [{ name: "Acme", title: "CTO" }],
    })!;
    const person = c.graph.entities.find((e) => e.profileSlug === "person")!;
    expect(person).toMatchObject({
      ref: "person:jelle@acme-corp.io",
      title: "Jelle Bets",
      properties: {
        email: "jelle@acme-corp.io",
        phone: "+33 6 12 34 56 78",
        jobTitle: "CTO",
        googleContactId: "people/c123",
      },
      identity: { source: "google", externalId: "people/c123", url: null },
    });
    expect(c.graph.relations).toEqual([
      {
        sourceRef: "person:jelle@acme-corp.io",
        targetRef: "company:acme-corp.io",
        type: "works_at",
      },
    ]);
  });

  it("skips a contact with no strong identity signal", () => {
    expect(
      mapGoogleContactToGraph({
        resourceName: "people/c9",
        names: [{ displayName: "Name Only" }],
      })
    ).toBeNull();
  });
});

describe("cross-kind merge", () => {
  it("folds the same person from an event, a thread and a contact into ONE entity", () => {
    const graph = emptySyncGraph();
    mergeSyncGraph(
      graph,
      mapGcalToGraph({
        id: "ev1",
        start: { dateTime: "2026-07-16T15:30:00Z" },
        attendees: [{ email: "jelle@acme-corp.io" }],
      })!.graph
    );
    mergeSyncGraph(graph, mapGmailThreadToGraph(thread)!.graph);
    mergeSyncGraph(
      graph,
      mapGoogleContactToGraph({
        resourceName: "people/c123",
        emailAddresses: [{ value: "jelle@acme-corp.io" }],
        phoneNumbers: [{ value: "+33612345678" }],
      })!.graph
    );

    const jelles = graph.entities.filter(
      (e) => e.ref === "person:jelle@acme-corp.io"
    );
    expect(jelles).toHaveLength(1);
    // The provider identity (a real record) wins over the derived email one,
    // and later sightings fill properties without overwriting.
    expect(jelles[0]!.identity).toEqual({
      source: "google",
      externalId: "people/c123",
      url: null,
    });
    expect(jelles[0]!.properties.phone).toBe("+33612345678");
    expect(
      graph.relations.filter(
        (r) =>
          r.sourceRef === "person:jelle@acme-corp.io" && r.type === "works_at"
      )
    ).toHaveLength(1);
  });
});
