# VPS Status

Paperclip Plugin SDK v1 plugin for **read-only** VPS observability: disk, CPU, memory, Docker and history. (Formerly "Storage Manager"; the plugin id `journey-studios.storage-manager`, the `/storage` route and the `storage-snapshot` folder key are unchanged so existing installs keep working.) It uses the built-in `local.folders` capability instead of running privileged commands or reading Docker directly inside the plugin worker.

## Features

- Sidebar **VPS Status** and page `/storage`: CPU usage, load and core count, RAM (from `MemAvailable`) and swap, uptime, exact filesystem capacity (df), recorded host directories (du), Docker CLI accounting, collection freshness, optional configured alerts, and bounded history for disk, CPU and memory.
- **Workers** table (when the collector lists them): runner container state and health, uptime, CPU, memory against its limit, processes and restarts.
- Native agent tools: `vps_status` (disk, CPU, memory, uptime), `storage_overview` and `storage_hotspots`.
- CPU and memory are optional in the snapshot: a snapshot from an older collector (schema 1) or a failed probe shows them as "not collected" without invalidating the disk metrics.
- Authenticated, company-resolved GET plugin API routes: `/overview`, `/hotspots`, `/tools`. The host owns the API prefix and board authentication.
- Shows **stale**, **unconfigured**, **unavailable**, **invalid**, and **partial** coverage explicitly.
- Refreshes displayed metrics every 60 seconds while the page is visible and on return to the tab; host collection remains on its independent ten-minute cadence.
- No host CLI execution, docker.sock, filesystem writes, cleanup actions, or synthetic savings estimates.

The agent tools are available through the Paperclip plugin runtime. They are **not** automatically registered as tools on the official Paperclip MCP server; a future gateway adapter may forward the plugin's authenticated API routes if needed.

## Snapshot source

A dedicated [host collector](../../services/storage-collector/README.md) (snapshot schema 2; schema 1 is still read) writes `snapshot.json` under `/var/lib/paperclip-storage-manager` on the VPS. Mount that **one directory** read-only into the Paperclip application container (suggested container path: `/run/paperclip-storage`). Then configure the plugin's **Storage Collector snapshots** local folder in Paperclip Plugin Settings to `/run/paperclip-storage`, access `read`.

The local-folder contract requires `snapshot.json`. The worker only invokes `ctx.localFolders.status` and `ctx.localFolders.readText(companyId, "storage-snapshot", "snapshot.json")`. The worker validates a bounded schema; it never receives arbitrary path input.

Multiple companies must be explicitly configured independently. The host data is instance-wide and must only be shared with companies whose administrators are trusted to see it. Do not configure this folder for unrelated tenants.

## Notes

- CPU usage is the busy share of all cores over a one-second sample taken at collection time, not a rolling average; load averages come from the kernel. Memory is total minus `MemAvailable`, so reclaimable cache is not counted as used.
- Docker images, builder cache and volumes can share physical blocks; their reported sizes are approximations and not additive.
- Nested directory sizes overlap; usage shown for Paperclip projects and pnpm stores may involve hardlinks.
- Docker's "reclaimable" accounting is not a promise of safe cleanup.
- Host directory scans may be partial. Errors are returned as safe codes, never raw CLI output.
- Historical usage is bounded by the collector. A snapshot more than 30 minutes old is marked stale. Optional free-space thresholds must be configured by the operator.
- Run `pnpm --filter @journey-studios/paperclip-storage-manager test` and `pnpm check` from monorepo root.
