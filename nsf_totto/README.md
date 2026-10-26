# IndoHiTAB replacement sample — all ToTTo + all NSF

## New main sample
- Tables: 2,034
- QA: 2,729
- ToTTo: 1,851 tables / 1,967 QA
- NSF: 183 tables / 762 QA
- StatCan is removed from the MAIN sample.

## Pilot
The replacement script does **not** delete or overwrite any row whose live database
`is_pilot = true`. This is intentional. Historical pilot data, including any StatCan
pilot rows, are retained with their translations/reviews.

The live database is authoritative for pilot membership; it is not regenerated from
the replacement CSV.

## Batch allocation
Existing NSF/ToTTo tables keep their previous batch where possible. Newly added ToTTo
tables are assigned to balance table count and QA count.

- B1: 254 tables / 347 QA
- B2: 254 tables / 342 QA
- B3: 255 tables / 337 QA
- B4: 254 tables / 339 QA
- B5: 255 tables / 339 QA
- B6: 254 tables / 338 QA
- B7: 254 tables / 349 QA
- B8: 254 tables / 338 QA

## Overlap
After the main sample replacement, run `replace_overlap_100.sql`.

Overlap design:
- B1 ↔ B2: 25 unique tables (13 + 12)
- B3 ↔ B4: 25 unique tables (12 + 13)
- B5 ↔ B6: 25 unique tables (13 + 12)
- B7 ↔ B8: 25 unique tables (12 + 13)
- Total: 100 unique tables
- Every QA under the selected table is duplicated automatically.
- Pilot tables are excluded from overlap.
- Independent duplicate translations start blank.

`overlap_plan_preview.csv` is only a preview from the supplied files. The SQL performs
the final selection against the live DB so any additional live pilot tables are skipped.

## Recommended order
1. Backup Supabase.
2. Dry run:
   `python3 replace_main_sample_keep_pilot.py --sample-dir .`
3. Apply:
   `python3 replace_main_sample_keep_pilot.py --sample-dir . --apply`
4. Run `verify_after_replace.sql`.
5. Run `replace_overlap_100.sql`.
6. Run `verify_after_replace.sql` again.

Environment variables for step 3 must be set locally:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Do not commit the service-role/secret key.
