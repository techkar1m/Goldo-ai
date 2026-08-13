// ===========================================================================
// CARD 1 of 2  --  EXTRACT SLOTS  (language understanding layer)
// ---------------------------------------------------------------------------
// Paste into an "Execute Code" card in Botpress Studio.
//
// Calls a HuggingFace zero-shot classifier to turn the founder's free-text
// description into a STARTUP FRAME (sector / stage / geography).
//
// This card does NOT choose or rank investors. That is Card 2's job.
// Keeping understanding separate from matching is what makes the
// recommendation logic inspectable instead of a black box.
//
// REQUIRED before running:
//   workflow.userDescription  -> set by the preceding "Capture Input" card
//   HF_TOKEN                  -> Botpress Studio > Settings > Variables
//                                (type: Secret). Token needs the
//                                "Inference Providers" permission.
// ===========================================================================

const MODEL = 'facebook/bart-large-mnli'
const API_URL = `https://router.huggingface.co/hf-inference/models/${MODEL}`

// Candidate labels MUST match the vocabulary used in the Investors table,
// otherwise an extracted slot can never match a stored frame.
const SECTOR_LABELS = [
  'fintech', 'healthtech', 'edtech', 'enterprise-saas', 'ecommerce',
  'consumer', 'logistics', 'deeptech', 'climatetech', 'agritech',
  'web3', 'manufacturing', 'media-gaming', 'proptech', 'infrastructure'
]
const STAGE_LABELS = [
  'pre-seed', 'seed', 'series-a', 'series-b', 'series-c', 'growth', 'buyout'
]
const GEO_LABELS = [
  'Malaysia', 'Singapore', 'Southeast Asia', 'Asia Pacific',
  'China', 'India', 'Global'
]

// Confidence floors. A slot below its floor is left EMPTY rather than guessed,
// which is what triggers the guided-fallback branch later in the flow.
const SECTOR_MIN = 0.55
const STAGE_MIN = 0.45
const GEO_MIN = 0.50

async function classify (text, labels) {
  const res = await axios.post(
    API_URL,
    { inputs: text, parameters: { candidate_labels: labels, multi_label: true } },
    { headers: { Authorization: `Bearer ${env.HF_TOKEN}` }, timeout: 30000 }
  )
  // Response shape: { labels: [...], scores: [...] } aligned by index
  const out = {}
  res.data.labels.forEach((lbl, i) => { out[lbl] = res.data.scores[i] })
  return out
}

const text = (workflow.userDescription || '').trim()

if (!text) {
  workflow.sector = []
  workflow.stage = null
  workflow.geography = []
  workflow.lowConfidence = ['sector', 'stage', 'geography']
} else {
  try {
    // Three passes, one per slot. Separate passes score each label set
    // independently, which is more reliable than one mixed label list.
    const sectorScores = await classify(text, SECTOR_LABELS)
    const stageScores = await classify(text, STAGE_LABELS)
    const geoScores = await classify(text, GEO_LABELS)

    workflow.sector = Object.keys(sectorScores).filter(l => sectorScores[l] >= SECTOR_MIN)
    workflow.geography = Object.keys(geoScores).filter(l => geoScores[l] >= GEO_MIN)

    // A startup is at exactly one stage, so take the single best above floor.
    const bestStage = Object.keys(stageScores).reduce(
      (a, b) => (stageScores[b] > stageScores[a] ? b : a)
    )
    workflow.stage = stageScores[bestStage] >= STAGE_MIN ? bestStage : null

    // Which slots need the guided fallback?
    const low = []
    if (workflow.sector.length === 0) low.push('sector')
    if (!workflow.stage) low.push('stage')
    if (workflow.geography.length === 0) low.push('geography')
    workflow.lowConfidence = low

    // Kept for the demo: lets you show the actual confidence scores on screen.
    workflow.topSectorScore = Math.max(...Object.values(sectorScores)).toFixed(2)
    workflow.topStageScore = stageScores[bestStage].toFixed(2)
  } catch (err) {
    // The API can cold-start (503) or rate-limit. Never crash the conversation:
    // fall through to the guided path so the bot still works on stage.
    console.log('Classifier error:', err.message)
    workflow.sector = []
    workflow.stage = null
    workflow.geography = []
    workflow.lowConfidence = ['sector', 'stage', 'geography']
    workflow.classifierFailed = true
  }
}

console.log('Startup frame:', {
  sector: workflow.sector,
  stage: workflow.stage,
  geography: workflow.geography,
  lowConfidence: workflow.lowConfidence
})
