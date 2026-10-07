# Contributing

Use Node.js 24.11 or newer and pnpm 10.7.0. Start with `pnpm bootstrap:host`; this checks out the public Paperclip source at the pinned commit under the ignored `.paperclip/` directory and applies the public compatibility patch. Then run `pnpm install --frozen-lockfile` and `pnpm check`.

Each plugin owns its source, tests, migration, README, and package manifest under `plugins/<name>/`. The root workspace owns dependency resolution and common scripts. Keep plugin tarballs self-contained with generated `dist/` output and migrations. Do not add a private host checkout, deployment configuration, credentials, production data, or runtime logs to this repository.

Changes to Paperclip compatibility should update the compatibility patch and compatibility guide together. Before changing its pinned commit, verify the patch applies cleanly, rebuild the shared package and SDK, and run the affected plugin checks.
