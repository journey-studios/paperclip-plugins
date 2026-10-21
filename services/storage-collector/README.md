# VPS Status Collector (read-only)

A standalone VPS-side collector for [VPS Status](../../plugins/storage-manager/README.md). It reads an **operator-controlled allowlist** of directories with `du -x -s -B1`, the root filesystem with `df -B1`, Docker storage accounting with `docker system df --format '{{json .}}'`, CPU usage and load from `node:os`, and memory/swap from `/proc/meminfo`. It never invokes prune, rm, shell evaluation, Docker mutation, or cleanup commands.

## Install (operator runbook; NOT performed by CI)

1. Inspect `df -h /`, `docker ps`, `docker system df`, filesystem mount layout, rollback images and current backup. The collector supports Node.js >=22.14; check that `/usr/bin/node` resolves to the required binary. Plugin package builds in the monorepo still require Node 24.
2. Copy **only this collector's `src/`** to the root-owned directory `/opt/paperclip-storage-collector/src/`. Keep this outside the Paperclip container/image so it survives Paperclip updates. Never overwrite the custom `paperclip:agy` runtime to install this service.
3. Create `/var/lib/paperclip-storage-manager` as root-owned mode 0755. The collector atomically writes `snapshot.json` mode 0644. Do not place credentials, logs, backups, or arbitrary files in this folder.
4. Copy `systemd/paperclip-storage-collector.{service,timer}` to `/etc/systemd/system/`. If you need alerts, create optional root-owned `/etc/paperclip-storage-manager.env` with `STORAGE_WARN_FREE_BYTES=<integer>` and `STORAGE_CRITICAL_FREE_BYTES=<integer>`. **Neither threshold defaults to an assumed value.**
5. Run `systemctl daemon-reload`, `systemctl start paperclip-storage-collector.service`; validate JSON, `stat`, `journalctl -u paperclip-storage-collector.service`, and compare `df` / `docker system df`. Then `systemctl enable --now paperclip-storage-collector.timer` for ten-minute collections.
6. Add a read-only bind mount to the existing **application** service in the current Compose configuration (service name must be verified first):

   ```yaml
   services:
     <existing-paperclip-app-service>:
       volumes:
         - /var/lib/paperclip-storage-manager:/run/paperclip-storage:ro
   ```

   Merge this entry with existing volumes. Validate `docker compose config` before any recreation; preserve existing runtime image, adapter, mounts and env. **No host root, Docker socket, /var/lib/docker, or /var/lib/containerd is mounted.**
7. Install the packaged Storage Manager plugin and configure its declared **storage-snapshot** local folder via native Paperclip Plugin Settings to `/run/paperclip-storage` for the intended company, read-only. Validate `/storage`, native tool calls and company isolation. Unconfigured state is an expected first-run result.

## Choosing the directories

Without configuration the collector measures a generic set (`/var/lib/docker`, `/var/lib/containerd`, `/var/log`, `/home`, `/root`, `/opt`, `/srv`, `/var/www`); paths that do not exist are reported as missing. To measure your own layout, create a **root-owned** JSON file and point `VPS_STATUS_DIRECTORIES_FILE` at it in the env file:

```json
[
  { "id": "app-data", "label": "Dados da aplicação", "path": "/srv/data" },
  { "id": "backups", "label": "Backups", "path": "/srv/backups" }
]
```

Rules, enforced at startup (the collector refuses to run on a violation): 1 to 30 entries; `id` is lowercase letters, digits and hyphens, unique; `label` is at most 70 characters and must not contain `/` (labels are shown in the UI); `path` is absolute, normalized (no `..`, `//` or trailing `/`) and not `/` itself. The file is an operator allowlist, never user input: the collector refuses to start unless it is a regular file owned by root and not group- or world-writable.

### Hosts that keep data under `/srv`

[`systemd/srv-directories.json`](systemd/srv-directories.json) is a ready allowlist for a host where Paperclip data lives in bind mounts under `/srv` (`/srv/data/paperclip_data`, `/srv/data/repos`, `/srv/backups`, `/srv/build`). [`systemd/srv-layout.conf`](systemd/srv-layout.conf) is the matching systemd drop-in: it points `VPS_STATUS_DIRECTORIES_FILE` at that file, writes the snapshot to `/srv/data/storage-manager` (already mounted read-only into the app as `/run/paperclip-storage`, so Compose is unchanged) and uses a Node under `/opt/node`. It also clears the base unit's `ReadWritePaths`, which otherwise fails with `226/NAMESPACE` when `/var/lib/paperclip-storage-manager` does not exist.

## Workers (optional)

To show the runner containers that execute agents, point `VPS_STATUS_WORKERS_FILE` at a **root-owned** JSON allowlist (same ownership rules as the directories file; nothing is discovered automatically):

```json
[
  { "id": "runner-base", "label": "Runner base", "container": "runner-base" },
  { "id": "runner-browser", "label": "Runner browser", "container": "runner-browser" }
]
```

1 to 12 entries; `id` is lowercase letters, digits and hyphens; `container` is a plain Docker container name (no `/` or leading `-`); `label` follows the directory label rules. For each entry the collector runs only `docker inspect` (state, health, start time, restart count, OOM flag) and one `docker stats --no-stream` for the running ones, always passing names after `--`. A container that does not exist is reported as `missing`, and a failed probe as `unknown` with a `workers` coverage issue. CPU is per container: 100% is one core. Without the file the `workers` list is empty and the page hides the section.

## Worktrees (optional)

To measure each git worktree on its own, point `VPS_STATUS_WORKTREES_FILE` at a **root-owned** JSON list of *roots*, directories whose immediate subfolders are worktrees (same ownership rules and entry format as the directories file, at most 6 roots):

```json
[
  { "id": "tessel", "label": "Tessel", "path": "/srv/data/paperclip_data/instances/default/projects/<company>/<project>/tesselapp/.paperclip/worktrees" }
]
```

For each root the collector lists the direct children, ignores files and symlinks, skips names outside `[A-Za-z0-9._-]` (reported as an `invalid_name` coverage issue), keeps the 40 most recently modified (`truncated` otherwise) and runs `du -x -s -B1` on each, under a shared two-minute budget (`deadline_exceeded` marks the rest unavailable). The snapshot's `worktrees` list carries the name, size and last-modified time. Sizes are per worktree: files shared by hardlink (such as a pnpm store) count in every worktree, so the sum can exceed real disk use. The unit's `TimeoutStartSec` is 600 s to leave room for the scans.

### Real size (hardlinks)

`du` per tree overstates disk use when trees share files by hardlink (a pnpm store linked into every checkout and worktree). Add entries with `"kind": "shared"` to the same file to put those trees in the accounting too (at most 6 of each kind):

```json
[
  { "id": "tessel", "label": "Tessel", "path": "…/tesselapp/.paperclip/worktrees" },
  { "id": "pnpm-store", "label": "pnpm store", "path": "/srv/data/paperclip_data/.local/share/pnpm/store", "kind": "shared" },
  { "id": "checkout", "label": "Checkout principal", "path": "…/tesselapp", "kind": "shared" }
]
```

One read-only pass (`lstat` and `readdir`, no shell, no symlinks followed, no mount point crossed) counts every inode once and reports, per worktree and per shared tree: `apparentBytes` (what `du` shows), `exclusiveBytes` (what deleting it frees: files no other measured tree links) and `sharedBytes` (the difference). Worktree roots and other measured trees are never entered twice, so a checkout that contains the worktree root is measured without it. Files with links outside the measured trees are never counted as exclusive. `spaceAttribution` adds the totals: real `physicalBytes`, summed `apparentBytes`, `savedByHardlinksBytes`, `sharedBetweenBytes` and `externallyLinkedBytes`. The walk costs about as much as the `du` scans, so the last result is reused for `VPS_STATUS_ATTRIBUTION_MAX_AGE_MINUTES` minutes (default 60, `0` always walks); a walk over its 150 s budget or a failure keeps the `du` sizes and reports a `deadline_exceeded` or `failed` coverage issue instead of a partial number.

## Snapshot schema 2

Adds an optional `workers` list (see above) and `cpu` (`cores`, `usagePercent`, `load1/5/15`), `memory` (`totalBytes`, `availableBytes`, `usedBytes`, `usedPercent`, `swapTotalBytes`, `swapUsedBytes`) and `uptimeSeconds`. A failed CPU or memory probe leaves that field `null` and adds a `cpu`/`memory` `read_failed` coverage issue; disk metrics are unaffected. History entries gain optional `cpuPercent` and `memoryUsedBytes`. The plugin still reads schema 1.

## Operating boundaries

- Read-only monitoring is the only shipped capability. No automatic cleanup or retention changes.
- Host collector executes as root only to read protected directories and the Docker socket through the read-only Docker CLI command. The plugin gets **only the generated JSON**; the collector's command list and paths are hardcoded.
- The systemd unit uses a restricted write path, no-new-privileges, private tmp and no TCP networking. Review any systemd changes against the host's Docker socket and filesystem.
- Errors from optional Docker/du probes make the snapshot *partial*, not fabricated; a df failure preserves the prior snapshot.
- Snapshot history is limited to 1008 samples; do not consider it a durable metrics database.
- Reported Docker sizes are approximate, shared across layers, and cannot be summed with physical directory sizes.
- Protect active Chrome/Tessel UX, paperclip:agy, runtime rollbacks, database volumes, active worktrees and backups. Never automate deletion from a size ranking.

## Rollback

Disable the timer: `systemctl disable --now paperclip-storage-collector.timer`. Remove the read-only Compose mount after verifying the current config, remove the plugin in Paperclip if needed, and retain the snapshot directory for audit or archive. No core migration or production data mutation is required.
