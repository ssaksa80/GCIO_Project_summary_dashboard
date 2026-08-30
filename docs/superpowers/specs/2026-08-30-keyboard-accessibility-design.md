# Keyboard accessibility: the drawer dialog and the reference table

**Date:** 2026-08-30
**Fixes:** Findings 5, 6, 7, 9 (drawer focus) and 10 (mouse-only table) in
`docs/accessibility-assessment.md`. Clears Finding 2 (`aria-allowed-role`) as a
side effect, because it is the same element.
**Out of scope:** Finding 1 (brand-palette contrast, a brand-owner decision) and
Findings 3/4 (no `<main>`, no landmark structure).

## Goal

A keyboard-only user can open a project, read it, and get back out; and can sort
and open projects from the all-projects reference table. Today neither is
possible: focus never enters the drawer, nothing keeps it there, and the table's
sort headers and rows are plain `<th>`/`<tr>` with click handlers.

## 1. The drawer becomes a real modal dialog

`client/src/components/ProjectDrawer.jsx`.

The drawer already behaves as a modal for mouse users - it has a backdrop that
dismisses it, and Escape closes it. It just does not behave as one for the
keyboard or for assistive technology. This makes the existing behaviour honest
rather than adding a new interaction.

- The host element changes from `<aside role="dialog">` to
  `<div role="dialog" aria-modal="true" aria-label="Project detail" tabIndex={-1}>`.
  `<aside>` is not permitted to carry `role="dialog"` (Finding 2), and
  `aria-modal` is what tells assistive technology the rest of the page is
  unavailable while it is open.

- **Initial focus goes to the dialog container**, not to the close button and
  not to the heading. The container is the only one of the three that exists at
  mount: the drawer renders a skeleton and its `<h2>` does not appear until
  `GET /api/projects/:id` resolves. Focusing the container also announces the
  dialog's own accessible name rather than "Close, button".

- **Focus trap.** A `keydown` handler on the dialog wraps Tab from the last
  focusable element to the first, and Shift+Tab from the first to the last. The
  focusable list is re-queried on each keypress rather than captured once,
  because the drawer's contents change twice: when the fetch resolves, and when
  `onNavigate` swaps to a different project inside the same mounted drawer.

- **Focus return on close.** The element that was focused at mount is saved and
  re-focused on unmount, guarded by `isConnected` - the trigger can legitimately
  be gone by then, for example if the table's filters changed underneath. This
  makes Finding 9 deliberate: focus return currently appears to work only
  because focus never moved in the first place.

- The backdrop takes `aria-hidden="true"`. It is a decorative duplicate of
  Escape and the close button, not a control in its own right.

Trapping focus is also what closes Finding 7 - the close button being 99 Tab
presses from its trigger. Once focus is trapped inside the dialog, its DOM
position stops mattering, so the drawer does not need to move in App.jsx.

**Rejected: the `inert` attribute on the rest of the app.** Cleaner in
principle, and it would remove the background from the accessibility tree
without `aria-modal`. But the drawer is rendered as a sibling *inside* App's
root `<div>`, so marking "everything else" inert needs either a portal or a
restructure of `App.jsx` - unrelated churn for the same user-visible outcome.

## 2. The table gets real controls

`client/src/components/ProjectTable.jsx`.

- **Sort headers.** Each `<th>` carries `aria-sort` (`ascending`, `descending`
  or `none`) and wraps its label in a real `<button type="button">`. A real
  button brings focusability and Enter/Space activation from the browser rather
  than hand-written key handling, and `aria-sort` is the attribute assistive
  technology actually announces for a sortable column.

- **Rows.** The project-name cell becomes a `<button>`. One focusable control
  per row, on the thing a user would naturally activate. The existing
  `<tr onClick>` stays so mouse behaviour is unchanged; the button calls
  `stopPropagation()` so a mouse click does not fire `onOpen` twice.

- **Rejected: `tabIndex={0}` + `role="button"` on the `<th>` and `<tr>`.** A
  `<tr role="button">` overrides the row's table semantics, so a screen reader
  stops reporting it as a row in a grid; and both elements would still need
  hand-written Enter/Space handlers that a `<button>` provides for free.

- **Cost.** Nine new header stops plus one per row. All of it lives inside the
  `<details className="all-projects">` element, which is closed by default and
  whose contents browsers skip for focus while closed - so the tab order of the
  dashboard proper does not change at all until a user opens the table.

## 3. Styling

Buttons inside `<th>`/`<td>` must inherit rather than look like buttons:
`background: none; border: 0; padding: 0; font: inherit; color: inherit;
text-align: inherit; cursor: pointer`. No visual change is intended. The app's
existing global `:focus-visible` rule supplies the focus ring, already measured
at 10.5-11.1:1 in the dark themes and 3.3:1 in platinum.

## 4. Testing

A new `UI_LIVE`-gated suite, `test/ui/keyboard.test.js`, driven by Puppeteer's
real key presses (`page.keyboard`) - the mechanism the assessment already
established as the only reliable one here. Each assertion is written to fail if
the corresponding fix is reverted, and is mutation-checked that way before the
work is called done:

1. Opening a drawer moves `document.activeElement` inside `[role="dialog"]`.
2. Tab from the last focusable element in the dialog wraps to the first.
3. Shift+Tab from the first wraps to the last.
4. Escape closes the drawer and returns focus to the trigger that opened it.
5. A sort header's button is reachable by Tab, and Enter changes both the
   `<th>`'s `aria-sort` and the order of the rows.
6. A row's name button is reachable by Tab, and Enter opens that project's
   drawer.

The existing `test/ui/accessibility.test.js` must stay green. Its drawer subtest
is expected to lose the `aria-allowed-role` violation, but the assessment
document will be updated from a re-measured run, not from this prediction.

## Success criteria

A keyboard-only user can open a project from the dashboard or the table, reach
its close button, leave, and land back where they started - and can sort the
reference table. Verified by the six tests above, each demonstrated to fail
against the unfixed code.
