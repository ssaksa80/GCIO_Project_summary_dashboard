/**
 * Entra SSO. Tokens are signed with a real key pair generated per test, so the
 * verification path is exercised properly rather than stubbed — the point of
 * this code is that it rejects the wrong things.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, SignJWT, calculateJwkThumbprint } from "jose";

import { validateEntraIdToken, validateWithRefresh } from "../../server/auth/entraToken.js";
import { makeEntraJwks, jwksUrlFor } from "../../server/auth/entraJwks.js";

const ISSUER = "https://login.microsoftonline.com/tenant-abc/v2.0";
const CLIENT_ID = "client-123";

/** A signing key plus the public JWKS a verifier would hold for it. */
async function keyMaterial() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = await calculateJwkThumbprint(jwk);
  jwk.alg = "RS256";
  return { privateKey, jwks: { keys: [jwk] }, kid: jwk.kid };
}

async function signToken({ privateKey, kid }, claims = {}, { expiresIn = "5m" } = {}) {
  return new SignJWT({
    preferred_username: "jsmith@example.local",
    email: "jsmith@example.local",
    amr: ["pwd", "mfa"],
    groups: ["11111111-2222-3333-4444-555555555555"],
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(privateKey);
}

const cfg = (jwks) => ({ issuer: ISSUER, clientId: CLIENT_ID, jwks });

test("a well-formed token from the right tenant is accepted", async () => {
  const km = await keyMaterial();
  const token = await signToken(km);

  const result = await validateEntraIdToken(token, cfg(km.jwks));
  assert.equal(result.ok, true);
  assert.equal(result.sam, "jsmith");
  assert.deepEqual(result.groups, ["11111111-2222-3333-4444-555555555555"]);
});

test("a token for another audience is refused", async () => {
  const km = await keyMaterial();
  const token = await new SignJWT({ preferred_username: "x@y", amr: ["mfa"] })
    .setProtectedHeader({ alg: "RS256", kid: km.kid })
    .setIssuer(ISSUER).setAudience("some-other-app").setIssuedAt().setExpirationTime("5m")
    .sign(km.privateKey);

  assert.deepEqual(await validateEntraIdToken(token, cfg(km.jwks)), { ok: false, reason: "verify" });
});

test("a token from another issuer is refused", async () => {
  const km = await keyMaterial();
  const token = await new SignJWT({ preferred_username: "x@y", amr: ["mfa"] })
    .setProtectedHeader({ alg: "RS256", kid: km.kid })
    .setIssuer("https://evil.example/v2.0").setAudience(CLIENT_ID).setIssuedAt().setExpirationTime("5m")
    .sign(km.privateKey);

  assert.deepEqual(await validateEntraIdToken(token, cfg(km.jwks)), { ok: false, reason: "verify" });
});

test("an expired token is reported as expired, not as a forgery", async () => {
  const km = await keyMaterial();
  const token = await new SignJWT({ preferred_username: "x@y", amr: ["mfa"] })
    .setProtectedHeader({ alg: "RS256", kid: km.kid })
    .setIssuer(ISSUER).setAudience(CLIENT_ID)
    .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
    .sign(km.privateKey);

  assert.deepEqual(await validateEntraIdToken(token, cfg(km.jwks)), { ok: false, reason: "expired" });
});

test("a token signed by a key we do not hold is a stale key set, not a bad token", async () => {
  const ours = await keyMaterial();
  const theirs = await keyMaterial();
  const token = await signToken(theirs);

  assert.deepEqual(await validateEntraIdToken(token, cfg(ours.jwks)), { ok: false, reason: "unknown_kid" });
});

test("a token without the MFA claim is refused by default", async () => {
  const km = await keyMaterial();
  const token = await signToken(km, { amr: ["pwd"] });

  assert.deepEqual(await validateEntraIdToken(token, cfg(km.jwks)), { ok: false, reason: "no_mfa" });

  const relaxed = await validateEntraIdToken(token, { ...cfg(km.jwks), requireMfaClaim: false });
  assert.equal(relaxed.ok, true);
});

test("a mismatched nonce is refused", async () => {
  const km = await keyMaterial();
  const token = await signToken(km, { nonce: "expected" });

  assert.equal((await validateEntraIdToken(token, cfg(km.jwks), { nonce: "expected" })).ok, true);
  assert.deepEqual(
    await validateEntraIdToken(token, cfg(km.jwks), { nonce: "different" }),
    { ok: false, reason: "nonce" }
  );
});

test("identity binding applies only when the caller says who to expect", async () => {
  const km = await keyMaterial();
  const token = await signToken(km);

  assert.equal((await validateEntraIdToken(token, cfg(km.jwks))).ok, true, "SSO path binds to nothing");
  assert.equal((await validateEntraIdToken(token, cfg(km.jwks), { expectedPrincipal: "jsmith" })).ok, true);
  assert.deepEqual(
    await validateEntraIdToken(token, cfg(km.jwks), { expectedPrincipal: "someone.else" }),
    { ok: false, reason: "identity" }
  );
});

/* ------------------------------------------------------------------ JWKS */

function fakeFetch(responses) {
  const calls = [];
  return {
    calls,
    impl: async (url) => {
      calls.push(url);
      const next = responses.shift();
      if (!next) throw new Error("no response scripted");
      if (next instanceof Error) throw next;
      return { ok: true, status: 200, json: async () => next };
    },
  };
}

test("keys are fetched once and served from cache until the ttl expires", async () => {
  const km = await keyMaterial();
  const fetcher = fakeFetch([km.jwks, km.jwks]);
  let clock = 1_000_000;
  const jwks = makeEntraJwks({ tenantId: "tenant-abc", fetchImpl: fetcher.impl, now: () => clock, ttlMs: 60_000 });

  assert.equal((await jwks.get()).keys.length, 1);
  clock += 30_000;
  await jwks.get();
  assert.equal(fetcher.calls.length, 1, "a fresh cache must not refetch");

  clock += 40_000;
  await jwks.get();
  assert.equal(fetcher.calls.length, 2, "an expired cache must refetch");
  assert.equal(fetcher.calls[0], jwksUrlFor("tenant-abc"));
});

test("a transient failure retries, and the retries are bounded", async () => {
  const km = await keyMaterial();
  const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  const fetcher = fakeFetch([reset, reset, km.jwks]);
  const jwks = makeEntraJwks({ tenantId: "t", fetchImpl: fetcher.impl, attempts: 3, logger: { warn() {} } });

  const keys = await jwks.get();
  assert.equal(keys.keys.length, 1);
  assert.equal(fetcher.calls.length, 3);
});

test("when the network is down the last good set is still served", async () => {
  const km = await keyMaterial();
  let clock = 1_000_000;
  const down = Object.assign(new Error("reset"), { code: "ECONNRESET" });
  const fetcher = fakeFetch([km.jwks, down, down, down]);
  const jwks = makeEntraJwks({
    tenantId: "t", fetchImpl: fetcher.impl, now: () => clock,
    ttlMs: 10, cooldownMs: 0, attempts: 3, logger: { warn() {} },
  });

  await jwks.get();
  clock += 1000;
  const stale = await jwks.get();
  assert.equal(stale.keys.length, 1, "a stale set beats no set at all");
});

test("with no cache and no network, an operator's offline keys are used", async () => {
  const km = await keyMaterial();
  const down = Object.assign(new Error("reset"), { code: "ECONNRESET" });
  const fetcher = fakeFetch([down, down, down]);
  const jwks = makeEntraJwks({
    tenantId: "t", fetchImpl: fetcher.impl, offlineKeys: km.jwks, attempts: 3, logger: { warn() {} },
  });

  assert.equal((await jwks.get()).keys.length, 1);
});

test("a forced refetch respects the cooldown, so bad tokens cannot cause a fetch storm", async () => {
  const km = await keyMaterial();
  let clock = 1_000_000;
  const fetcher = fakeFetch([km.jwks, km.jwks]);
  const jwks = makeEntraJwks({
    tenantId: "t", fetchImpl: fetcher.impl, now: () => clock, ttlMs: 60_000, cooldownMs: 30_000,
  });

  await jwks.get();
  clock += 1000;
  for (let i = 0; i < 5; i += 1) await jwks.get({ force: true });
  assert.equal(fetcher.calls.length, 1, "the cooldown was not honoured");

  clock += 31_000;
  await jwks.get({ force: true });
  assert.equal(fetcher.calls.length, 2);
});

test("a rotated key is picked up by one forced refetch, so the sign-in succeeds", async () => {
  const oldKey = await keyMaterial();
  const newKey = await keyMaterial();
  const token = await signToken(newKey);

  let clock = 1_000_000;
  const fetcher = fakeFetch([oldKey.jwks, newKey.jwks]);
  const jwks = makeEntraJwks({
    tenantId: "t", fetchImpl: fetcher.impl, now: () => clock, ttlMs: 60_000, cooldownMs: 0,
  });

  const result = await validateWithRefresh(token, { issuer: ISSUER, clientId: CLIENT_ID }, jwks);
  assert.equal(result.ok, true, `expected success, got ${result.reason}`);
  assert.equal(fetcher.calls.length, 2, "the stale set should have triggered exactly one refetch");
});
