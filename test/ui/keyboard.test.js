/**
 * Keyboard operability of the project drawer and the reference table.
 *
 * Covers Findings 5, 6, 7, 9 and 10 in docs/accessibility-assessment.md - the
 * ones axe cannot see. axe checks markup; none of these are markup questions.
 * "Does Tab wrap inside the dialog" and "does Enter on a column header sort the
 * table" can only be answered by pressing the keys, so this suite does exactly
 * that, through Puppeteer's page.keyboard - the mechanism the assessment
 * already established as the only one that triggers real default actions here.
 *
 * Self-skips unless UI_LIVE=1, exactly like the other UI suites:
 *
 *     UI_LIVE=1 node --test test/ui/keyboard.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startDashboard } from "./harness.mjs";

const ui = process.env.UI_LIVE === "1";

/* The same set a browser itself treats as tabbable, minus the programmatic
   -1 entries. The dialog container carries tabIndex={-1} so that it can take
   initial focus without ever entering the tab order; it is excluded here for
   that reason, and the tests below depend on that exclusion. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Describe whatever currently has focus, in a form worth reading in a diff. */
function describeActive(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return "(body)";
    return `${el.tagName.toLowerCase()}.${String(el.className || "").trim()}` +
      `[${(el.textContent || "").trim().slice(0, 30)}]`;
  });
}

/**
 * Raised when the browser did not deliver an input, as distinct from the
 * application doing the wrong thing with one.
 *
 * These are not the same failure and must not be treated the same way. Every
 * spurious failure this suite produced while it was being written was of this
 * kind - a click that did not open a <details>, a Tab press that produced no
 * focus change for four seconds, a selector that never appeared - and never
 * once an assertion that was wrong about the app. Measured on the app's own
 * page; the identical presses against a trivial page in the same browser, with
 * the same flags, are perfectly reliable, so this is the page's weight (130
 * focusable elements, per-section IntersectionObserver reveals, an open
 * EventSource), not the fix under test.
 */
class InputUnavailable extends Error {}

/**
 * Run a keyboard scenario against a fresh dashboard, retrying ONLY when the
 * browser failed to deliver an input.
 *
 * An AssertionError is never retried - if the app gets focus wrong, that fails
 * on the first attempt and stays failed, which is the whole point. Retrying
 * only InputUnavailable means the suite cannot hide a regression; it can only
 * decline to report the browser's own unreliability as one.
 */
async function withDashboard(run, attempts = 3) {
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
 * Put focus on `selector` and do not continue until it is actually there.
 *
 * Focus delivery in this headless browser is not reliable enough to assume:
 * measured directly, Tab does nothing at all from <body>, a real click on an
 * <input> does not always focus it, and a click on a <summary> does not always
 * open it. Every one of those produced a failure that looked like an
 * application bug somewhere further along the test.
 *
 * Using .focus() here is a starting point, not a claim. What each test proves
 * is what happens when Tab is pressed FROM here - which is the part that was
 * broken and is what a keyboard user experiences.
 */
async function seedFocus(page, selector) {
  await page.waitForSelector(selector);
  try {
    await page.waitForFunction((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      if (document.activeElement !== el) el.focus();
      return document.activeElement === el;
    }, { polling: 100, timeout: 5000 }, selector);
  } catch {
    throw new InputUnavailable(`focus would not land on ${selector}`);
  }
}

/**
 * Press Tab (or Shift+Tab) and wait until focus has actually moved.
 *
 * page.keyboard.press resolves when the input events have been dispatched, not
 * when the renderer has applied the resulting focus change. Reading
 * document.activeElement straight afterwards therefore returns the OLD element
 * often enough to matter, which is what made every tab-walking test in this
 * file intermittent. Marking the current element and waiting for focus to land
 * somewhere without that mark turns each press into a step that has either
 * happened or timed out, with nothing in between to misread.
 */
async function tabStep(page, { shift = false } = {}) {
  await page.evaluate(() => {
    document.querySelectorAll("[data-kb-from]").forEach((e) => e.removeAttribute("data-kb-from"));
    const el = document.activeElement;
    if (el && el !== document.body) el.setAttribute("data-kb-from", "1");
  });
  if (shift) await page.keyboard.down("Shift");
  await page.keyboard.press("Tab");
  if (shift) await page.keyboard.up("Shift");
  const moved = () => page.waitForFunction(() => {
    const el = document.activeElement;
    return !!el && el !== document.body && !el.hasAttribute("data-kb-from");
  }, { polling: "raf", timeout: 4000 });

  /* One retry. A press that produced no focus change within four seconds was
     dropped, not merely slow; sending it again is safe because the first one
     demonstrably did nothing. A second failure is a real stall and is allowed
     to throw. */
  try {
    await moved();
  } catch {
    if (shift) await page.keyboard.down("Shift");
    await page.keyboard.press("Tab");
    if (shift) await page.keyboard.up("Shift");
    try {
      await moved();
    } catch {
      throw new InputUnavailable(`${shift ? "Shift+Tab" : "Tab"} produced no focus change`);
    }
  }
}

/**
 * Press Tab until the focused element matches `selector`.
 * @returns {Promise<number>} presses needed, or -1 if never reached.
 */
async function tabUntil(page, selector, max = 40) {
  for (let i = 1; i <= max; i++) {
    await tabStep(page);
    if (await page.evaluate((sel) => !!document.activeElement?.matches(sel), selector)) return i;
  }
  return -1;
}

/**
 * Wait until the set of focusable controls inside `root` stops changing.
 *
 * The drawer keeps settling after its heading appears: the export buttons take
 * a `disabled` attribute while a download is in flight, and the tree renders as
 * its data arrives. A test that reads "the last focusable element" while that
 * is still happening can focus an element that is no longer last a moment
 * later, and then Tab moves normally instead of wrapping - which looks exactly
 * like a broken focus trap. Seen intermittently before this was added: focus
 * landed on the drawer's HTML-export button rather than wrapping to the close
 * button.
 *
 * @returns {Promise<number>} how many focusable controls settled.
 */
async function stableFocusables(page, root, sel) {
  await page.waitForFunction((r, s) => {
    const el = document.querySelector(r);
    if (!el) return false;
    const items = el.querySelectorAll(s);
    const signature = `${items.length}|${items[0]?.className}|${items[items.length - 1]?.className}`;
    const settled = window.__focusSig === signature;
    window.__focusSig = signature;
    return settled;
  }, { polling: 120, timeout: 10_000 }, root, sel);
  return page.evaluate((r, s) => document.querySelector(r).querySelectorAll(s).length, root, sel);
}

/** Open a project drawer from the Priorities section and wait for its content. */
async function openDrawer(page) {
  await page.waitForSelector("[data-section='priorities'] .pname");
  const trigger = await page.$eval("[data-section='priorities'] .pname",
    (el) => (el.textContent || "").trim());

  /* Two different failures hide behind "the drawer never appeared", and only
     one of them is worth retrying.

     The dialog wrapper mounts synchronously on click, before its fetch to
     /api/projects/:id resolves. So no wrapper means the CLICK did not land -
     retry it, which is safe precisely because no backdrop exists yet to
     swallow the second one. A wrapper with no <h2> means the click did land
     and the fetch is slow or broken; clicking again would hit the backdrop and
     close the drawer, so that case waits, then gives up. */
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.click("[data-section='priorities'] .pname");
    const mounted = await page.waitForSelector("[role='dialog']", { timeout: 6000 })
      .then(() => true).catch(() => false);
    if (!mounted) continue;
    const loaded = await page.waitForSelector("[role='dialog'] h2", { timeout: 20_000 })
      .then(() => true).catch(() => false);
    if (loaded) return trigger;
    throw new InputUnavailable("the drawer mounted but never loaded its project");
  }
  throw new InputUnavailable("the project drawer would not open");
}

test("a keyboard user can open a project, work in it, and get back", { skip: !ui }, async (t) => {
  await t.test("opening a drawer moves focus into it", async () => {
    await withDashboard(async (app) => {
      await openDrawer(app.page);
      const inside = await app.page.evaluate(
        () => !!document.activeElement?.closest("[role='dialog']"));
      assert.ok(inside,
        `focus stayed outside the dialog - it is on ${await describeActive(app.page)}`);
    });
  });

  await t.test("Tab wraps at the end of the dialog instead of escaping behind it", async () => {
    await withDashboard(async (app) => {
      await openDrawer(app.page);

      /* Guard against a vacuous pass: with a single focusable element, "the
         last wraps to the first" is trivially true because they are the same
         element. A loaded drawer has a close button plus its export and tree
         controls. */
      const count = await stableFocusables(app.page, "[role='dialog']", FOCUSABLE);
      assert.ok(count >= 2, `expected several focusable controls in the drawer, found ${count}`);

      await app.page.evaluate((sel) => {
        const items = document.querySelectorAll(`[role='dialog']`)[0].querySelectorAll(sel);
        items[items.length - 1].focus();
      }, FOCUSABLE);
      await tabStep(app.page);

      const onFirst = await app.page.evaluate((sel) => {
        const dialog = document.querySelector("[role='dialog']");
        if (!dialog) return false;
        return document.activeElement === dialog.querySelectorAll(sel)[0];
      }, FOCUSABLE);
      assert.ok(onFirst,
        `Tab from the last control left the dialog - focus is on ${await describeActive(app.page)}`);
    });
  });

  await t.test("Shift+Tab wraps backwards at the start of the dialog", async () => {
    await withDashboard(async (app) => {
      await openDrawer(app.page);
      await stableFocusables(app.page, "[role='dialog']", FOCUSABLE);
      await app.page.evaluate((sel) => {
        document.querySelector("[role='dialog']").querySelectorAll(sel)[0].focus();
      }, FOCUSABLE);
      await tabStep(app.page, { shift: true });

      const onLast = await app.page.evaluate((sel) => {
        const dialog = document.querySelector("[role='dialog']");
        if (!dialog) return false;
        const items = dialog.querySelectorAll(sel);
        return document.activeElement === items[items.length - 1];
      }, FOCUSABLE);
      assert.ok(onLast,
        `Shift+Tab from the first control left the dialog - focus is on ${await describeActive(app.page)}`);
    });
  });

  await t.test("Escape closes the drawer and hands focus back to what opened it", async () => {
    await withDashboard(async (app) => {
      const trigger = await openDrawer(app.page);

      /* Focus has to have genuinely moved away first, or this proves nothing.
         Before the fix this test passed against the broken code: focus
         "returned" to the trigger only because it had never left it - Finding 9,
         "focus return is accidental, not deliberate". Asserting the drawer has
         focus and then moving within it makes the assertion below a real one. */
      const insideBefore = await app.page.evaluate(
        () => !!document.activeElement?.closest("[role='dialog']"));
      assert.ok(insideBefore,
        `focus was never in the dialog, so its return would prove nothing - it is on ${await describeActive(app.page)}`);
      await tabStep(app.page);
      const movedWithin = await app.page.evaluate(
        () => !!document.activeElement?.closest("[role='dialog']"));
      assert.ok(movedWithin, "Tab moved focus out of the dialog before Escape was pressed");

      await app.page.keyboard.press("Escape");
      await app.page.waitForFunction(() => !document.querySelector("[role='dialog']"));

      const back = await app.page.evaluate(() => {
        const el = document.activeElement;
        return {
          isTrigger: !!el?.classList.contains("pname"),
          text: (el?.textContent || "").trim(),
        };
      });
      assert.ok(back.isTrigger,
        `focus did not return to the trigger - it is on ${await describeActive(app.page)}`);
      assert.equal(back.text, trigger, "focus returned to the wrong project's trigger");
    });
  });
});

test("a keyboard user can sort and open projects from the reference table", { skip: !ui }, async (t) => {
  /* While the <details> is closed, browsers skip everything inside it for
     focus, so it has to be open before any claim about tab order inside it
     means anything. */
  /*
    Open the reference table the way a user does, by clicking its <summary>.

    Not by navigating to ?table, which App.jsx also supports. A page.goto leaves
    the document without keyboard focus in this headless browser, and - measured
    directly - a subsequent real click on an <input> does not restore it either:
    activeElement stays on <body> and every Tab press after that does nothing, so
    a tab walk silently stalls and reports reachable controls as unreachable.
    The harness's own sign-in click is what gives the page focus in the first
    place, and a navigation throws that away.

    Clicking the summary keeps that focus, opens the <details>, and leaves focus
    on the element immediately before the table in tab order - so the walk below
    is short, deterministic, and exactly what a keyboard user would experience.
    Measured order from there: 3 filter selects, the search box, the 9 column
    headers, then one button per row.

    The wait is for td.cell-name rather than ".projects tbody tr", because the
    "No projects match the current filters" placeholder is also a tbody tr and
    would satisfy that selector before any data arrived. td.cell-name is used
    rather than the button inside it so this stays a valid wait against the
    unfixed markup too.
  */
  const openTable = async (app) => {
    await app.page.waitForSelector("details.all-projects > summary");

    /* Verify the click actually opened it, and retry if not.
       ProjectTable renders inside the <details> whether it is open or closed -
       a closed <details> hides its children, it does not unmount them - so
       waiting for a row cell says nothing about whether the disclosure opened.
       Without this check a click that did not land (which happens on a busy
       machine) let the test proceed against a closed table, where nothing
       inside is focusable, and the failure surfaced much later as "the tab stop
       after the last column header is not a project". */
    for (let attempt = 1; attempt <= 3; attempt++) {
      await app.page.click("details.all-projects > summary");
      const opened = await app.page
        .waitForFunction(() => document.querySelector("details.all-projects")?.open === true,
          { timeout: 3000 })
        .then(() => true).catch(() => false);
      if (opened) break;
      if (attempt === 3) throw new InputUnavailable("the all-projects disclosure would not open");
    }

    await app.page.waitForSelector(".projects tbody td.cell-name", { timeout: 20_000 })
      .catch(() => { throw new InputUnavailable("the reference table never rendered a project row"); });
    /* Seed on the search box, the last control before the table proper.
       Seeding on the <summary> instead means the walk crosses three native
       <select> filters, and Tab out of a <select> is where focus delivery in
       this headless browser was measured to stall outright - a 5s tabStep
       timeout in three of six runs. Nothing about the selects is under test
       here; starting after them removes a failure mode that has nothing to do
       with the claim. */
    await seedFocus(app.page, "details.all-projects input[type='search']");
    /* The live-events connection bumps refreshTick, which makes ProjectTable
       refetch and replace every row. Let the row set settle before walking it,
       for the same reason the drawer's focusables are settled above. */
    await stableFocusables(app.page, ".projects tbody", "tr");
  };

  /** Everything worth knowing when a tab walk through the table comes up empty. */
  const tableState = (app) => app.page.evaluate(() => {
    const el = document.activeElement;
    return JSON.stringify({
      detailsOpen: document.querySelector("details.all-projects")?.open ?? null,
      headerButtons: document.querySelectorAll(".projects thead th button").length,
      rowButtons: document.querySelectorAll(".projects tbody .cell-name button").length,
      focus: !el || el === document.body ? "(body)" : el.tagName.toLowerCase() + "." + String(el.className || "").trim(),
    });
  });

  await t.test("a column header is reachable by Tab and Enter sorts by it", async () => {
    await withDashboard(async (app) => {
      await openTable(app);

      const before = await app.page.$eval(".projects tbody td.cell-name",
        (el) => (el.textContent || "").trim());
      const presses = await tabUntil(app.page, ".projects thead th button", 4);
      assert.ok(presses > 0, `${presses === -2 ? "focus stopped advancing before" : "Tab never reached"} a column header - ${await tableState(app)}`);

      const field = await app.page.evaluate(() =>
        document.activeElement.closest("th").getAttribute("data-field"));
      const sortBefore = await app.page.$eval(`.projects thead th[data-field='${field}']`,
        (el) => el.getAttribute("aria-sort"));

      await app.page.keyboard.press("Enter");
      await app.page.waitForFunction(
        (f, was) => document.querySelector(`.projects thead th[data-field='${f}']`)
          ?.getAttribute("aria-sort") !== was,
        { timeout: 15_000 }, field, sortBefore)
        .catch(() => { throw new InputUnavailable("Enter on the column header produced no sort change"); });

      const sortAfter = await app.page.$eval(`.projects thead th[data-field='${field}']`,
        (el) => el.getAttribute("aria-sort"));
      assert.notEqual(sortAfter, sortBefore,
        `aria-sort did not change on ${field} (still ${sortAfter})`);
      assert.ok(["ascending", "descending"].includes(sortAfter),
        `aria-sort should name a direction, got ${sortAfter}`);

      /* The attribute changing is not the point - the data has to move. */
      await app.page.waitForFunction((was) =>
        document.querySelector(".projects tbody td.cell-name")?.textContent.trim() !== was,
      { timeout: 10_000 }, before).catch(() => {});
      const after = await app.page.$eval(".projects tbody td.cell-name",
        (el) => (el.textContent || "").trim());
      assert.notEqual(after, before, `the row order did not change when sorting by ${field}`);
    });
  });

  await t.test("the tab stop after the last column header is a project, and Enter opens it", async () => {
    await withDashboard(async (app) => {
      await openTable(app);

      /*
        One keypress, not a walk.

        The claim worth proving here is the tab-order BOUNDARY: that after the
        column headers, the next thing a keyboard user reaches is a project -
        which is exactly what was false before (Finding 10: rows were plain
        <tr onClick> and Tab skipped the whole table body). Walking all the way
        from the summary would need ~14 presses to assert the same one fact, and
        every extra press is another chance for the headless input race in
        tabUntil to spoil the result on a loaded machine.

        Focusing the last header directly is not a weaker claim: that the headers
        themselves are Tab-reachable is proven by a real walk in the subtest
        above. This starts where that one leaves off.
      */
      await app.page.evaluate(() => {
        const headers = document.querySelectorAll(".projects thead th button");
        headers[headers.length - 1].focus();
      });
      await tabStep(app.page);

      const landed = await app.page.evaluate(() => {
        const el = document.activeElement;
        return {
          isRowButton: !!el?.matches(".projects tbody .cell-name button"),
          name: (el?.textContent || "").trim().split(/\s*\n\s*/)[0].trim(),
        };
      });
      assert.ok(landed.isRowButton,
        `the tab stop after the last column header is not a project - focus is on ${await describeActive(app.page)}, ${await tableState(app)}`);

      await app.page.keyboard.press("Enter");
      await app.page.waitForSelector("[role='dialog'] h2");
      const heading = await app.page.$eval("[role='dialog'] h2", (el) => el.textContent.trim());
      assert.equal(heading, landed.name,
        "Enter on a row opened a different project than the one that was focused");
    });
  });
});
