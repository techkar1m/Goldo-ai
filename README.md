# Goldo

Investor matching for founders raising in Malaysia and Singapore.

Describe your startup in plain language; Goldo screens a knowledge base of 176
real investors and returns a ranked shortlist with the reason for every match.
The matching is done by production rules over structured data, not by asking a
language model to pick — so every recommendation can be traced to a rule.

This repo holds **the website** and **the bot logic behind it**.

- The site is a static, multi-page site served by a zero-dependency Node server.
- The assistant is a Botpress webchat embedded on every page. Its two Execute
  Code cards live in [`bot/`](bot/), so the reasoning is version-controlled
  alongside the pages that document it.

---

## Structure

```
public/                 the website (static, no build step)
  index.html            landing page
  how-it-works.html     the six-stage pipeline
  method.html           all seven rules, written out
  coverage.html         what's in the knowledge base, and what's missing
  faq.html              includes the questions where the answer is no
  privacy.html          what the chat sends where
  404.html
  assets/               site.css, site.js, favicon.svg, og.svg
  robots.txt, sitemap.xml
bot/                    the Botpress side
  01_extract_slots.js   Card 1 — free text -> startup frame (classifier)
  02_match_investors.js Card 2 — the rule engine
  data/                 the knowledge base, in the bot's schema (CSV)
  README.md             how to wire it up in Botpress Studio
scripts/
  check-site.js         static-site smoke test
  build-kb.js           crawler batch -> the bot's schema and vocabulary
  stats.js              recompute the figures quoted on the site
server.js               static file server (routing, headers, caching)
railway.json            Railway build + healthcheck config
```

## Run it locally

```bash
npm start
```

Then open (https://goldo-ai-production.up.railway.app/). There is nothing to install — `npm start` runs
`node server.js`, and the site has no dependencies and no build step.

Before pushing:

```bash
npm run check
```

That verifies every page has a title, description, canonical URL, the Botpress
scripts, one `<h1>`, a skip link and working internal links, and that the sitemap
agrees with the pages that actually exist. It exits non-zero on failure.

## Deploy to Railway

The repo is already Railway-shaped: Nixpacks detects Node, `npm start` boots the
server on `$PORT`, and `/healthz` answers the healthcheck.

1. Go to [railway.app](https://railway.app) → **New Project** →
   **Deploy from GitHub repo** → pick `techkar1m/Goldo-ai`.
2. Railway reads `railway.json`, builds with Nixpacks and starts `npm start`.
   No environment variables are required.
3. Open **Settings → Networking → Generate Domain** to get a public URL, e.g.
   `goldo-ai.up.railway.app`.
4. Put that hostname into the three places that hardcode it:
   - the `<link rel="canonical">` and `og:url` / `og:image` tags in each page of
     `public/`
   - `public/sitemap.xml`
   - the `Sitemap:` line in `public/robots.txt`

   Then run `npm run check` and push. (The site works fine without step 4 — it
   only affects what search engines and link previews report.)

Every push to `main` redeploys.

### Environment variables

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Set by Railway automatically. |
| `HOST` | `0.0.0.0` | Bind address. |
| `NODE_ENV` | — | Set to `production` to send HSTS. |
| `DISABLE_CSP` | — | Set to `1` to drop the Content-Security-Policy header. Use only to diagnose a webchat that stopped rendering. |
| `QUIET_LOGS` | — | Set to `1` to stop logging every request. |

## How the chat is wired in

Every "Start matching" control on the site — header, hero, footer, 404, the
example prompt chips — is a `data-goldo-open` or `data-goldo-prompt` element.
`public/assets/site.js` handles them all through one delegated listener:

```html
<button type="button" data-goldo-open>Start matching</button>
<button type="button" data-goldo-prompt="Seed-stage fintech in Malaysia, raising US$500K.">…</button>
```

The Botpress bundle loads async from a CDN, so a click before the SDK is ready
would otherwise be silently lost. `site.js` queues those clicks, watches for
`webchat:ready` (and polls, because the bot config script initialises after
`inject.js` defines `window.botpress`), then flushes the queue. If the SDK never
arrives — usually a privacy extension blocking `botpress.cloud` — it tells the
visitor instead of leaving a dead button.

`data-goldo-prompt` opens the panel and sends that text as the first message
after a short delay, so the bot's greeting lands first. Set `PREFILL_ENABLED` to
`false` at the top of `site.js` to make those chips only open the panel.

`window.openGoldo()` still exists as an alias, because the original single-page
version called it from an inline `onclick`.

### Updating the bot

The site loads the bot from Botpress's CDN, so publishing in Botpress Studio
updates the live site immediately — no redeploy. Only redeploy when the pages
themselves change. Swapping in a different bot means replacing the second script
tag in all seven pages of `public/`:

```html
<script src="https://files.bpcontent.cloud/2026/08/03/19/20260803193922-PNDMOM69.js" defer></script>
```

## The knowledge base

`bot/data/investors_botpress.csv` is **generated**, not hand-edited. It is built
from the crawler batch (`shizune_filled.csv`) by:

```bash
node scripts/build-kb.js "<path to shizune_filled.csv>"
```

That step is not optional, and it is the thing most likely to be skipped by
mistake. The batch stores Crunchbase-style values — `Pre-Seed`, `Series A`,
`FinTech`, `Health Care` — while the rules only ever compare against `pre-seed`,
`series-a`, `fintech`, `healthtech`. **Measured on the Malaysia/Singapore slice,
the overlap between the two vocabularies is exactly zero.** Import the batch raw
and rules E1, S1 and S3 silently never fire: everyone survives on missing data
and ranking collapses onto geography alone. The output still looks plausible,
which is what makes it worth guarding against.

The current build: 8,653 source rows → 6,946 in Malaysia or Singapore → 627
duplicate firms merged → **6,319 frames**, of which 1,673 declare a stage, 1,620
a sector, and 331 carry a contact route.

### Keeping the numbers honest

The site quotes hard figures — 6,319 frames, 4,699 sector-agnostic, the
per-market, per-type, per-stage and per-sector counts on `/coverage`. They all
come from the generated CSV:

```bash
npm run stats
```

Rebuild the CSV, re-run that, and reconcile `public/coverage.html` with the
output. The rule weights on `/method` and the confidence floors on
`/how-it-works` come from the constants in the two `bot/*.js` cards.

One figure is set by hand: the `1k+` in the hero strip of `public/index.html`.
The measured count is 6,319, so `1k+` is true but conservative.

## Troubleshooting

**The chat button never appears.** Check the bot is *published* in Botpress, and
that Webchat is enabled and shared. Then check the two script tags still match
the snippet under Botpress → Webchat → Share — they change if the bot is
recreated. Then rule out an ad blocker.

**The chat appears but returns no matches.** Usually the `Investors` table is
empty, or named differently from `InvestorsTable` in
`bot/02_match_investors.js`.

**Every conversation takes the guided path.** Card 1's classifier call is
failing — most often a missing or under-scoped `HF_TOKEN`. It needs the
*Inference Providers* permission. The bot is built to degrade to the guided
questions rather than break, so this fails quietly by design.

**Railway healthcheck fails.** Confirm the deploy log shows
`Goldo site listening on http://0.0.0.0:<port>`. The server must bind `$PORT`,
not a fixed one.

## Limits worth stating plainly

Goldo recommends only investors present in its knowledge base and does not
guarantee investor interest, introductions or funding. Some cheque sizes are
estimated from published fund size, and some contact details are unverified.
It is a university project for module AAPP002-4-2, not financial advice.
