/**
 * Telling "the browser did not deliver an input" apart from "the app did the
 * wrong thing", for the UI suites.
 *
 * These are not the same failure and must not be reported the same way. Input
 * delivery to this application's pages in headless Chrome is measurably
 * unreliable: clicks that never land, keystrokes that never reach the field,
 * Tab presses that produce no focus change for seconds. It is the page's weight
 * rather than the browser - the same presses against a trivial page in the same
 * browser with the same flags are perfectly reliable - and it gets sharply
 * worse under machine load. On identical code, a full UI run measured 29 pass /
 * 0 fail on an unloaded run and 11 pass / 12 fail on a heavily loaded one, with
 * individual tests taking 210s against a normal 10-40s.
 *
 * What that load consisted of was never established, and an earlier version of
 * this comment attributed it to another project's test suite running at the
 * time. That attribution is withdrawn: a peer session later established that
 * stopping a background `npm run` does not kill the node tree underneath it, so
 * runs of THIS suite that had been stopped were probably still alive and
 * contributing. The load is real and the effect is real; the cause was assumed
 * rather than measured, and 35 node processes were counted at the time without
 * anyone checking whose they were.
 *
 * Left untreated, every one of those arrives as a bare 30-second selector
 * timeout naming some element, which reads exactly like a defect in whatever
 * feature the test was covering. That is expensive twice over: once when
 * someone investigates a defect that is not there, and again when the habit
 * sets in of re-running red tests until they go green, at which point a red
 * test has stopped meaning anything.
 *
 * So transport is retried and assertions never are. An AssertionError from a
 * test body propagates on the first attempt and stays failed. Only an
 * InputUnavailable - raised solely by the helpers here, and only when an input
 * demonstrably did not take effect - is retried. The suite therefore cannot
 * hide a regression; it can only decline to report the browser's own
 * unreliability as one.
 */
import { startDashboard } from "./harness.mjs";

/** The browser did not deliver an input. Never raised for an app misbehaving. */
export class InputUnavailable extends Error {}

/**
 * Click something only once the page has stopped moving underneath it.
 *
 * page.click() scrolls the target into view, computes its coordinates, then
 * dispatches a mouse event at them. On a long page those are three different
 * moments, and the scroll is itself what brings lower sections into view and
 * fires their IntersectionObserver reveals, which changes the heights above the
 * target. The element has moved by the time the event lands, and the click hits
 * whatever is now at those coordinates.
 *
 * This is not a hypothetical. Measured on this app three separate ways: a
 * project row whose drawer never opened because the click hit nothing at all;
 * and - the clearest one - clicking the reference table's search box, which
 * landed on the <summary> above it instead and CLOSED the disclosure, so the
 * subsequent typing had nowhere to go and reported an empty field.
 *
 * Scrolling first and waiting for the element's own box to stop moving removes
 * the race rather than making it less likely, which a fixed sleep would.
 */
export async function clickWhenStill(page, selector) {
  const handle = await page.waitForSelector(selector);
  await handle.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.evaluate(() => { delete window.__lastClickY; });
  try {
    await page.waitForFunction((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const y = el.getBoundingClientRect().y;
      const previous = window.__lastClickY;
      window.__lastClickY = y;
      return previous !== undefined && Math.abs(y - previous) < 0.5;
    }, { polling: "raf", timeout: 10_000 }, selector);
  } catch {
    /* A page that will not stop moving for ten seconds is the same class of
       problem as a dropped input, and belongs in the same bucket rather than
       surfacing as an opaque timeout naming a selector. */
    throw new InputUnavailable(`${selector} never stopped moving, so no click could be aimed`);
  }
  await handle.click();
}

/**
 * Run a scenario against a fresh dashboard, retrying only on InputUnavailable.
 *
 * Each attempt gets its own server and browser, because a half-driven page is
 * not a sound starting point for a retry - the drawer may be open, a filter may
 * be typed. Five attempts rather than three because three was measured to be
 * too few during a full `npm run test:ui`, where the later files run after
 * several minutes of other browsers starting and stopping.
 *
 * @param {(app: {page: object, baseUrl: string, close: () => Promise<void>}) => Promise<any>} run
 * @param {number} [attempts]
 */
export async function withDashboard(run, attempts = 5) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const app = await startDashboard();
    try {
      return await run(app);
    } catch (err) {
      if (!(err instanceof InputUnavailable)) throw err;
      last = err;
      console.log(`  (attempt ${attempt}/${attempts}: ${err.message} - retrying)`);
    } finally {
      await app.close();
    }
  }
  throw last;
}

/**
 * Click `selector` until `condition` holds, and never while it already holds.
 *
 * That last part is the whole point, and it is a lesson paid for: an earlier
 * drawer-open retry re-clicked whenever the dialog had not appeared within its
 * timeout. But "did not appear within six seconds" is not the same claim as "is
 * absent" - when the drawer had in fact opened just after that window, which is
 * exactly what a loaded machine produces, the second click landed on the modal
 * backdrop and closed it. The retry destroyed the state it was retrying for,
 * then reported that the drawer never opened. Checking the outcome before
 * acting removes that whole class of self-inflicted failure, for any control
 * whose second activation undoes the first - a modal backdrop, a <details>
 * disclosure, any toggle.
 *
 * @param {object} page
 * @param {string} selector element to click
 * @param {() => boolean} condition evaluated IN THE PAGE; the observable outcome
 * @param {{attempts?: number, timeout?: number, what?: string}} [options]
 * @throws {InputUnavailable} if the condition never holds
 */
export async function clickUntil(page, selector, condition, options = {}) {
  const { attempts = 3, timeout = 10_000, what = selector } = options;
  await page.waitForSelector(selector);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (await page.evaluate(condition)) return;
    await clickWhenStill(page, selector);
    const held = await page.waitForFunction(condition, { timeout })
      .then(() => true).catch(() => false);
    if (held) return;
  }
  /* One last look: the condition may have become true between the final wait
     timing out and this check, and reporting a failure that has since resolved
     is its own kind of wrong. */
  if (await page.evaluate(condition)) return;
  throw new InputUnavailable(`clicking ${what} never took effect`);
}

/**
 * Type into an empty field and confirm the characters actually arrived.
 *
 * page.type() resolves once the key events have been dispatched, not once the
 * field holds the text, so a lost keystroke leaves the field short and the only
 * symptom is that whatever the typing should have caused never happens - which
 * times out somewhere else and blames the feature rather than the keystroke.
 *
 * Single attempt, deliberately. On this machine, once keyboard delivery to a
 * page stops it does not come back, so a retry cannot succeed. Measured with
 * listeners attached directly to the field: the first characters arrive as
 * ordinary keydown/input events with isTrusted true and the app handles them
 * correctly, and then NOTHING arrives at all - no keydown, no input - while
 * document.activeElement still reports the field as focused. Blurring and
 * refocusing does not restore it, and neither does waiting. Retrying in that
 * state only turns one clear failure into three slow ones.
 *
 * Callers should keep typed strings short enough to finish before whatever the
 * field triggers on a debounce, since the delivery failure is much more likely
 * once the page has started doing work.
 *
 * @throws {InputUnavailable} if the field never holds `text`
 */
export async function typeUntil(page, selector, text, { timeout = 15_000 } = {}) {
  await page.waitForSelector(selector);
  const before = await page.$eval(selector, (el) => el.value);
  if (before !== "") {
    throw new InputUnavailable(
      `${selector} already holds "${before}" - this types into an empty field only`);
  }

  await page.focus(selector);
  await page.type(selector, text);

  const landed = await page.waitForFunction(
    (sel, want) => document.querySelector(sel)?.value === want,
    { timeout }, selector, text,
  ).then(() => true).catch(() => false);
  if (landed) return;

  const got = await page.$eval(selector, (el) => el.value).catch(() => "(gone)");
  throw new InputUnavailable(`typing into ${selector} never landed (field holds "${got}")`);
}
