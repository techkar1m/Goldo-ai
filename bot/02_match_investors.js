// ===========================================================================
// CARD 2 of 2  --  MATCH INVESTORS  (reasoning engine: production rules)
// ---------------------------------------------------------------------------
// Paste into an "Execute Code" card placed AFTER Card 1 and after any
// guided-fallback capture cards.
//
// Two tiers of production rules, run over every frame in the Investors table:
//
//   ELIMINATOR rules (hard filters)  -> IF incompatible THEN drop entirely
//   SCORER rules     (soft ranking)  -> IF compatible THEN add weighted points
//
// Each rule records a human-readable reason, so the bot can explain WHY an
// investor was ranked where it was. That traceability is the whole point of
// using production rules rather than letting a model pick.
//
// READS:   workflow.sector, workflow.stage, workflow.geography,
//          workflow.targetRaise (optional, from the guided fallback)
// WRITES:  workflow.matches (array), workflow.matchSummary (display string),
//          workflow.survivedCount, workflow.eliminatedCount
//
// IMPORTANT: table queries default to 20 rows. We page through all 176.
// ===========================================================================

// ------------------------------------------------------------ configuration
const STAGE_ORDER = ['pre-seed', 'seed', 'series-a', 'series-b', 'series-c', 'growth', 'buyout']
const STAGE_IDX = {}
STAGE_ORDER.forEach((s, i) => { STAGE_IDX[s] = i })

// A startup in <key> is served by an investor covering any region in <value>.
const GEO_COVERS = {
  Malaysia:  ['Malaysia', 'Southeast Asia', 'Asia', 'Asia Pacific', 'Global', 'No preference'],
  Singapore: ['Singapore', 'Southeast Asia', 'Asia', 'Asia Pacific', 'Global', 'No preference']
}

// Scorer weights. Stage and geography lead because those slots are reliably
// populated across the knowledge base; sector is a strong bonus but most
// firms in this market never publish a sector thesis.
const W = { stage: 35, geography: 25, sector: 25, ticket: 10, tags: 5 }

// How many rungs off the stage ladder still counts as a plausible fit.
// 1 = a seed fund still shows for a pre-seed startup (they often do both).
const STAGE_TOLERANCE = 1

const TOP_N = 5

// ---------------------------------------------------------------- helpers
const split = v => String(v || '').split(';').map(x => x.trim()).filter(Boolean)
const toInt = v => {
  const n = parseInt(v, 10)
  return isNaN(n) ? null : n
}
const money = n => {
  n = Number(n)
  if (n >= 1e6) return `US$${(n / 1e6).toFixed(0)}M`
  if (n >= 1e3) return `US$${(n / 1e3).toFixed(0)}K`
  return `US$${n}`
}

// ------------------------------------------------- load the knowledge base
// findRecords returns only 20 rows by default -- page until exhausted, or the
// rules would silently run on the first 20 investors only.
async function loadAllInvestors () {
  const all = []
  const PAGE = 100
  let offset = 0
  for (let guard = 0; guard < 50; guard++) {
    const batch = await InvestorsTable.findRecords({ limit: PAGE, offset })
    if (!batch || batch.length === 0) break
    all.push(...batch)
    if (batch.length < PAGE) break
    offset += PAGE
  }
  return all
}

// ========================================================== ELIMINATOR RULES
// Return { keep, why }. Only POSITIVE evidence of a mismatch eliminates --
// missing investor data is never treated as a reason to drop someone.
function eliminate (startup, inv) {
  // RULE E1 -- stage mismatch
  // IF startup stage known AND investor lists stages
  // AND nearest listed stage is more than STAGE_TOLERANCE rungs away
  // THEN eliminate
  const invStages = split(inv.stage_focus)
  if (startup.stage && STAGE_IDX[startup.stage] !== undefined && invStages.length) {
    const dists = invStages
      .filter(s => STAGE_IDX[s] !== undefined)
      .map(s => Math.abs(STAGE_IDX[startup.stage] - STAGE_IDX[s]))
    if (dists.length && Math.min(...dists) > STAGE_TOLERANCE) {
      return { keep: false, why: `stage mismatch (invests ${invStages.join('/')})` }
    }
  }

  // RULE E2 -- geography mismatch
  // IF startup geography known AND investor lists geographies
  // AND none of the investor's regions cover the startup's market
  // THEN eliminate
  const invGeos = split(inv.geography)
  if (startup.geography && startup.geography.length && invGeos.length) {
    const covered = startup.geography.some(g => {
      const accepted = GEO_COVERS[g] || [g]
      return invGeos.some(ig => accepted.indexOf(ig) !== -1)
    })
    if (!covered) {
      return { keep: false, why: `geography mismatch (covers ${invGeos.join('/')})` }
    }
  }

  return { keep: true, why: 'passed hard filters' }
}

// ============================================================= SCORER RULES
function score (startup, inv) {
  let pts = 0
  const reasons = []

  // RULE S1 -- stage fit: exact stage scores full, adjacent scores 60%
  const invStages = split(inv.stage_focus)
  if (startup.stage && STAGE_IDX[startup.stage] !== undefined && invStages.length) {
    const dists = invStages
      .filter(s => STAGE_IDX[s] !== undefined)
      .map(s => Math.abs(STAGE_IDX[startup.stage] - STAGE_IDX[s]))
    if (dists.length) {
      const d = Math.min(...dists)
      if (d === 0) {
        pts += W.stage
        reasons.push(`invests at ${startup.stage} stage`)
      } else if (d === 1) {
        pts += Math.round(W.stage * 0.6)
        reasons.push(`invests adjacent to ${startup.stage}`)
      }
    }
  }

  // RULE S2 -- geography fit: naming the country beats covering it regionally
  const invGeos = split(inv.geography)
  if (startup.geography && startup.geography.length && invGeos.length) {
    for (const g of startup.geography) {
      const accepted = GEO_COVERS[g] || [g]
      const hit = invGeos.find(ig => accepted.indexOf(ig) !== -1)
      if (hit) {
        const exact = invGeos.indexOf(g) !== -1
        pts += exact ? W.geography : Math.round(W.geography * 0.7)
        reasons.push(exact ? `covers ${g}` : `covers ${g} via ${hit}`)
        break
      }
    }
  }

  // RULE S3 -- sector fit
  // A sector-agnostic investor is NEUTRAL: no bonus, no penalty. Most firms
  // in this knowledge base never declared a sector, so penalising them would
  // wrongly bury the majority of the market.
  const invSectors = split(inv.sector_focus)
  const stSectors = startup.sector || []
  if (stSectors.length && invSectors.length) {
    const overlap = stSectors.filter(s => invSectors.indexOf(s) !== -1)
    if (overlap.length) {
      pts += W.sector
      reasons.push(`sector match: ${overlap.join(', ')}`)
    } else if (invSectors.indexOf('sector-agnostic') !== -1) {
      reasons.push('sector-agnostic investor')
    }
  } else if (invSectors.indexOf('sector-agnostic') !== -1) {
    reasons.push('sector-agnostic investor')
  }

  // RULE S4 -- cheque-size fit (only when the founder gave a target raise)
  const tmin = toInt(inv.ticket_size_min)
  const tmax = toInt(inv.ticket_size_max)
  const need = startup.targetRaise
  if (need && (tmin || tmax)) {
    const lo = tmin || 0
    const hi = tmax || Infinity
    if (need >= lo && need <= hi) {
      pts += W.ticket
      reasons.push(`cheque range fits ${money(need)} ask`)
    } else if (need < lo) {
      reasons.push(`ask below their ${money(lo)} minimum`)
    } else {
      reasons.push(`ask above their ${money(hi)} maximum`)
    }
  }

  // RULE S5 -- focus-tag overlap, used as a tie-breaker
  const tags = split(inv.focus_tags)
  if (tags.length && startup.stage) {
    const early = ['pre-seed', 'seed'].indexOf(startup.stage) !== -1
    if (early && tags.indexOf('early-stage') !== -1) {
      pts += W.tags
      reasons.push('focuses on early-stage')
    } else if (!early && tags.indexOf('growth-capital') !== -1) {
      pts += W.tags
      reasons.push('focuses on growth capital')
    }
  }

  return { pts, reasons }
}

// ================================================================ EXECUTION
const startup = {
  sector: workflow.sector || [],
  stage: workflow.stage || null,
  geography: workflow.geography || [],
  targetRaise: workflow.targetRaise || null
}

const investors = await loadAllInvestors()
const survivors = []
let eliminated = 0

for (const inv of investors) {
  const e = eliminate(startup, inv)
  if (!e.keep) { eliminated++; continue }
  const s = score(startup, inv)
  survivors.push({
    firm: inv.firm,
    type: inv.investor_type,
    country: inv.country,
    contact: inv.contact,
    verify: inv.verify,
    score: s.pts,
    reasons: s.reasons
  })
}

survivors.sort((a, b) => b.score - a.score)

workflow.survivedCount = survivors.length
workflow.eliminatedCount = eliminated
workflow.matches = survivors.slice(0, TOP_N)

// ------------------------------------------------------- display formatting
if (workflow.matches.length === 0 || workflow.matches[0].score === 0) {
  workflow.matchSummary =
    "I couldn't narrow this down confidently. Tell me your sector, stage and " +
    'target market and I\'ll try again.'
} else {
  const lines = workflow.matches
    .filter(m => m.score > 0)
    .map((m, i) => {
      const flag = m.verify === 'yes' ? ' (verify contact)' : ''
      const contact = m.contact ? `\n   ${m.contact}${flag}` : ''
      return `${i + 1}. ${m.firm} - score ${m.score}\n   ${m.reasons.join('; ')}${contact}`
    })
  workflow.matchSummary =
    `Screened ${investors.length} investors: ${eliminated} ruled out by the ` +
    `hard filters, ${survivors.length} scored.\n\n${lines.join('\n\n')}`
}

console.log(`${survivors.length} survived / ${eliminated} eliminated`)
