# Rate catalog

Run `sync-rate-catalog.ts` first. It saves the current Heroes catalog under `index/` through this peer's existing credential.

Place draft adapter CSV files in `inbox/`. Run `ingest-rates.ts --dry-run`, then `ingest-rates.ts --approve-by "<operator name>"`. The canonical store is `index/rate-catalog.json`. Only successful imports with at least one rate row move to `processed/`.

Run `find-rate.ts` with a Heroes `serviceKey` and all required offer facts. For transport rates, pass the service carriage as `--carriage <json-file>` or with `--container-allocation`, `--vehicle-type`, `--vehicle-allocation`, and `--handling-method`. Exit `0` requires one complete, approved, current, valid result. Exit `3` means no automatic result and requires human judgment. Exit `4` means invalid query or catalog data. Exit `2` means required rate files are missing. JSON returns at most 20 compact summaries and reports the full count. The command never chooses the cheapest candidate.

Run `export-rates.ts` when a CSV view is required. The `carriageJson` column preserves transport applicability across export and re-import. CSV is an import and export adapter, not the authority.
