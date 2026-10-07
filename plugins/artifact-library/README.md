# Artifact Library

Artifact Library adds company-scoped folders, tags, favorites, and saved views for Paperclip artifacts. It organizes the existing Paperclip catalog; artifact IDs, files, task links, and content remain owned by Paperclip.

The plugin ID is `journeystudios.artifact-library`, and its database namespace is `plugin_artifact_library_ca55530627`. Both are stable identifiers required to preserve existing installations and data. Package version `0.1.2` includes the current cursor and company-boundary safeguards.

## Host compatibility

The Paperclip host must support the SDK v1 `artifacts.read` capability and `ctx.artifacts.list` worker API. The official SDK at upstream commit `8f8a0ab7effbd6a0584107d8038736c134ee5047` does not include that API. The public compatibility patch is in [`compat/paperclip-artifacts-read.patch`](../../compat/paperclip-artifacts-read.patch); it must be applied and the host shared package and Plugin SDK rebuilt before installing this plugin. The patch adds only the read capability, API contract, host service, and corresponding SDK/host tests. The public API stays flat; the SDK worker sends allowlisted filters both flat for legacy hosts and under `query` for newer hosts.

The root bootstrap script verifies the pinned public host source and applies the patch once. See the repository [compatibility guide](../../docs/compatibility.md) for host integration details.

Artifact Library `0.1.2` is compatible with the pinned Paperclip `2026.1001.0` source plus the compatibility patch described above. A stock host at that version lacks the required artifact API.

## Install a release archive

Download the Artifact Library `.tgz` asset and `SHA256SUMS` from a GitHub release, then verify and extract the archive:

```sh
sha256sum -c SHA256SUMS
mkdir artifact-library
tar -xzf journey-studios-paperclip-artifact-library-0.1.2.tgz -C artifact-library --strip-components=1
paperclipai plugin install "$(pwd)/artifact-library"
```

After the CLI reports a successful install, open **Settings → Instance → Plugins** to confirm the plugin status and open its settings. The Plugin Manager UI installs package names from the configured npm registry; this project distributes GitHub release tarballs, so install those archives through the CLI's local-path command.

## Package contents

The installable tarball contains `package.json`, `dist/`, `migrations/`, `README.md`, and `LICENSE`. It does not need runtime dependency installation. The worker bundles its dependencies; UI imports are provided by the host.

## Development

From the repository root, run `pnpm bootstrap:host`, `pnpm install`, then `pnpm --filter @journey-studios/paperclip-artifact-library typecheck`, `test`, and `build`. Database tests apply the real SQL migration and exercise worker actions against PGlite.
