# Android acceptance flows

These flows use a running 77Photo fixture server reachable as `photo.test` from
the Android emulator. Start the server and seed `admin` with the test password
before running `maestro test e2e/maestro`.

The LAN flow uses the emulator's test network. It verifies that HTTP is offered
only for an IP in the configured private ranges and is rejected for a public IP.
The background flow also requires an Android 13+ emulator with notification
permission granted; repeat it once with permission denied to verify the in-app
limitation message.
