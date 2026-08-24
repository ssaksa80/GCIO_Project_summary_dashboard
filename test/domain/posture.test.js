/**
 * Section 5 — Security Posture. These freeze the rules the CIO reads off the
 * page: what "worst" means, what the headline claims, and that an unassessed
 * domain never flatters the overall score.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildPosture } from "../../server/sections.js";

const TODAY = "2026-08-24";

function row(over = {}) {
  return {
    domain: "A Domain", control: "", status: "Compliant",
    score: 90, target: 90, owner: "An Owner",
    lastAssessed: "2026-08-01", nextReview: "2026-12-01",
    openFindings: 0, criticalFindings: 0, projectId: null, notes: "",
    ...over,
  };
}

const ctx = (projects = []) => ({
  todayISO: TODAY,
  projectsById: new Map(projects.map((p) => [p.id, p])),
});

test("no posture rows means the section reports itself unavailable", () => {
  const sec = buildPosture([], ctx());
  assert.equal(sec.available, false);
  assert.match(sec.headline, /No Security Posture sheet/i);
  assert.deepEqual(sec.domains, []);
});

test("the weakest domain is the one furthest short of its target", () => {
  const sec = buildPosture([
    row({ domain: "Closer", status: "Non-Compliant", score: 61, target: 90 }),   // 29 short
    row({ domain: "Furthest", status: "Non-Compliant", score: 52, target: 95 }), // 43 short
  ], ctx());

  assert.equal(sec.weakest[0].domain, "Furthest");
  assert.match(sec.headline, /worst is Furthest at 52% against a 95% target/);
});

test("non-compliant domains outrank partial ones however small the gap", () => {
  const sec = buildPosture([
    row({ domain: "Partial big gap", status: "Partial", score: 40, target: 95 }),
    row({ domain: "Non-compliant small gap", status: "Non-Compliant", score: 88, target: 90 }),
  ], ctx());
  assert.equal(sec.weakest[0].domain, "Non-compliant small gap");
});

test("an unassessed domain is excluded from the overall score", () => {
  const sec = buildPosture([
    row({ domain: "Assessed", score: 80, target: 100 }),
    row({ domain: "Never looked at", status: "Not Assessed", score: 0, target: 100 }),
  ], ctx());

  assert.equal(sec.overallScore, 80);
  assert.equal(sec.counts.notAssessed, 1);
  assert.equal(sec.counts.total, 2);
});

test("a review dated before today is flagged overdue with its age", () => {
  const sec = buildPosture([
    row({ domain: "Stale", nextReview: "2026-08-15" }),
    row({ domain: "Fresh", nextReview: "2026-12-15" }),
  ], ctx());

  assert.equal(sec.counts.reviewsOverdue, 1);
  assert.equal(sec.overdueReviews[0].domain, "Stale");
  assert.equal(sec.overdueReviews[0].reviewOverdueDays, 9);
  assert.equal(sec.domains.find((d) => d.domain === "Fresh").reviewOverdue, false);
});

test("a domain naming a real project links to it; a dangling id does not", () => {
  const projects = [{ id: "PRJ-1", name: "Remediation Thing", health: "Amber", percentComplete: 70 }];
  const sec = buildPosture([
    row({ domain: "Linked", projectId: "PRJ-1" }),
    row({ domain: "Dangling", projectId: "PRJ-NOPE" }),
  ], ctx(projects));

  assert.equal(sec.remediation.length, 1);
  assert.equal(sec.remediation[0].project.name, "Remediation Thing");
  assert.equal(sec.domains.find((d) => d.domain === "Dangling").linkedProject, null);
});

test("findings are totalled across domains", () => {
  const sec = buildPosture([
    row({ domain: "One", openFindings: 10, criticalFindings: 2 }),
    row({ domain: "Two", openFindings: 5, criticalFindings: 1 }),
  ], ctx());
  assert.equal(sec.counts.openFindings, 15);
  assert.equal(sec.counts.criticalFindings, 3);
});

test("a domain at or above target reports no gap", () => {
  const sec = buildPosture([row({ domain: "Ahead", score: 96, target: 95 })], ctx());
  assert.equal(sec.domains[0].gap, 0);
  assert.match(sec.headline, /All 1 assessed domains are compliant/);
});
