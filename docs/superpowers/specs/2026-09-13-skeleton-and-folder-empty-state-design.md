# Skeleton Loading and Folder Empty State Design

## Goal

Replace page-level text spinners with content-shaped skeletons across 77Photo, and redesign the folder empty state so it feels intentional, useful, and consistent with the existing warm Korean Minimal interface.

## Scope

The change covers asynchronous page-content loading in:

- initial authenticated application restoration;
- the gallery's first page;
- folder listings;
- the initial public-share lookup;
- public-share photo loading.

Operation-specific feedback remains textual. This includes signing in, checking a share password, upload progress, mutations, error messages, and retry actions. Those messages explain an active operation and should not be replaced by a content placeholder.

## Visual Direction

**Visual thesis:** quiet, content-shaped placeholders and a small stack of warm photographic prints make waiting and emptiness feel native to a private family library.

Skeletons use the existing warm neutral palette, rounded geometry, and spacing of the content they stand in for. A low-contrast horizontal highlight supplies restrained movement. Under `prefers-reduced-motion: reduce`, skeletons remain static.

The selected empty-state direction is the photo-stack composition (visual option A). It reuses the visual language already established by the gallery's first-memory state instead of presenting a generic folder icon.

## Components

Create reusable presentational primitives in a focused loading-state module:

- `SkeletonBlock` renders one decorative placeholder and accepts shape-specific class names.
- `GallerySkeleton` mirrors a date heading and responsive photo grid.
- `FolderListSkeleton` mirrors the breadcrumb-adjacent folder rows.
- `PublicShareSkeleton` mirrors either the shared-item heading and photo grid or the initial shared-page content.
- `AppShellSkeleton` provides a branded but text-free initial application loading surface.

Skeleton markup is hidden from assistive technology. Each containing loading region uses `aria-busy="true"` and exposes a visually hidden localized status message so screen-reader users still receive meaningful feedback.

Create a `FolderEmptyState` inside the folder feature. It contains:

- a decorative three-print composition using the existing blush, sage, and sand palette;
- the heading “从这里开始整理” / “Start organizing here”;
- short utility copy explaining that the user can upload photos or create a folder;
- a primary “上传照片” / “Upload photos” action;
- a secondary “新建文件夹” / “New folder” action.

The illustration is CSS-only, decorative, and inaccessible to screen readers.

## Interaction and Data Flow

Loading state remains driven by the existing request state in each workspace. No API or server changes are required.

The folder empty-state upload action uses the application's existing file picker flow. After files are chosen, the app moves to the upload workspace with the selection intact. The new-folder action focuses the existing folder-name input rather than creating a second form or opening a dialog.

The folder workspace receives narrow callbacks for these actions from the app shell. It does not own routing or duplicate upload-picker logic.

Pagination at the bottom of an already populated gallery keeps a compact spinner because it represents incremental activity, not replacement content. Existing content must remain stable while another page loads.

## Responsive Behavior

Skeleton grids use the same breakpoints and column counts as their real galleries. Folder row skeletons preserve the real list width and density. The empty state stacks vertically on narrow screens, keeps both actions at least 44px high, and allows actions to wrap without horizontal overflow.

## Error Handling

Skeletons disappear when a request resolves or fails. Existing visible error copy, alert semantics, and retry actions remain available. Empty state appears only after a successful request returns no folders; it never masks request failure.

Public shares that are unavailable continue to use their explicit unavailable state. A public share with no photos keeps a read-only empty message and does not show upload or create-folder actions.

## Testing

Component tests verify that:

- each page-level loading branch renders the correct skeleton and its accessible busy/status semantics;
- resolved data removes the skeleton and renders content;
- errors render an alert rather than an empty state;
- the folder empty state renders both actions;
- the upload action invokes the shared upload-picker path;
- the new-folder action focuses the existing input;
- public empty shares remain read-only;
- localized English and Chinese copy stays covered by the i18n coverage test.

CSS and production builds are verified after the targeted tests. A browser check covers desktop and mobile layout, skeleton motion, reduced-motion behavior, and the empty-state action flow.

## Non-goals

- No API changes.
- No new loading library or animation dependency.
- No skeleton for button-level or mutation-level progress.
- No redesign of gallery empty state, error states, or public-share permissions.
