# Journey Studios Storage Collector (read-only)

A standalone VPS-side collector for [Storage Manager](../../plugins/storage-manager/README.md). It reads a **static allowlist** of directories with `du -x -s -B1`, the root filesystem with `df -B1`, and Docker storage accounting with `docker system df --format '{{json .}}'`. It never invokes prune, rm, shell evaluation, Docker mutation, or cleanup commands.

## Install (operator runbook; NOT performed by CI)

1. Inspect `df -h /`, `docker ps`, `docker system df`, filesystem mount layout, rollback images and current backup. Make sure Node.js >=24 is installed and `/usr/bin/node` resolves to it (adjust service path if not).
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
