# Local CSV rate book

Rate sheets arrive in `self/rate-book/inbox/`. `ingest-rates.ts` accepts CSV, normalizes recognized headers into `self/rate-book/index/rates.csv`, records provenance, and moves successfully parsed source files to `processed/`. Unsupported formats remain in place. Use `--dry-run` to inspect without writing or moving files.

`find-rate.ts` filters by origin, destination, equipment, and date and can normalize configured aliases. Its stable exit codes are:

- `0`: a match was found;
- `3`: the rate book exists but no matching valid rate was found;
- `2`: no normalized rate book exists.

An unambiguous, current filed rate may be quoted mechanically. Ask the human when there is no match, stale or ambiguous data, or a counter would go below the filed rate. Quote documents should include price, currency, validity, surcharges, and `sourceRef`.
