# Plugin releases

Create an annotated tag matching `plugins-v*` after reviewing the source, versions, compatibility baseline, and generated package contents. The release workflow runs the same checks as CI, builds each plugin, creates one `.tgz` package per plugin, writes `SHA256SUMS`, and attaches those files to a GitHub release.

To make published releases immutable, enable **Settings → Releases → Enable release immutability** on the repository before publishing the first release. The workflow supplies all archives and the digest file when it creates the release; GitHub publishes them together. When immutability is enabled, GitHub locks the release assets and tag after publication and creates a release attestation. Repository administrators can also use GitHub's [REST API](https://docs.github.com/en/rest/repos/repos#enable-immutable-releases) with an `Administration: write` token to enable it (`PUT /repos/{owner}/{repo}/immutable-releases`); the `GITHUB_TOKEN` used by CI does not have that permission. See [GitHub's immutable release guide](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases).

The CI and release workflows install Gitleaks `8.18.4` from its official release archive and verify its pinned SHA-256 digest. Before scanning, the workflow creates a synthetic GitHub token at runtime and requires both exit code `1` and a JSON `github-pat` finding. It then scans all fetched Git history, a clean archive of tracked source, and each extracted package tarball with redacted output. This canary fails closed if the scanner stops detecting secrets.

The release workflow uses the repository-provided `GITHUB_TOKEN` with only `contents: write`. It does not publish to npm or deploy a Paperclip service. To install a release tarball, verify `SHA256SUMS`, extract its `package/` contents, then install the extracted directory using `paperclipai plugin install <absolute-path>` on a compatible host. See Artifact Library's [installation notes](../plugins/artifact-library/README.md).

Evolution packages include their migrations and require the Evolution host compatibility patch described in `docs/compatibility.md`.
