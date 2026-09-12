# 77Photo Web UI Design Reference

This document defines the initial visual direction for the 77Photo Web client.

## Design direction

77Photo should feel like a calm, private family memory space rather than an enterprise admin dashboard. The selected direction is **Korean Minimal**: warm, restrained, photography-first, and comfortable for long browsing sessions.

The product structure remains functional and information-dense where needed, but the visual layer should use generous whitespace, soft neutrals, subtle pastel accents, delicate borders, and large rounded corners.

## Reference screen

![77Photo Korean Minimal Web UI](./77photo-web-korean-minimal.jpg)

The reference screen demonstrates the intended desktop gallery layout:

- persistent left navigation for Gallery, Folders, Timeline, Sharing, Favorites, Trash, albums, storage status, and account settings;
- top search and upload actions;
- date-grouped photo timeline/gallery in the primary content area;
- photo/video/favorite filters plus grid/list and sort controls;
- responsive image grid optimized for visual browsing;
- optional right-side detail inspector for metadata and file operations;
- family-oriented albums such as baby growth, family life, travel, food, and pets;
- metadata and actions remain secondary to the photo itself.

## Visual principles

1. **Photos are the strongest visual element.** Chrome should not compete with content.
2. **Warm white over sterile white.** Use the Korean Minimal warm-white foundation.
3. **Slate-blue typography.** Avoid hard black where a softer high-contrast slate works.
4. **Pastel accents are semantic, not decorative noise.** Blush pink, sage green, and sand should be used sparingly.
5. **Whitespace is structural.** Avoid dense dashboard styling and unnecessary separators.
6. **Rounded, delicate surfaces.** Prefer `rounded-2xl` / `rounded-3xl`, thin borders, and subtle shadows.
7. **No heavy visual effects.** Avoid neon colors, thick borders, dark themes, glassmorphism, and aggressive gradients.
8. **Responsive by default.** Desktop may show the details inspector; tablet and mobile should collapse it into a sheet or detail page.

## Responsive behavior

### Desktop

- Left navigation remains visible.
- Main gallery consumes most of the viewport.
- The photo details inspector may remain pinned on the right when a photo is selected.
- Grid density can scale with available width.

### Tablet

- Left navigation can collapse to icons or a drawer.
- Details inspector becomes an overlay or slide-over panel.
- Gallery remains the dominant surface.

### Mobile

- Use bottom navigation for the highest-frequency destinations.
- Search and upload remain easy to reach.
- The gallery uses a 2–3 column adaptive grid depending on viewport width.
- Photo metadata and actions move to a dedicated details screen / bottom sheet.
- Touch targets should remain at least 44px high/wide.

## Implementation guidance

The Web client should implement the design as reusable tokens and primitives instead of page-specific one-off CSS. Keep color, radius, spacing, typography, border, shadow, and motion tokens centralized.

The complete UI generation / implementation prompt is stored in [`UI_PROMPT.md`](./UI_PROMPT.md). Treat its forbidden and required rules as the source of truth when generating new Web UI.

## Scope note

This image is a **visual reference**, not a pixel-perfect specification. Product architecture and V1 feature scope remain defined by `docs/PRODUCT_DESIGN.md`. When implementation constraints conflict with this visual reference, preserve usability, accessibility, responsiveness, and the lightweight product goals first.
