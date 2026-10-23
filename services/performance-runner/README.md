# Ephemeral performance executor

`controller.py` exposes authenticated queue/status endpoints on a private host bridge address.
Chrome is never started by the controller itself. Every request starts a resource-limited temporary
container from the prebuilt runner image; it writes a sanitized result and exits. Docker removes the
container automatically. A controller restart recovers queued/running state and never starts a second
container for an already submitted UUID. Interrupted work remains a failure, not an automatic retry
that could select a better score.

Required service environment: `PERFORMANCE_TOKEN_FILE` (root-only file), `PERFORMANCE_DATA` (private
durable directory), `PERFORMANCE_BIND` (private bridge only), `PERFORMANCE_IMAGE` (pinned image ID),
`PERFORMANCE_ORIGINS` (environment-to-origin allowlist), `PERFORMANCE_PROFILES` (environment-to-private profile directory containing
`storage-state.json`). The API accepts profile names, never paths, Docker arguments
or shell commands. It rejects URLs containing credentials, query strings or fragments.

Build from repository root with the provided Dockerfile. The default pinned Playwright base supplies
Chromium 1194; an identical existing private evidence base may be selected with RUNNER_BASE to reuse
already available browser layers. Record the resulting immutable image ID at activation. There is no
registry/CI dependency while executing an already built image.

Launch the controller as a hardened systemd service with a private listener and access restricted to
the Paperclip host network. Store a separate controller token as a company Paperclip secret; do not
reuse a personal browser token. Put no credential values in the repository, process arguments or logs.
Use a separate synthetic login session for performance. Never share the canonical UX capture refresh
token family: rotation can invalidate parallel copies. `src/seed.mjs` creates a new verified session
using environment-bound synthetic credentials; provide them through a temporary private env file,
then remove that file. If single-session-per-user is enabled, use a separate synthetic account too.
The executor persists renewed cookies atomically to its own mounted profile before closing each
browser. Keep profile directories mode 700 and files mode 600. Staging/test need their own profiles;
missing profiles fail closed. No public CDP or reports server is opened.

Tests: service `pnpm test`; `python3 test/controller_spec.py`. Plugin tests validate complete cohorts,
auth/build/cache/version evidence and sanitized output. Verify an actual authenticated cohort, API
history, and absence of a running `journey.performance=true` container after completion before calling
the deployed pipeline proven.
