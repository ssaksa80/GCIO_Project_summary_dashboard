/**
 * Checks the sign-in screen in both configurations. Proving the Microsoft
 * sign-in itself needs a real tenant, so this asserts what can be asserted
 * here: the button appears only when the server says SSO is on, password
 * sign-in keeps working either way, and MSAL is not downloaded until it is
 * needed.
 */
import puppeteer from "puppeteer-core";

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: "new",
  args: ["--no-sandbox", "--force-prefers-reduced-motion"],
});

async function check(label, expectButton) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 820 });
  const errors = [];
  const requests = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("request", (r) => requests.push(r.url()));

  await page.goto("http://localhost:8123/", { waitUntil: "networkidle2" });
  await page.waitForSelector(".signin");

  const hasButton = await page.$$eval("button", (els) =>
    els.some((e) => e.textContent.includes("Sign in with Microsoft")));
  const msalLoaded = requests.some((u) => /msal/i.test(u));

  console.log(`${label}: microsoft button ${hasButton ? "shown" : "absent"} ` +
    `(expected ${expectButton ? "shown" : "absent"}) · msal chunk fetched: ${msalLoaded}`);
  if (hasButton !== expectButton) throw new Error(`${label}: wrong button state`);
  if (msalLoaded) throw new Error(`${label}: MSAL was downloaded before anyone clicked`);

  /* Password sign-in must keep working in both configurations. */
  await page.type('input[autocomplete="username"]', "pat");
  await page.type('input[type="password"]', "x");
  await Promise.all([
    page.click('.signin button[type="submit"]'),
    page.waitForSelector(".sec-nav", { timeout: 20000 }),
  ]);
  console.log(`${label}: password sign-in still reaches the dashboard`);

  await page.screenshot({ path: `${process.env.SC}/signin-${label}.png` });
  if (errors.length) throw new Error(`${label}: page errors: ${errors.join(" ;; ")}`);
  await page.close();
}

await check(process.argv[2] || "unknown", process.argv[3] === "expect-button");
await browser.close();
