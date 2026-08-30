# Accessibility Assessment

Run 26 August 2026, against the built client (`npm run build`) served by the
real server (`STORE=memory AUTH_MODE=dev`), driven by real Chrome via
`test/ui/accessibility.test.js` and, for the checks axe cannot do, by direct
interactive and Puppeteer-driven inspection of the same running app. This is
the first time this dashboard's accessibility has been measured. Nothing here
was inferred from reading the code alone unless the text says so explicitly.

**Do not treat this document as a fix list.** Per the phase plan, this task
assesses and does not remediate. Findings that would require changing a
mandated brand colour are marked as such and are explicitly not proposed as
bugs to patch.

## What was audited, and with what

| Surface | Tool | What it covers |
| --- | --- | --- |
| Sign-in page | axe-core 4.13, `npm test`'s `UI_LIVE=1` suite | automatable WCAG/best-practice checks |
| Dashboard (signed in, admin role, sample portfolio) | axe-core 4.13 | same |
| An open project drawer | axe-core 4.13, audited separately from the page behind it | same |
| All three surfaces, all four theme identities (obsidian, platinum, sapphire, emerald) | axe-core 4.13, ad hoc runs against the same harness | colour contrast only, cross-theme |
| Keyboard operation, focus management, focus-ring contrast, 200% zoom | Manual: Puppeteer's `page.keyboard`, computed-style inspection, and an interactive Chrome session | everything axe cannot see |

`test/ui/accessibility.test.js` fails serious/critical violations and only
records moderate/minor ones, per the plan. **The failure below is real** —
reproduced across three separate runs, all showing the same root cause.
Do not weaken the assertion, the threshold, or the blocking-impact filter
to make it pass.

Given a choice between failing the whole suite on a known, unresolved brand
question and quietly deleting the coverage, the decision made for Phase 4
was neither: the two subtests that fail on this finding — **"the dashboard"**
and **"an open project drawer"** — are marked `{ todo: "..." }` in
`test/ui/accessibility.test.js`, naming this finding and this document as the
reason. `todo` still runs axe against the real page on every invocation and
still prints the full violation report via `console.log` — nothing about what
is measured changed, only how `node --test` classifies a result it already
expected to be red. `npm run test:ui` exits 0 with these two `todo`, which is
what makes it usable as a gate again without the finding disappearing from
view. The third subtest, **"the sign-in page"**, passes today on its own
merits and is not marked `todo` — a future regression there must still fail
the run.

**If "the dashboard" or "an open project drawer" ever reports as `todo` but
passing** (`node --test` prints passing `todo` tests distinctly from failing
ones — watch for `# TODO` next to `ok`, not `not ok`), that means the
underlying colour was changed and this finding was fixed, not that the test
flaked. Treat it as a signal to remove the `todo` option from that subtest
in `test/ui/accessibility.test.js` and update this document, not as a result
to leave alone.

```
UI_LIVE=1 npm run test:ui         # runs it along with the other UI suites
UI_LIVE=1 node --test --test-concurrency=1 test/ui/accessibility.test.js
```

### A methodology note that belongs on the record

Two things had to be fixed in the *test* before it measured anything real,
and are documented in code comments in `test/ui/accessibility.test.js`:

1. The app's own CSP (`script-src 'self'`, `server/middleware/securityHeaders.js`)
   silently blocks the inline `<script>` tag that `page.addScriptTag({path})`
   (the plan's literal example) creates, so `window.axe` never attached and
   every audit threw. Fixed by evaluating axe's source directly via
   `page.evaluate(source)`, which runs through CDP rather than the page's own
   script loader and so isn't subject to that CSP — the same technique
   `@axe-core/puppeteer` uses. **The CSP itself was not touched and is not a
   finding**; a strict `script-src` is a working security control, not a defect.
2. The dashboard's entrance animation (`useReveal` in `client/src/lib/motion.jsx`,
   a GSAP opacity fade triggered by scroll) was still mid-fade when the first
   audit ran, and axe factors an element's live opacity into its computed
   colour — so the first attempt reported dozens of "colour-contrast" failures
   against transient, half-faded colours like `#203251` that appear in no
   stylesheet and that no user ever reads at rest. Fixed by emulating
   `prefers-reduced-motion: reduce` before each audit and reloading — the
   exact settled-state path `motion.jsx` already ships for that preference
   ("an executive screen must never withhold a number because a tween did not
   run") — then re-waiting for content. This is a measurement fix, not an
   app change: the animation's own end state is unaffected either way, only
   when the audit is allowed to see it.

Both are called out because an assessment that quietly worked around a broken
measurement, without saying so, would be indistinguishable from one that never
noticed the measurement was broken.

## Findings

### Serious — blocks the test, real and reproduced

**1. The "critical" status colour (Pantone 192 C) fails text contrast against every dark theme's surfaces.**

- **What:** `--critical` is defined as `var(--s192)` (`#e40046`) verbatim in
  the obsidian, sapphire, and emerald theme blocks (`client/src/themes.css`).
  It is used as small/bold text in `.chip.critical`, `.chip.solid.critical`,
  `.critical-ink`, and inline `style="color: var(--critical)"` values (e.g.
  the drawer's over-100%-budget figure) — all through the QRI, Priorities,
  Roadmap, Posture sections, the all-projects table, and the project drawer.
- **Where:** confirmed on the dashboard and inside an open drawer (axe run),
  and independently on the sign-in-adjacent obsidian/sapphire/emerald themes
  (ad hoc axe runs against each).
- **Measured:**
  | Theme | Text on | Ratio | Required |
  | --- | --- | --- | --- |
  | obsidian (default) | `--surface` `#001a3f` | **3.59:1** | 4.5:1 |
  | obsidian | `.chip.solid` mixed bg (~`#221640`) | **3.49:1** | 4.5:1 |
  | sapphire | `--surface` `#002566` | **3.01:1** | 4.5:1 |
  | sapphire | `.chip.solid` mixed bg (~`#221f61`) | **3.05:1** | 4.5:1 |
  | sapphire | large text (19px bold) | **2.58:1** | 3:1 (fails even the relaxed large-text bar) |
  | emerald | `--surface` `#1d221f` | **3.37:1** | 4.5:1 |
  | drawer (obsidian), 18px bold "over-budget" figure | `--surface-2` `#00265a` | **3.07:1** | 4.5:1 |
  | platinum (light) | derived `#c8003d` on white | 5.96:1 — **passes** | 4.5:1 |
- **Who it affects:** anyone with low vision reading status chips, risk
  severities, overdue dates, or budget overruns in obsidian (the default
  theme), sapphire, or emerald.
- **Conflicts with the brand palette: yes.** `--critical` is a direct alias
  to the mandated secondary hex in every dark identity. There is no way to
  reach 4.5:1 against these grounds/surfaces without either lightening the
  red past the literal Pantone 192 C approximation, or darkening the
  ground/surface tones derived from Pantone 281 C — both are brand-owner
  decisions, not an implementation bug. Platinum already sidesteps this by
  using its own derived, non-mandated red (`#c8003d`) instead of the literal
  hex, and that theme passes — which shows the fix exists, just not without
  moving off the fixed colour.
- **What fixing it would take** (informational, not a recommendation): either
  a lighter/desaturated stand-in for 192 C on dark surfaces (as platinum
  already does with its own reds), or restricting `--critical` text to sizes
  large enough to use the 3:1 large-text bar and pairing it with a
  non-colour cue (already partly true — chips carry text, not colour alone)
  — but even the large-text bar fails in sapphire (2.58:1), so size alone
  does not close this out. This is exactly the kind of trade a brand owner,
  not this task, should make.

### Minor / Moderate — recorded, not blocking

**2. `<aside role="dialog">` is not an allowed ARIA role for `<aside>`.**
**Fixed 2026-08-30** - the host element is now a `<div>` carrying
`role="dialog"` and `aria-modal="true"`. Confirmed by re-running the audit:
`aria-allowed-role` no longer appears in the drawer's violations, which went
from three to two.

`ProjectDrawer.jsx` renders `<aside class="drawer" role="dialog" aria-label="Project detail">`.
axe: `aria-allowed-role`, minor, on the drawer surface only. Does not conflict
with the brand palette — swapping the host element (e.g. a plain `<div>`) or
adjusting the role assignment is ordinary markup work.

**3. No `<main>` landmark.**
**Fixed 2026-08-30** - see the note below.
 `landmark-one-main`, moderate, on sign-in and the
dashboard. The whole document has no element with `role="main"`/`<main>`.
Does not conflict with the brand palette.

**4. Most page content sits outside any landmark region.**
**Fixed 2026-08-30** by the same change as #3 - see the note below.
 `region`,
moderate, on all three surfaces — the sign-in copy and fields, the page
header, the "no history" notice, the KPI strip, are all flagged as content
"not contained by landmarks." Does not conflict with the brand palette; this
and #3 are the same underlying gap (the app has no landmark structure at all
beyond the implicit `<body>`) and would likely be fixed together.

### Measured, not axe-flagged: near-misses worth recording

These did not fail the automated rule set on the surfaces actually audited
(platinum was only spot-checked, not run through the pass/fail gate), but the
margins are thin enough to write down while the numbers are in hand:

- Platinum's own `--warn` (`#b98600`, a value invented for that theme, not
  one of the nine raw brand custom properties) measures **2.77–3.24:1**
  against its white/`#f4edd9` surfaces — below 4.5:1.
- Platinum's `--muted` (`#6a7fa3`, likewise theme-specific) measures
  **3.73–4.05:1** — under 4.5:1 but closer.
- Platinum's `--accent` (`#00913a`, already darkened once from raw Pantone
  354 C for this exact reason) as white text: **4.1:1** — a near miss.

**None of these conflict with the brand palette.** All three are colours the
platinum theme's own author already invented or adjusted specifically to
read on a light background — none is the literal mandated Pantone-approximation
hex. Improving them further does not touch any of the nine fixed brand
constants (`--p281`, `--p354`, `--p375`, `--s638`, `--s2665`, `--s192`,
`--s1575`, `--s7408`, `--sgrey`). This is ordinary tuning work, not a brand
conversation.

### Manual checks (axe cannot see these)

**5. Opening a project drawer does not move keyboard focus into it.**
**Fixed 2026-08-30** - the dialog container takes focus on mount.

Confirmed directly: with the drawer open, `document.activeElement` is still
the `.pname` button that was clicked, not anything inside `[role="dialog"]`.
A screen-reader or keyboard-only user gets no signal that anything opened
except whatever they can see.

**6. No focus trap.**
**Fixed 2026-08-30** - Tab and Shift+Tab now wrap within the dialog.
 While the drawer is open, Tab continues to move focus
through the underlying page rather than staying inside the dialog — confirmed
directly: Tab from the trigger moved to the *next* project's `.pname` button
in the section behind the drawer, not into the drawer. Combined with #5: a
keyboard user can keep tabbing through, and activating, content that is
visually covered by the drawer's backdrop.

**7. The drawer is a long way from its own trigger in tab order.**
**Fixed 2026-08-30** by #6 - with focus trapped, the drawer's DOM position no
longer determines how far away its controls are, so it did not need to move.
 Measured
directly (DOM order, since nothing in the client sets a custom `tabindex`
except one unrelated control in `UploadPanel.jsx`): from the `.pname` button
that opens a drawer, its own close button is **99 Tab presses away** (element
21 of 125 focusable elements on the page vs. its close button at element 120)
— because `ProjectDrawer` mounts as the last thing in the DOM, after all five
report sections. A keyboard user who does not know to expect this would have
no practical way to find the drawer's own controls.

**8. Escape closes the drawer reliably.** Confirmed, repeatedly.
`ProjectDrawer.jsx` has its own `window`-level `keydown` listener for this,
independent of any native browser default action.

**9. "Focus return" is accidental, not deliberate.**
**Fixed 2026-08-30** - the element focused at mount is saved and restored on
close, guarded by `isConnected`. The exact regression predicted here did occur
while the work was in progress and was caught: see the note below.
 After Escape, focus is
back on the trigger button — but only because it never left in the first
place (see #5). If a future fix adds real focus-into-dialog behaviour without
also adding an explicit restore-on-close, this could regress silently with no
test currently in place to catch it.

**10. The "all projects" reference table is partly mouse-only.**
**Fixed 2026-08-30** - sort headers wrap their label in a real `<button>` and
carry `aria-sort`; each row's name cell is a `<button>`. The `<tr onClick>`
stays for mouse users.
 Its sortable
column headers (`<th onClick=...>`) and clickable rows (`<tr onClick=...>`,
opens a project — `client/src/components/ProjectTable.jsx`) are plain `<th>`/
`<tr>` elements: no `tabindex`, no `role="button"`, no `onKeyDown`. Confirmed
directly — neither appears in the page's set of focusable elements, and Tab
skips over both entirely. **Sorting the table, and opening a project record
from it, cannot be done from the keyboard at all.** Unrelated to colour or
brand — a plain missing keyboard affordance.

**11. The `<details>/<summary>` reference-table disclosure (Task 4's note) is
keyboard-operable.** Confirmed positively via Puppeteer's `page.keyboard`:
reachable by Tab, and **both** Enter and Space toggle it open and closed (a
full open→close→open cycle was exercised). It is unmodified native HTML with
no JS on top, so this is exactly the browser's own `<details>` behaviour.

**12. Focus ring is visible and passes contrast in every theme, measured.**
The app's one global rule is `:focus-visible { outline: 2px solid
var(--highlight); outline-offset: 2px; }`. Confirmed live on a real
keyboard-focused element (`:focus-visible` matched; computed outline was
solid 2px `rgb(151, 215, 0)`). Contrast against each theme's background
(WCAG 2.2's 3:1 minimum for non-text/focus indicators):

| Theme | Ratio |
| --- | --- |
| obsidian (default) | 11.11:1 |
| sapphire | 10.50:1 |
| emerald | 10.54:1 |
| platinum | 3.29–3.56:1 |

All four clear 3:1. Platinum's margin is real but thin — about 10% above the
floor, using a darker derived shade (`#63960a`) of the highlight colour for
its light ground. No finding here; recorded because it was measured, and
because "it currently passes with little margin" is worth knowing.

**13. Sign-in Enter-to-submit works.** Confirmed via Puppeteer: type a
username, Tab to password, type a password, press Enter — the form submits
and lands on the dashboard, same as clicking the button. (My first attempt at
this used the interactive browser tool available in this session and
appeared to fail; that turned out to be a limitation of that tool, not the
app — see the methodology note below. Flagging it here so a false negative
doesn't quietly become a "known issue.")

**14. 200% zoom holds.** Approximated the standard way — halving the test
harness's own viewport, 1600×1000 → 800×500, which produces the same
available CSS-pixel layout budget as zooming a 1600-wide window to 200%.
Measured, not eyeballed:
- No page-level horizontal scrollbar (`document.documentElement.scrollWidth
  === clientWidth`).
- The top bar's existing `flex-wrap` lets its controls wrap onto more lines
  instead of clipping; nothing measured was off-screen or zero-width.
- The two-column section grids collapse to one column under 1000px (an
  existing `@media` rule) — confirmed the grid actually rendered as a single
  741px-wide track, not two columns.
- The all-projects table needs its own horizontal scroll (940px of content
  in a 654px box) — but that scroll is contained to the table's own
  `.table-wrap { overflow-x: auto }`, not the page. This is the WCAG 1.4.10
  Reflow carve-out for two-dimensional tabular data, not a violation of it.
- A project drawer opened at this width still renders fully on-screen
  (620×500 of an 800×500 viewport) with its close button fully visible and
  in-bounds.

### The landmark findings, fixed (2026-08-30)

Findings 3 and 4 were one omission, not two. The app was not short of landmarks
in general - `TopBar` already renders `<header>` (banner), `SectionNav` already
renders `<nav aria-label="Report sections">`, and `ProjectTable` already renders
a named `<section>`. It had no `main`. That is what `landmark-one-main` reported
directly, and it is why `region` reported the page head, the KPI strip, the
"no history" line and everything else sitting loose in `.shell`.

The dashboard now has a `<main>` between the top bar and the modals, and the
sign-in screen's wrapper is a `<main>` rather than a `<div>`. The dashboard's
`<main>` is a **sibling** of the header, never a parent: `<header>` maps to the
banner role only while it is not nested inside `<main>`, so wrapping the whole
shell would have fixed one finding by destroying a landmark the app already had.
The drawer and upload panel stay outside it - they are fixed-position modals
with their own `role="dialog"`, not the page's main content.

**Measured result, and better than expected.** The open-drawer surface was left
as a measurement rather than a prediction, since a dialog is not a landmark and
it was not obvious whether its `region` violation would clear. It did:

| Surface | Before | After |
| --- | --- | --- |
| sign-in | 2 violations | **0** |
| dashboard | 3 violations | 1 |
| open drawer | 3 violations (2 after the drawer fix) | 1 |

Every remaining axe violation on this application is now Finding 1, the
brand-palette contrast failure - the one finding that is a brand-owner decision
rather than implementation work.

Both rules are *moderate*, so the audit's blocking assertions could never see
them, which is also why nothing would have noticed the fix being removed later.
`test/ui/accessibility.test.js` now asserts that `landmark-one-main` and
`region` are absent from the full violation list on each surface. Run against
the unfixed code first, all three surfaces failed; mutation-checked afterwards
by turning each `<main>` back into a `<div>`, which fails exactly the surfaces
that element serves and no others.

### The keyboard findings, fixed and now regression-tested (2026-08-30)

Findings 2, 5, 6, 7, 9 and 10 are fixed. `test/ui/keyboard.test.js` covers them
with six assertions driven by real key presses; before the fix, five of the six
failed, each naming the defect it was written for - focus left on the trigger,
Tab escaping to `<body>`, and Shift+Tab landing on the reference table's
`<summary>` *behind the backdrop*, which is Finding 6 caught in the act.

The sixth, Escape-returns-focus, **passed against the broken code** - because
focus had never left the trigger, exactly as Finding 9 said. A test that passes
whether or not the feature exists is worth nothing, so it now asserts that focus
is inside the dialog and moves within it before Escape is pressed. Each fix was
then mutation-checked: removing the trap fails both wrap tests, removing the
focus restore fails the Escape test, and marking either the header or the row
button `tabIndex={-1}` fails its own reachability test and nothing else.

**One caveat worth recording.** Input delivery to this page in headless Chrome
is unreliable - clicks that do not open a `<details>`, Tab presses that produce
no focus change for seconds, selectors that never resolve. It is the page's
weight rather than the browser: the same presses against a trivial page in the
same browser with the same flags are perfectly reliable, and neither
`Emulation.setFocusEmulationEnabled` nor forcing reduced motion changed it.
Left alone it failed a different test on roughly half of all runs, which would
have made the suite worthless. The suite therefore distinguishes "the browser
did not deliver an input" from "the app did the wrong thing" and retries only
the first; an assertion failure is never retried, so a real regression still
fails on the first attempt. Eight consecutive runs pass with that in place, two
of them having silently retried once.

### A tooling limitation, not an app finding

The interactive browser-automation tool available in this session can move
focus (Tab) and dispatch `Escape` correctly, but its synthetic Enter and
Space key presses did not trigger **any** native default action in this
Chrome instance — confirmed on three unrelated controls (the sign-in submit
button, a plain toolbar `<button>`, and the `<details>` summary), all of
which activate correctly when driven by Puppeteer's `page.keyboard.press()`
instead (the same mechanism `test/ui/harness.mjs` already relies on). Findings
#11 and #13 above were re-verified through Puppeteer specifically because of
this; everything else that depended on real key-activation was checked the
same way. This is recorded so a reader doesn't mistake "the interactive tool
couldn't do X" for "the app can't do X" — they are not the same claim, and
only the second one belongs in an accessibility assessment.

### A test that was not measuring what it claimed (found 2026-08-30)

Re-running this suite surfaced a defect in the suite, not the app: **the "an
open project drawer" subtest had stopped auditing the drawer entirely, and the
run still reported green.**

Two independent mistakes had to line up:

1. `settle()` reloads the page, which returns the scroll position to the top.
   `page.click()` then scrolls the target into view, computes its coordinates
   and dispatches a mouse event at them — but that scroll is itself what first
   brings the lower sections into view, firing their IntersectionObserver
   reveals and changing the heights of everything above the target. The element
   had moved before the event landed, so the click hit nothing. Confirmed
   directly rather than inferred: no `[role="dialog"]` ever entered the DOM and
   no `GET /api/projects/:id` was ever sent — the drawer was not loading
   slowly, it never opened. The target measured `y=3705` in a 1000px-tall
   viewport at click time, with `document.elementFromPoint` at its centre
   returning nothing.

2. The subtest carried node:test's `todo` marker, added for Finding 1 (the
   brand-palette contrast failure). `todo` tolerates *any* failure, so the
   resulting 30-second `TimeoutError` was reported as an expected known issue.
   Nothing in the output distinguished "the known contrast finding" from "this
   test no longer runs."

Both are fixed. The click now waits for the element's own box to stop moving
before dispatching (`clickWhenStill`), and the known finding is carried as an
expected *value* (`KNOWN_BLOCKING = ["color-contrast"]`) rather than a blanket
`todo`, so any other failure — a new violation, a harness break, a timeout —
fails the run. Both fixes were mutation-checked: reverting the click makes the
drawer subtest fail with the timeout it had been hiding, and emptying
`KNOWN_BLOCKING` makes the dashboard and drawer subtests fail on the assertion.

With the drawer genuinely audited by the automated pass for the first time, its
result matches what the manual assessment above already recorded:
`aria-allowed-role` (minor, #2), `color-contrast` (serious, #1) and `region`
(moderate, #4). No new finding — but that agreement is now measured on every
run instead of asserted once.

## Findings that conflict with the brand palette

Only one does: **Finding 1**, the `--critical` (Pantone 192 C) text-contrast
failure against every dark theme's surfaces. It is a direct, verbatim use of
a mandated secondary colour, and no fix keeps that literal hex while reaching
4.5:1 on any of the dark grounds derived from Pantone 281 C. This is a
decision for whoever owns the brand palette, not a defect for this task to
patch.

Every other finding in this document was ordinary implementation work that did
not touch any of the nine fixed brand hexes, and **all of it is now fixed**: the
missing `<main>` landmark and the ungrouped page regions (#3, #4), the drawer's
role, focus and keyboard behaviour (#2, #5, #6, #7, #9), and the table's missing
keyboard affordances (#10). What remains is the near-miss platinum-only colours
recorded above as measurements rather than findings, and Finding 1 itself.

## What this assessment did NOT cover

- **No real screen reader.** Nothing here was verified by listening to NVDA,
  JAWS, or VoiceOver actually announce the page. Every claim about roles,
  names, and focus is inferred from the DOM/ARIA tree and axe's static
  analysis — real assistive technology can and does surface problems (reading
  order, verbosity, redundant announcements) that neither of those will show.
- **No users with disabilities.** Every judgment here is a sighted,
  non-disabled engineer's proxy for someone else's experience of the product.
- **The exported documents were not touched.** PPTX, XLSX, DOCX, and the
  self-contained HTML brief are all produced by this app and are all
  documents a screen-reader user might read — none of them was assessed here.
  This was a web-page audit only, per this task's scope.
- **Coverage is partial by construction.** axe-core's own documentation
  states it automates roughly a third to a half of WCAG success criteria;
  passing it is evidence of the absence of specific automatable defects, not
  proof of WCAG conformance.
- **One role, one dataset, two viewport sizes.** Everything was audited as
  the `admin` role (the harness default) against the bundled in-memory demo
  portfolio, at 1600×1000 and, for the zoom check only, 800×500. Other roles,
  a live SQL-backed dataset, edge-case data (zero risks, zero updates, a
  project with no history), and other breakpoints were not swept.
