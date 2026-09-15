# Android E2E flows

These Maestro flows require an Android 12+ emulator or device and a running
77Photo server reachable from it. The server fixture used by the login and
upload flows must contain an administrator account, at least one writable
folder, and a media item named `photo-1.jpg`.

Run from `mobile/`:

```sh
maestro test e2e/maestro
```

`login-gallery.yaml` covers server setup, mobile login, gallery navigation and
the media viewer. `background-upload.yaml` covers the Photo Picker, folder
selection, notification actions and completion. `lan-http.yaml` is a policy
smoke test: a private IP displays the explicit unencrypted-LAN warning, while a
public HTTP address is rejected before credentials or media requests are made.

The flows assume the emulator locale is Simplified Chinese. Run the same
matrix with English locale before a release because labels are localized.
