/*
 * Infrastructure tokens must not enter the repository.
 *
 * On 2026-09-03 this repository's public history was found to carry the live
 * directory's real values, and the remote had to be deleted and recreated
 * twice to remove them. Hours later, during the cleanup, a session committed
 * one of the values straight back - into two files and a commit message -
 * while writing a perfectly legitimate account of an operator incident.
 * Nothing in the repository noticed either time. This is the thing that
 * notices. Design: docs/superpowers/specs/2026-09-04-infra-token-sweep-design.md
 *
 * ALLOWLIST, not a denylist - the rule inherited from FMD's
 * mailNoRecipient.test.js, which learned it the same way: every hand-written
 * pattern missed a shape it had not thought of. Listing what is PERMITTED
 * fails closed. A token nobody listed here breaks the build, and adding one is
 * a visible decision with a reason attached.
 *
 * Auto-permits are limited to ranges an RFC reserves, so that a token which
 * passes structurally CANNOT be real infrastructure. Two deliberate omissions:
 * `.local` is mDNS (RFC 6762), not documentation-reserved, and it is the shape
 * this repository's leak actually took; RFC 1918 is private but real, and the
 * address that leaked was in it. Both therefore need exact entries.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/* Binary formats the text patterns cannot read anyway. package-lock.json is
 * excluded because npm integrity digests are base64: during the 2026-09-03
 * inventory one yielded a fragment that matched the machine-name pattern and
 * carried the same prefix as the real workstation, which cost a detour. */
const SKIP_EXT = new Set([".xlsx", ".xls", ".pdf", ".docx", ".zip", ".png", ".jpg", ".jpeg", ".ico", ".woff", ".woff2"]);
const SKIP_FILE = new Set(["package-lock.json"]);

/* Last label must be one of these for a dotted token to count as a domain at
 * all. Anything outside the set is a filename, a version, or prose. */
const TLDS = new Set("com org net local internal lan corp example test invalid localhost ae io me gov edu app cloud ai".split(" "));

/* RFC 6761 reserves these for testing and documentation; they can never be
 * real. RFC 2606 does the same for the three example.* second-level names. */
const RESERVED_TLDS = new Set(["test", "example", "invalid", "localhost"]);
const RESERVED_DOMAINS = new Set(["example.com", "example.net", "example.org"]);

const ALLOWED_DOMAINS = new Set([
  "schemas.openxmlformats.org",   // OOXML namespaces - xlsx/docx generation
  "purl.org",                     // Dublin Core namespace, via exceljs
  "www.w3.org",                   // XML/SVG namespaces
  "nodejs.org",                   // runtime docs referenced from comments
  "cdn.sheetjs.com",              // SheetJS distribution host, cited in docs
  "fonts.googleapis.com",         // webfont host named in the CSP notes
  "login.microsoftonline.com",    // Entra ID - OIDC issuer and JWKS
  "example.local",                // documentation placeholder (.local is NOT reserved)
  "dc01.example.local",           // placeholder DC, the installer default
  "dc02.example.local",           // placeholder DC, distinct from dc01 in runbook 7a
]);

const ALLOWED_IPS = new Set([
  "10.0.0.0",     // prose about the 10.0.0.0/8 range in deploy/iis-site.md
  "10.0.0.1",     // synthetic ECONNREFUSED peer in the auth tests
  "10.1.2.3",     // synthetic bind address, deploy/test/clean-stop.test.ps1
  "10.20.30.40",  // synthetic HOST value, deploy/test/clean-stop.test.ps1
  "1.6.0.1",      // a VERSION STRING in a preflight comment, not an address
]);

const ALLOWED_DNS = new Set([
  "dc=example", "dc=local", "dc=test", "dc=x",
  "ou=groups", "ou=people", "ou=service", "ou=svc", "ou=admin", "ou=service accounts",
  "cn=solo", "cn=svc", "cn=svc_app", "cn=real user",
  "cn=portfolio admins", "cn=portfolio viewers", "cn=gcio-dashboard-admins",
]);

const ALLOWED_MACHINES = new Set([
  "SHA256", "SHASUMS256", "RS256",  // digest and JWS algorithm names
  "UTF8", "BIFF8", "OLE2", "INK2",  // encoding and legacy-format names
  "DATETIME2",                      // T-SQL column type
  "KB5102333",                      // Windows update article cited in the runbook
  "APPSRV1",                        // placeholder host name
  "D800",                           // from the \uD800-\uDFFF surrogate range in a test
  "EQVR42", "MIQAAAABJRU5E",        // fragments of an inline base64 PNG in a plan document
]);

const ALLOWED_USERS = new Set([
  "<you>",     // documentation placeholder
  "<name>",    // documentation placeholder, used in the design spec table
]);

const DOMAIN_RE = /[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+/gi;
const IPV4_RE = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g;
/* No whitespace straight after "=" - a real DN never has it, and prose like
 * "a DN with no CN= names a container" otherwise parses as a DN value. */
const DN_RE = /(?:DC|OU|CN)=(?![ \t])[^,"'`\n\r]*/gi;
const MACHINE_RE = /(?<![A-Z0-9])[A-Z][A-Z0-9]{2,}[0-9][A-Z0-9-]*/g;
const USERPATH_RE = /(?:[A-Za-z]:[\\/]+Users[\\/]+|\/[a-z]\/Users\/)([A-Za-z0-9._<>-]+)/gi;

const isReservedIp = (ip) => {
  const o = ip.split(".").map(Number);
  if (o.some((n) => Number.isNaN(n) || n > 255)) return true;      // not an address
  if (o[0] === 127) return true;                                   // loopback
  if (ip === "0.0.0.0") return true;                               // wildcard
  if (o[0] === 192 && o[1] === 0 && o[2] === 2) return true;       // RFC 5737 TEST-NET-1
  if (o[0] === 198 && o[1] === 51 && o[2] === 100) return true;    // RFC 5737 TEST-NET-2
  if (o[0] === 203 && o[1] === 0 && o[2] === 113) return true;     // RFC 5737 TEST-NET-3
  return false;
};

/* A palette colour, not a host: exactly six or eight characters of hex. A real
 * name could hide here only by being drawn entirely from [0-9A-F] at exactly
 * that length; both names this repository leaked contain a letter outside the
 * hex alphabet, so neither could have passed. */
const isHexLiteral = (t) => /^[0-9A-F]{6}$/.test(t) || /^[0-9A-F]{8}$/.test(t);

/**
 * Every infrastructure-shaped token in `text` that no rule permits.
 * Pure over a string so the self-verification below can drive it directly.
 * @returns {{cls: string, token: string}[]}
 */
export function scan(text) {
  const found = [];

  for (const [tok] of text.matchAll(DOMAIN_RE)) {
    const lower = tok.toLowerCase();
    const tld = lower.split(".").at(-1);
    if (!TLDS.has(tld)) continue;                 // not domain-shaped after all
    if (RESERVED_TLDS.has(tld)) continue;
    if (RESERVED_DOMAINS.has(lower)) continue;
    if (ALLOWED_DOMAINS.has(lower)) continue;
    found.push({ cls: "domain", token: lower });
  }

  for (const [tok] of text.matchAll(IPV4_RE)) {
    if (isReservedIp(tok) || ALLOWED_IPS.has(tok)) continue;
    found.push({ cls: "ipv4", token: tok });
  }

  for (const [tok] of text.matchAll(DN_RE)) {
    // Prose runs on past the value; stop at a two-space run and shed trailing
    // punctuation, or "DC=local  full DN" reads as part of the name.
    const cut = tok.split(/ {2,}/)[0].trim().replace(/[\s.:;,-]+$/, "");
    const [key, ...rest] = cut.split("=");
    const value = rest.join("=").trim();
    if (!/^[a-z0-9][a-z0-9 _-]*$/i.test(value)) continue;   // empty or prose, not a DN
    const lower = `${key.toLowerCase()}=${value.toLowerCase()}`;
    if (ALLOWED_DNS.has(lower)) continue;
    found.push({ cls: "dn", token: lower });
  }

  for (const [raw] of text.matchAll(MACHINE_RE)) {
    const tok = raw.replace(/-+$/, "");   // a host name does not end in a hyphen
    if (isHexLiteral(tok) || ALLOWED_MACHINES.has(tok)) continue;
    found.push({ cls: "machine", token: tok });
  }

  for (const m of text.matchAll(USERPATH_RE)) {
    if (ALLOWED_USERS.has(m[1])) continue;
    found.push({ cls: "userpath", token: m[1] });
  }

  return found;
}

/** Tracked text files - git, so untracked scratch cannot fail the build. */
function corpus() {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, maxBuffer: 256 * 1024 * 1024 });
  return out.toString("utf8").split("\0").filter(Boolean)
    .filter((f) => !SKIP_FILE.has(path.basename(f)))
    .filter((f) => !SKIP_EXT.has(path.extname(f).toLowerCase()));
}

test("no tracked file carries an infrastructure token that is not on the allowlist", () => {
  const offenders = [];
  for (const rel of corpus()) {
    let text;
    try {
      text = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
    } catch {
      continue;   // vanished between ls-files and here
    }
    for (const { cls, token } of scan(text)) offenders.push(`${rel}: [${cls}] ${token}`);
  }
  assert.deepEqual(offenders, [],
    "Infrastructure-shaped tokens that no rule permits. If one is legitimate, add it to the "
    + "matching ALLOWED_* set in this file WITH A COMMENT saying what it is. Never widen a "
    + "regex to make this pass.\n" + offenders.join("\n"));
});

/*
 * The three checks below exist because a sweep that silently matches nothing
 * is indistinguishable from a clean repository. During the 2026-09-03 cleanup
 * two scans reported "clean" while broken - one had its commit arguments
 * swallowed as pathspecs, one was reading a pattern file that had been
 * deleted - and both produced empty output and no error.
 *
 * Fixture values are FABRICATED and assembled from fragments, so that no
 * complete infrastructure-shaped token appears literally in this file. Using
 * the real values would put them back into the repository this test exists to
 * protect, and this file would fail its own sweep above.
 */
test("the scanner flags a contaminated sample - one offender per class", () => {
  const contaminated = [
    `url: ldaps://${"acme-corp"}.com:636`,
    `resolves to ${"172.16"}.31.9 on this network`,
    `bind dn ${"DC="}acme`,
    `built on ${"WKSTN"}01234-XY`,
    `path C:\\Users\\${"someone"}\\AppData`,
  ].join("\n");

  const classes = scan(contaminated).map((o) => o.cls).sort();
  assert.deepEqual(classes, ["dn", "domain", "ipv4", "machine", "userpath"],
    "the scanner must flag exactly one token per class on a known-bad sample; "
    + "a class missing here means that pattern is dead and its half of the sweep is vacuous");
});

test("the scanner passes a sample built only from permitted values", () => {
  const clean = [
    "url: ldaps://dc01.example.local:636",
    "health probe on 127.0.0.1 and 192.0.2.11",
    "base dn DC=example,DC=local",
    "digest SHA256 on APPSRV1",
    "path C:\\Users\\<you>\\AppData",
  ].join("\n");

  assert.deepEqual(scan(clean), [],
    "the allowlist must accept the values the repository legitimately uses; "
    + "a hit here means a rule is too aggressive, not that the repository is dirty");
});

test("the corpus is not empty", () => {
  const files = corpus();
  assert.ok(files.length > 50,
    `git ls-files returned ${files.length} scannable files. Every assertion above is `
    + "vacuously true when the corpus is empty, which is exactly how a broken sweep "
    + "reports a clean repository.");
});
