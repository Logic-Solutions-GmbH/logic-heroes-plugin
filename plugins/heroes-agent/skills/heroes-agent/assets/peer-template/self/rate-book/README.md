# Rate book

Deposit CSV rate sheets in `inbox/`. From the peer workspace, run the bundled `ingest-rates.ts` tool to normalize them into `index/rate-book.csv`; parsed originals move to `processed/`. Use `--dry-run` for a non-mutating preview. `find-rate.ts` queries the index by lane, equipment, carrier, and validity date. Keep `index/aliases.csv` under version control, but review any business rate data before publishing a peer workspace.
