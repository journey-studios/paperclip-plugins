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

Rules, enforced at startup (the collector refuses to run on a violation): 1 to 30 entries; `id` is lowercase letters, digits and hyphens, unique; `label` is at most 70 characters and must not contain `/` (labels are shown in the UI); `path` is absolute, normalized (no `..`, `//` or trailing `/`) and not `/` itself. The file is an operator allowlist, never user input: keep it root-owned and not writable by the Paperclip application.

## Snapshot schema 2

Adds `cpu` (`cores`, `usagePercent`, `load1/5/15`), `memory` (`totalBytes`, `availableBytes`, `usedBytes`, `usedPercent`, `swapTotalBytes`, `swapUsedBytes`) and `uptimeSeconds`. A failed CPU or memory probe leaves that field `null` and adds a `cpu`/`memory` `read_failed` coverage issue; disk metrics are unaffected. History entries gain optional `cpuPercent` and `memoryUsedBytes`. The plugin still reads schema 1.

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
