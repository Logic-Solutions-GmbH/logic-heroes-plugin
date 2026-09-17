# Guided dataset intake

Use this procedure when a user sends source data in chat. The user does not write JSON.

1. Write the source unchanged to `self/datasets/<dataset>/sources/<utc-timestamp>-<slug>.<ext>` before you read it.
2. Propose the full manifest. Show the dataset key, each field type and required flag, identity key, deduplication key, filters, provenance fields, and approval fields. Give one short reason for the identity key.
3. Show the manifest and stop. Wait for approval or corrections.
4. Run `dataset.ts define --manifest <file.json>`. Explain a refusal in plain words, correct the manifest, and try again only after approval.
5. Propose the typed rows as a table. Mark each value you could not read as missing. State the row count.
6. Show the rows and stop. Wait for the second approval. Do not ingest before this approval.
7. Run `dataset-draft.ts stamp`, then run `dataset.ts ingest`. Report the `inserted` count. Keep the stamped file and reuse it. Never stamp again for a repeated ingest.
8. Offer one query on a declared filter. Run `dataset.ts export` and give the CSV path.

Stop if you would need to write a script, edit `index.json`, calculate a hash yourself, ingest before approval, or ask the user for JSON.

## Worked example

The user sends this price table:

```text
sku | region | price
A-1 | eu | 10.5
B-2 | us | 12
```

1. Save those exact bytes as `self/datasets/acme.product_prices/sources/20260917T183000Z-product-prices.txt`.
2. Propose `acme.product_prices`. Declare `sku`, `region`, and `price` as data fields. Declare the seven provenance and approval fields. Use `sku` as the identity because it names one product price row. Declare an `equals` filter on `region`.
3. Show that manifest and wait for approval.
4. Write the approved manifest file and run:

   ```text
   node <plugin-root>/scripts/run-tool.mjs dataset.ts define --manifest product-prices.manifest.json
   ```

5. Show the two typed rows:

   | sku | region | price |
   |---|---|---:|
   | A-1 | eu | 10.5 |
   | B-2 | us | 12 |

6. State `2 rows` and wait for the second approval.
7. Save the approved data-only rows as `product-prices.draft.json`. Then run:

   ```text
   node <plugin-root>/scripts/run-tool.mjs dataset-draft.ts stamp --dataset acme.product_prices --source self/datasets/acme.product_prices/sources/20260917T183000Z-product-prices.txt --source-ref "rows 2-3 of the price table" --draft product-prices.draft.json --approved-by carlos --out product-prices.stamped.json
   node <plugin-root>/scripts/run-tool.mjs dataset.ts ingest --dataset acme.product_prices --rows product-prices.stamped.json
   ```

   Report the returned `inserted` value. Keep `product-prices.stamped.json` for any repeated ingest.
8. Offer the declared `region` query. Export and give the returned CSV path:

   ```text
   node <plugin-root>/scripts/run-tool.mjs dataset.ts query --dataset acme.product_prices --field region --operator equals --value eu
   node <plugin-root>/scripts/run-tool.mjs dataset.ts export --dataset acme.product_prices
   ```

To reset a local trial, delete its temporary peer workspace folder.
