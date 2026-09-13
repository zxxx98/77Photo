# 77Photo Brand Mark Design

## Decision

Use the **Quiet Frame** mark selected by the user from the three SVG previews.
It replaces the current text-only `77` badge throughout the product shell while
keeping the existing `77Photo` wordmark and localized tagline unchanged.

Preview reference: `.design-previews/logo-quiet-frame.svg`.

## Visual thesis

A quiet, editorial photography mark: two warm-white geometric sevens sit inside
a deep slate rounded frame, with one small sage dot acting as a captured-memory
accent. It should feel intentional at small sizes without reading as a button or
generic app icon.

## Scope and placement

- Add one reusable code-native `BrandMark` component for the mark geometry.
- Replace every product-facing text-only `77` mark in the authenticated shell,
  loading screen, login page, mobile login header, and public share page.
- Preserve the existing wordmark, tagline, spacing relationships, and language
  behavior.
- Keep the mark decorative when paired with visible brand text by using
  `aria-hidden="true"`.
- Keep the mark self-contained as inline SVG so it scales crisply and does not
  add an asset request.

## Visual system

- Slate tile: `#3d4a5c`.
- Warm-white sevens: `#faf9f7`.
- Sage memory dot: `#a8c5b8`.
- Rounded tile and stroke geometry must remain consistent across all placements.
- The existing responsive shell should determine the mark size; no new layout
  containers or decorative shadows are needed.

## Interaction and accessibility

The mark has no independent interaction or animation. Hover, focus, and active
states belong to the surrounding navigation or brand link, if any. The SVG is
decorative beside the visible `77Photo` label and must not create duplicate
screen-reader output.

## Verification

- Add a focused render test that confirms the reusable mark exposes the SVG and
  its key geometry without rendering the old literal `77` badge.
- Run the complete frontend test suite, typecheck, and production build.
- Refresh the embedded Go web assets after the final frontend build.
- Run the Go test suite, `go vet ./...`, and `git diff --check`.
