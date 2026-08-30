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
 * worse when something else heavy is running on the machine (a full UI run
 * measured 29 pass / 0 fail on a quiet box and 11 pass / 12 fail alongside
 * another project's database suite, with individual tests taking 210s against a
 * normal 10-40s, on identical code).
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
 * Type into a field and confirm the characters actually arrived.
 *
 * page.type() resolves once the key events have been dispatched, not once the
 * field holds the text. A dropped keystroke leaves the field short or empty,
 * and the only symptom is that whatever the typing was supposed to cause never
 * happens - which then times out somewhere else entirely, blaming the feature
 * rather than the keystroke. Verified directly on this app: an input's .value
 * stayed empty after a completed page.type().
 *
 * The field is cleared before each attempt so a partially delivered first try
 * cannot concatenate into the second - but it must be cleared the way React
 * accepts. Assigning `el.value` directly desynchronises React's internal value
 * tracker, after which it can revert the DOM on its next render and swallow
 * everything typed afterwards. That is not theoretical: the first version of
 * this helper did exactly that and reported "typing never landed (field holds
 * "")" on every run - the helper causing the failure it was written to
 * diagnose. Going through the prototype's own value setter and then dispatching
 * `input` is the form React recognises.
 *
 * @throws {InputUnavailable} if the field never holds `text`
 */
export async function typeUntil(page, selector, text, { attempts = 3 } = {}) {
  await page.waitForSelector(selector);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await page.$eval(selector, (el) => {
      if (el.value === "") return;
      const setValue = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, "value").set;
      setValue.call(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    /* focus(), not click(). Clicking to place the cursor is what a person does,
       but page.click() aims at coordinates and can land on whatever has moved
       into them - here it hit the <summary> above the search box and closed the
       disclosure, after which nothing could be typed anywhere. Focus needs no
       coordinates, and what this helper is verifying is that the characters
       arrive, not that a click can reach the field. */
    await page.focus(selector);
    await page.type(selector, text);
    const landed = await page.waitForFunction(
      (sel, want) => document.querySelector(sel)?.value === want,
      { timeout: 5000 }, selector, text,
    ).then(() => true).catch(() => false);
    if (landed) return;
  }
  const got = await page.$eval(selector, (el) => el.value).catch(() => "(gone)");
  throw new InputUnavailable(`typing into ${selector} never landed (field holds "${got}")`);
}
