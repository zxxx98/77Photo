# Browser acceptance checks

The repository keeps browser checks lightweight so the production bundle has
no test-only dependency. Run the Web build, serve the resulting bundle with
the Go service, and exercise the following viewports in browser DevTools:

- 375 × 812: login, gallery scroll, viewer close, upload and bottom navigation;
- 768 × 1024: folders, sharing and settings;
- 1440 × 900: sidebar navigation, gallery pagination and viewer keyboard focus.

Confirm that the first gallery request uses the 256px thumbnail, the preview
request is made only after opening a photo, and the original endpoint is only
requested after choosing Download. After logout, no cached API or media
response may appear for the next account. Keep screenshots and network traces
for a release under `artifacts/e2e/` (ignored by Git).
