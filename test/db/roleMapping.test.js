/**
 * Group-to-role mapping, including the first-run bootstrap.
 *
 * The bootstrap matters more than it looks: with an empty map every sign-in
 * folds to no role and is refused, so a fresh database is unreachable until
 * one mapping exists. Seeding it must also be a one-time act — once an
 * administrator exists, the seed group must not be able to grant itself
 * access again by emptying nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { roleMappingRepo } from "../../server/repos/roleMapping.js";

function scriptedExecutor({ rows = [] } = {}) {
  const statements = [];
  return {
    statements,
    async query(text, params) {
      statements.push({ text: text.trim(), params: params || [] });
      if (text.includes("FROM dbo.RoleMapping")) return { recordset: rows, rowsAffected: [rows.length] };
      return { recordset: [], rowsAffected: [0] };
    },
    async tx(fn) { return fn(this); },
  };
}

test("an empty map with a seed group installs exactly one admin mapping", async () => {
  const ex = scriptedExecutor({ rows: [] });
  const seeded = await roleMappingRepo(ex).seedIfEmpty("GCIO-Dashboard-Admins");

  assert.equal(seeded, "GCIO-Dashboard-Admins");
  const merged = ex.statements.find((s) => s.text.startsWith("MERGE dbo.RoleMapping"));
  assert.ok(merged, "no mapping was written");
  assert.equal(merged.params.find((p) => p.name === "role").value, "admin");
  assert.equal(merged.params.find((p) => p.name === "group").value, "GCIO-Dashboard-Admins");
});

test("a map that already has entries is never seeded over", async () => {
  const ex = scriptedExecutor({ rows: [{ GroupName: "someone-elses-group", Role: "viewer" }] });
  const seeded = await roleMappingRepo(ex).seedIfEmpty("GCIO-Dashboard-Admins");

  assert.equal(seeded, null);
  assert.ok(!ex.statements.some((s) => s.text.startsWith("MERGE")), "an existing map was overwritten");
});

test("no seed group configured means no mapping is invented", async () => {
  const ex = scriptedExecutor({ rows: [] });
  assert.equal(await roleMappingRepo(ex).seedIfEmpty(""), null);
  assert.equal(await roleMappingRepo(ex).seedIfEmpty(undefined), null);
  assert.ok(!ex.statements.some((s) => s.text.startsWith("MERGE")));
});

test("seeding works when the method is detached from the repository", async () => {
  /* Called as `const { seedIfEmpty } = repo` it must not depend on `this`. */
  const ex = scriptedExecutor({ rows: [] });
  const { seedIfEmpty } = roleMappingRepo(ex);
  assert.equal(await seedIfEmpty("GCIO-Dashboard-Admins"), "GCIO-Dashboard-Admins");
});

test("the seeded mapping is immediately visible to role resolution", async () => {
  /* getMap caches, so seeding has to invalidate it — otherwise the very first
     sign-in after a seed still sees an empty map and is refused. */
  let rows = [];
  const ex = {
    statements: [],
    async query(text, params) {
      this.statements.push({ text: text.trim(), params: params || [] });
      if (text.includes("MERGE dbo.RoleMapping")) {
        rows = [{ GroupName: params.find((p) => p.name === "group").value, Role: "admin" }];
        return { recordset: [], rowsAffected: [1] };
      }
      if (text.includes("FROM dbo.RoleMapping")) return { recordset: rows, rowsAffected: [rows.length] };
      return { recordset: [], rowsAffected: [0] };
    },
    async tx(fn) { return fn(this); },
  };

  const repo = roleMappingRepo(ex);
  await repo.getMap();                       // warm the cache while the map is empty
  await repo.seedIfEmpty("GCIO-Dashboard-Admins");

  const map = await repo.getMap();
  assert.equal(map["gcio-dashboard-admins"], "admin");
});

test("an unknown role is refused rather than written", async () => {
  const ex = scriptedExecutor({ rows: [] });
  await assert.rejects(() => roleMappingRepo(ex).set("some-group", "superuser"), /unknown role/);
});
