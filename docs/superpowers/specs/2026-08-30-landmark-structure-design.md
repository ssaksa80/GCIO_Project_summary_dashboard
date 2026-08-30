# Landmark structure: a `<main>` for the dashboard and the sign-in page

**Date:** 2026-08-30
**Fixes:** Findings 3 (`landmark-one-main`) and 4 (`region`) in
`docs/accessibility-assessment.md`. Both are moderate; both appear on every
audited surface.
**Out of scope:** Finding 1 (brand-palette contrast, a brand-owner decision).

## What is actually missing

The app is not short of landmarks in general. It already has:

- `banner` - `TopBar` renders `<header className="topbar">`
- `navigation` - `SectionNav` renders `<nav aria-label="Report sections">`
- `region` - `ProjectTable` renders `<section aria-label="Project portfolio">`

It has no `main`. That single omission produces both findings: it is what
`landmark-one-main` reports directly, and it is why `region` reports the page
head, the "no history" line, the KPI strip and everything else that sits loose
in `.shell` as content outside any landmark.

The five report sections render `<section className="sec">` with no accessible
name. A `<section>` without one is not a landmark, so their contents are inside
no landmark either - naming them is a real improvement, but it is a wider change
than these two findings need and is deliberately not made here.

## The change

**Dashboard (`client/src/App.jsx`).** A `<main>` wrapping everything between
`<TopBar>` and the modals.

It must be a *sibling* of the header, never a parent: `<header>` maps to the
banner role only when it is not nested inside `<main>`, `<article>` or
`<section>`, so wrapping the whole shell would fix one finding by destroying an
existing landmark.

`ProjectDrawer` and `UploadPanel` stay outside it. They are fixed-position
modals carrying their own `role="dialog"`, and they are not the page's main
content.

**Sign-in (`client/src/components/SignIn.jsx`).** `<div className="signin-wrap">`
becomes `<main className="signin-wrap">`. The class is unchanged, so the layout
is unchanged.

**Loading state (`App.jsx`, the `me === null` early return).** Its bare skeleton
gets a `<main>` as well. It is a rendered page like any other and would report
the same violation if anyone audited it.

**Layout risk is near zero, and this is checkable rather than hoped for.**
`.shell` is a plain block - `max-width`, `margin: 0 auto`, `padding` - with no
flex or grid, so an extra block-level wrapper does not change how its children
flow. `.signin-wrap` is `display: grid; place-items: center`, and it keeps that
class verbatim on the new element.

## Testing

Both rules are **moderate**, and `test/ui/accessibility.test.js` only asserts on
serious and critical violations. Neither finding has ever been able to fail the
suite, which is also why nothing would notice if this fix were later removed.

So the audit gains an explicit absence check: `landmark-one-main` and `region`
must not appear in the FULL violation list - not just the blocking subset - on
each audited surface. Moderate violations stay recorded rather than blocking in
general; these two are named because they are now fixed and regressions should
be loud.

Order of work, so the assertions are known to be capable of failing:

1. Add the absence assertions and run them against the unfixed code. Expect
   failures on every surface that currently reports either rule.
2. Make the change.
3. Re-run; expect the failures to clear.
4. Mutation-check by turning the `<main>` back into a `<div>` and confirming the
   assertions fail again.

The drawer surface is deliberately left as a measurement rather than a
prediction. A dialog is not a landmark, so whether an open drawer still reports
`region` is not something to assert in advance - the result will be measured and
`docs/accessibility-assessment.md` updated to whatever is actually true.

## Success criteria

`landmark-one-main` and `region` are absent from the sign-in and dashboard
audits, each surface has exactly one `main`, the banner and navigation landmarks
still exist, and no visual regression appears in the existing UI suite.
