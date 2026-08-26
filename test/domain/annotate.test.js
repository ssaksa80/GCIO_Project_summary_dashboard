import test from "node:test";
import assert from "node:assert/strict";
import { annotateChanges } from "../../server/sections.js";

const sections = () => ({
  successes: { items: [{ id: "PRJ-1", name: "One" }] },
  qri: {
    questions: [{ id: "PRJ-2", text: "?" }],
    risks: [{ id: "PRJ-1", title: "r" }],
  },
  priorities: { items: [{ id: "PRJ-2", name: "Two" }], watchlist: [{ id: "PRJ-3", name: "Three" }] },
  roadmap: { inFlight: [{ id: "PRJ-1" }], planned: [] },
  posture: { domains: [{ domain: "Identity", projectId: "PRJ-1" }] },
});

const changes = () => new Map([
  ["PRJ-1", { headline: "health Green to Red", worst: "worse", fields: { health: { from: "Green", to: "Red" } }, since: "2026-08-18T00:00:00.000Z" }],
  ["PRJ-3", { trackedSince: "2026-08-24T00:00:00.000Z" }],
]);

test("every item carrying a changed project's id is annotated, wherever it sits", () => {
  const s = sections();
  annotateChanges(s, changes());

  assert.equal(s.successes.items[0].change.headline, "health Green to Red");
  assert.equal(s.qri.risks[0].change.worst, "worse");
  assert.equal(s.roadmap.inFlight[0].change.headline, "health Green to Red");
  assert.equal(s.priorities.watchlist[0].change.trackedSince, "2026-08-24T00:00:00.000Z");
});

test("an item whose project did not move is left exactly as it was", () => {
  const s = sections();
  annotateChanges(s, changes());
  assert.equal(s.priorities.items[0].change, undefined, "an unchanged project was annotated");
  assert.equal(s.qri.questions[0].change, undefined);
});

test("null changes means we cannot know, and nothing is annotated", () => {
  const s = sections();
  annotateChanges(s, null);
  for (const item of [s.successes.items[0], s.qri.risks[0], s.roadmap.inFlight[0]]) {
    assert.equal(item.change, undefined);
  }
  assert.equal(s.historyAvailable, false);
});

test("an empty map means nothing moved, which is a real answer", () => {
  const s = sections();
  annotateChanges(s, new Map());
  assert.equal(s.historyAvailable, true);
  assert.equal(s.successes.items[0].change, undefined);
});

test("posture rows are annotated by their project, not their domain name", () => {
  const s = sections();
  annotateChanges(s, changes());
  assert.equal(s.posture.domains[0].change.worst, "worse");
});

test("a project object referenced from two sections is annotated once, not twice", () => {
  /* The fixture in the other tests builds a fresh literal per mention, which
     is not how buildSections works — several sections hand out references to
     the same project object. */
  const shared = { id: "PRJ-1", name: "One" };
  const s = {
    successes: { items: [shared] },
    priorities: { items: [shared], watchlist: [] },
    qri: { questions: [], risks: [] },
    roadmap: { inFlight: [], planned: [] },
    posture: { domains: [] },
  };

  annotateChanges(s, changes());
  assert.equal(s.successes.items[0], s.priorities.items[0], "the fixture stopped sharing");
  assert.equal(s.successes.items[0].change.headline, "health Green to Red");
});

test("a cycle in the section data does not blow the stack", () => {
  /* Not hypothetical: a project that references its parent, which lists its
     children, is a cycle. Without the seen set this recurses until it dies. */
  const parent = { id: "PRJ-1", name: "One", children: [] };
  const child = { id: "PRJ-3", name: "Three", parent };
  parent.children.push(child);

  const s = { successes: { items: [parent] }, qri: { questions: [], risks: [] },
              priorities: { items: [], watchlist: [] }, roadmap: { inFlight: [], planned: [] },
              posture: { domains: [] } };

  assert.doesNotThrow(() => annotateChanges(s, changes()));
  assert.equal(parent.change.worst, "worse");
  assert.equal(child.change.trackedSince, "2026-08-24T00:00:00.000Z");
});

test("a section shape it has never seen does not throw", () => {
  /* A future section with a different internal shape must degrade, not crash
     the whole briefing. */
  const odd = { successes: { items: null }, somethingNew: { rows: [{ id: "PRJ-1" }] } };
  assert.doesNotThrow(() => annotateChanges(odd, changes()));
  assert.equal(odd.somethingNew.rows[0].change.worst, "worse");
});
