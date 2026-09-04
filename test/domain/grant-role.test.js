/*
 * The break-glass CLI: grant, list and revoke a role from the host, without
 * the admin console.
 *
 * Ports DEDB's tools/grant-role.js, including the shape that makes it
 * testable - argv in, {code, lines} out, driven by an injected repo, with no
 * database or filesystem of its own.
 *
 * It exists for the case the console cannot cover: nobody holds a role, so
 * nobody can sign in, so nobody can open the screen that grants one. That is
 * the normal state of a fresh database, and it is also where a directory
 * outage leaves you.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { runGrantRole, ROLES, USAGE } from "../../server/tools/grant-role.js";

function fakeRepo(initial = {}) {
  const rows = new Map(
    Object.entries(initial).map(([p, r]) => [p, { Principal: p, Role: r, GrantedBy: "someone", GrantedAt: "2026-01-01" }]),
  );
  return {
    rows,
    async list() { return [...rows.values()]; },
    async set(principal, role, grantedBy) {
      rows.set(principal, { Principal: principal, Role: role, GrantedBy: grantedBy, GrantedAt: "now" });
    },
    async remove(principal) { rows.delete(principal); },
  };
}

const out = (res) => res.lines.join("\n");

test("granting a role writes it and reports what it did", async () => {
  const repo = fakeRepo();
  const res = await runGrantRole(["jdoe", "admin"], { repo });
  assert.equal(res.code, 0);
  assert.equal(repo.rows.get("jdoe").Role, "admin");
  assert.match(out(res), /jdoe/);
  assert.match(out(res), /admin/);
});

test("the grant records that it came from the CLI, not from a person", async () => {
  /* GrantedBy is read months later to answer "who did this". A row from the
     break-glass tool must not look like someone used the console. */
  const repo = fakeRepo();
  await runGrantRole(["jdoe", "admin"], { repo });
  assert.match(repo.rows.get("jdoe").GrantedBy, /cli|break-glass/i);
});

test("the role is case-insensitive, because an operator typing it is not a form", async () => {
  const repo = fakeRepo();
  assert.equal((await runGrantRole(["jdoe", "ADMIN"], { repo })).code, 0);
  assert.equal(repo.rows.get("jdoe").Role, "admin");
});

test("a role the application does not know is a usage error, and writes nothing", async () => {
  const repo = fakeRepo();
  const res = await runGrantRole(["jdoe", "superuser"], { repo });
  assert.equal(res.code, 2);
  for (const role of ROLES) assert.match(out(res), new RegExp(role), `the message must name ${role}`);
  assert.equal(repo.rows.size, 0);
});

test("missing arguments print usage rather than doing something surprising", async () => {
  const repo = fakeRepo();
  for (const argv of [[], ["jdoe"], [""]]) {
    const res = await runGrantRole(argv, { repo });
    assert.equal(res.code, 2, `argv ${JSON.stringify(argv)} should be a usage error`);
    assert.ok(out(res).includes(USAGE.split("\n")[0]), "usage must be shown");
  }
  assert.equal(repo.rows.size, 0);
});

test("--list shows every grant", async () => {
  const res = await runGrantRole(["--list"], { repo: fakeRepo({ jdoe: "admin", asmith: "pm" }) });
  assert.equal(res.code, 0);
  assert.match(out(res), /jdoe/);
  assert.match(out(res), /asmith/);
});

test("--list says so plainly when there are none", async () => {
  /* An empty table is the state that explains "nobody can sign in", so it must
     read as an answer rather than as a command that printed nothing. */
  const res = await runGrantRole(["--list"], { repo: fakeRepo() });
  assert.equal(res.code, 0);
  assert.match(out(res), /none|no grants/i);
});

test("--remove revokes a grant", async () => {
  const repo = fakeRepo({ jdoe: "admin" });
  const res = await runGrantRole(["--remove", "jdoe"], { repo });
  assert.equal(res.code, 0);
  assert.equal(repo.rows.size, 0);
  assert.match(out(res), /jdoe/);
});

test("--remove with no name is a usage error, not a removal of nothing", async () => {
  const repo = fakeRepo({ jdoe: "admin" });
  const res = await runGrantRole(["--remove"], { repo });
  assert.equal(res.code, 2);
  assert.equal(repo.rows.size, 1, "the existing grant must survive");
});

test("a principal is stored as typed and left for the repo to normalise", async () => {
  /* The repo owns toSam. Normalising here as well would put the rule in two
     places, and they would drift. */
  const repo = fakeRepo();
  await runGrantRole(["EXAMPLE\\jdoe", "pm"], { repo });
  assert.ok(repo.rows.has("EXAMPLE\\jdoe"), "the CLI must pass the principal through untouched");
});

/*
 * Deliberately NOT ported: the console's refusal to remove your own last admin
 * grant. That guard exists because the console locks itself out - the screen
 * you would use to undo it is behind the check. This tool has no such problem:
 * whatever it removes, it can grant straight back. Refusing here would disarm
 * the recovery path in exactly the situation it exists for.
 */
test("the CLI will remove the last admin grant, because it can also restore it", async () => {
  const repo = fakeRepo({ jdoe: "admin" });
  const res = await runGrantRole(["--remove", "jdoe"], { repo });
  assert.equal(res.code, 0, "the break-glass tool must not refuse the thing it exists to undo");
  assert.equal(repo.rows.size, 0);
});

test("the output tells the operator what to do next", async () => {
  /* Granting a role is half the job; the person still has to sign in again,
     and an operator who does not know that reports the tool as broken. */
  const res = await runGrantRole(["jdoe", "admin"], { repo: fakeRepo() });
  assert.match(out(res), /sign in|sign-in/i);
});
