# The bot behind the site

The website's "Start matching" buttons open a Botpress webchat. This folder holds
the logic that runs *inside* that bot, kept in the repo so the reasoning is
version-controlled alongside the pages that describe it.

Botpress Studio is not file-based, so these files are the source of truth for the
two Execute Code cards — edit them here, then paste into Studio and publish.

## Files

| File | What it is |
| --- | --- |
| `01_extract_slots.js` | Card 1 — language understanding. Calls a zero-shot classifier to turn free text into a startup frame (sector / stage / geography). |
| `02_match_investors.js` | Card 2 — the reasoning engine. Two eliminator rules and five weighted scorers over the investor table. |
| `data/investors_botpress.csv` | The knowledge base — 6,319 frames — in the exact column order the Botpress Table expects. **Generated** by `scripts/build-kb.js`; do not hand-edit. |

## Flow shape in Studio

```
Capture Input            -> workflow.userDescription
  |
Execute Code  (Card 1)   -> workflow.sector / stage / geography / lowConfidence
  |
Guided fallback          -> only for slots listed in workflow.lowConfidence
  (ask stage / sector / market / targetRaise)
  |
Execute Code  (Card 2)   -> workflow.matches / matchSummary / survivedCount
  |
Send Message             -> {{workflow.matchSummary}}
```

## Setup checklist

1. **Table** — create a Table named `Investors` and import
   `data/investors_botpress.csv`. The table variable in Card 2 is
   `InvestorsTable`; if Studio names yours differently, update the reference in
   `loadAllInvestors()`.
2. **Secret** — add `HF_TOKEN` under Studio → Settings → Variables, type
   *Secret*. The token needs the **Inference Providers** permission, otherwise
   Card 1 throws and every conversation takes the guided fallback path.
3. **Cards** — paste each file into its Execute Code card, in order.
4. **Publish** — the site loads the bot from Botpress's CDN, so publishing in
   Studio is what updates the live site. No redeploy needed.

## Two things that will bite you

**Table paging.** `findRecords` returns 20 rows by default. Card 2 pages through
in batches of 100 for that reason — remove the paging and the rules silently run
on the first 20 investors, which still produces plausible-looking output.

**Vocabulary coupling.** The classifier's candidate labels in Card 1 must match
the values stored in the table. A label the table never uses can never match,
and a table value outside the label list can never be matched *to*. Change one,
change the other.

This is not hypothetical here. The raw crawler batch stores `Pre-Seed`,
`Series A`, `FinTech`, `Health Care`; the rules compare against `pre-seed`,
`series-a`, `fintech`, `healthtech`. On the Malaysia/Singapore slice the overlap
is **zero rows**. Importing the batch straight into the table leaves E1, S1 and
S3 unable to fire — every investor survives on missing data and the ranking
collapses onto geography alone, while still returning five plausible-looking
names. Always import the output of `scripts/build-kb.js`, never the batch.

## Keeping the site honest

The numbers quoted on the site (6,319 frames, 4,699 sector-agnostic, 331 with a
contact route, the per-market, per-type, per-stage and per-sector counts on
`/coverage`) are all derived from `data/investors_botpress.csv`. Rebuild the CSV,
re-run the stats, and update `public/coverage.html` to match:

```bash
npm run stats
```

Note that **no investor in the current base publishes a cheque range**, so rule
S4 awards nothing to anyone. `build-kb.js` deliberately refuses to estimate a
per-deal cheque from a fund size. `/method` and `/coverage` both say so outright
rather than describing a rule that looks active but isn't.

The weights and thresholds quoted on `/method` come from the constants at the top
of `02_match_investors.js` — `W`, `STAGE_TOLERANCE`, `TOP_N` — and the confidence
floors on `/how-it-works` come from `SECTOR_MIN`, `STAGE_MIN` and `GEO_MIN` in
`01_extract_slots.js`.
