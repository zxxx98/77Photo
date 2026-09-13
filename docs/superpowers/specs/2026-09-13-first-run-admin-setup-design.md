# First-run Administrator Setup Design

## Goal

Provide a browser-based first-run experience that lets the first user create a custom administrator account without calling a hidden API manually.

## User Experience

When 77Photo has no users, opening the application automatically shows a dedicated administrator setup page. The page reuses the existing login screen's warm, two-column Korean Minimal composition so the first-run flow feels like part of the product rather than an infrastructure screen.

The setup form contains:

- a custom administrator username;
- a password;
- password confirmation;
- visible guidance that passwords require at least 12 characters;
- a note that initialization is available only once.

The primary action is “Create administrator” / “创建管理员”. Successful setup creates the authenticated session and takes the user directly into the gallery. There is no separate sign-in step.

**Visual thesis:** the familiar calm family-library atmosphere stays fixed while the right panel changes from “welcome back” to a clear, secure first step.

**Content plan:** brand atmosphere, first-run heading and explanation, three-field setup form, one primary action, one concise security note.

**Interaction thesis:** the form enters with the same restrained page presence as login; validation feedback appears next to the affected flow; the submit button provides clear operation-level progress without decorative motion.

## Setup Detection API

Add an unauthenticated read-only endpoint:

```http
GET /api/v1/setup/status
200 OK
Cache-Control: no-store

{"required":true}
```

The endpoint reveals only whether setup is required. It does not expose user counts, usernames, roles, or account metadata. The service determines the result from whether the users table is empty.

The existing `POST /api/v1/setup/admin` remains the only setup write endpoint and retains its transaction-protected one-time behavior.

## Application State Flow

Extend the session state model with a `setup` status.

On application restore:

1. Request the current authenticated user.
2. If a valid session exists, enter `authenticated`.
3. If the session request is unauthorized, request setup status.
4. If setup is required, enter `setup`; otherwise enter `unauthenticated`.
5. If setup-status detection itself fails, fall back to `unauthenticated` so an existing installation is never locked out of its login screen.

The frontend API client adds `setupStatus()` and `setupAdmin(username, password)` methods. `SessionStore.setupAdmin` stores the returned CSRF token and authenticated user exactly as login does.

## Validation and Races

The browser validates before submission:

- trimmed username must be non-empty;
- password must contain at least 12 characters;
- confirmation must match the password.

The server remains authoritative for its existing 1–64 byte username and 12–256 byte password policy. Server errors are shown with localized, non-sensitive copy.

If another client completes setup between status detection and form submission, the server returns `409 SETUP_COMPLETE`. The client refreshes session/setup state and moves to the normal login page instead of leaving a dead setup form visible.

Credentials are never persisted in local storage, logs, URLs, or component state after successful setup.

## Responsive and Accessibility Behavior

The setup page shares the login page's desktop, tablet, and mobile layout rules. Form controls keep visible labels, browser autocomplete hints (`username`, `new-password`), required semantics, and at least 44px targets. Errors use `role="alert"`; submit progress remains textual. Focus starts on the username field.

## Testing

Backend tests verify setup status before and after administrator creation, the endpoint response shape, no-store behavior, and method restrictions.

Frontend tests verify:

- API client request paths and setup payload;
- session restore transitions to `setup` only when there is no current session and setup is required;
- successful setup stores the returned user and CSRF token;
- the setup page renders localized fields and password guidance;
- mismatched or short passwords do not call the API;
- successful submission enters the authenticated application;
- a setup race returning `409` transitions to login;
- existing installations continue to show login;
- English and Chinese translation coverage.

The complete Web suite, Go suite, typecheck, production build, and embedded static bundle are verified before merge.

## Non-goals

- Open user registration.
- Creating additional administrators after initialization.
- Password recovery or reset.
- Multi-step onboarding, storage configuration, or sample library creation.
- Changing the existing server-side credential policy.
