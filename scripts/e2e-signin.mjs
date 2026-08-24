import puppeteer from "puppeteer-core";

const OUT = process.env.SC;
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: "new",
  args: ["--no-sandbox", "--force-prefers-reduced-motion"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

await page.goto("http://localhost:8123/", { waitUntil: "networkidle2" });
await page.waitForSelector(".signin input");
console.log("sign-in screen shown");

await page.type('input[autocomplete="username"]', "pat");
await page.type('input[type="password"]', "whatever");
await Promise.all([
  page.click(".signin-submit"),
  page.waitForSelector(".sec-nav", { timeout: 20000 }),
]);
console.log("dashboard rendered after sign-in");

const who = await page.$eval(".who", (el) => el.textContent.trim());
console.log("identity chip:", who);

const uploadVisible = await page.$$eval(".btn", (els) => els.some((e) => e.textContent.includes("Upload")));
console.log("upload button visible for pm:", uploadVisible);

const sections = await page.$$eval(".sec-title", (els) => els.map((e) => e.textContent.trim()));
console.log("sections:", sections.join(" | "));

await page.screenshot({ path: `${OUT}/e2e_dashboard.png` });

/* Wait on the response, not just the repaint: clicking and immediately
   polling for the sign-in card races React's re-render. */
const loggedOut = page.waitForResponse((r) => r.url().includes("/api/auth/logout"));
await page.click(".who-out");
console.log("sign-out response:", (await loggedOut).status());
await page.waitForFunction(() => Boolean(document.querySelector(".signin")), { timeout: 20000 });
console.log("sign-out returned to the sign-in screen");

console.log("page errors:", errors.length ? errors.join(" ;; ") : "none");
await browser.close();
