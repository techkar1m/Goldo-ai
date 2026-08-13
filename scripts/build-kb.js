#!/usr/bin/env node
/**
 * Build the Botpress Investors table from the raw crawler batch.
 *
 *   node scripts/build-kb.js "<path to shizune_filled.csv>"
 *
 * WHY THIS EXISTS
 * ---------------
 * The crawler batch and the rule engine do not speak the same language. The
 * batch stores Crunchbase-style values — "Pre-Seed", "Series A", "FinTech",
 * "Health Care" — while bot/01_extract_slots.js can only ever produce
 * "pre-seed", "series-a", "fintech", "healthtech", and bot/02_match_investors.js
 * only compares against those. Measured on the Malaysia/Singapore slice of the
 * batch, the overlap between the two vocabularies is exactly zero.
 *
 * Import the batch raw and the stage eliminator (E1), the stage scorer (S1) and
 * the sector scorer (S3) silently never fire: every investor survives on missing
 * data and ranking collapses onto geography alone. The output still looks
 * plausible, which is what makes it dangerous.
 *
 * This script translates the batch into the bot's schema and vocabulary.
 *
 * DELIBERATELY CONSERVATIVE
 * -------------------------
 * Where a raw value has no clean equivalent, this drops it rather than guessing.
 * That is the safe direction: rule S3 treats a missing sector as *neutral*, so
 * an unmapped investor simply competes on stage and geography. Over-mapping
 * would invent sector matches and push the wrong firms to the top of a founder's
 * shortlist. Generic tags ("Software", "Internet", "Apps") are ignored for the
 * same reason — nearly every company carries them, so they signal nothing.
 *
 * Cheque sizes are left empty rather than estimated from fund size: only a
 * handful of rows publish one, and S4 skips a blank range instead of penalising
 * it.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SOURCE = process.argv[2];
const OUT = path.join(__dirname, '..', 'bot', 'data', 'investors_botpress.csv');
const MARKETS = new Set(['Malaysia', 'Singapore']);

if (!SOURCE) {
  console.error('Usage: node scripts/build-kb.js "<path to shizune_filled.csv>"');
  process.exit(1);
}

/* ------------------------------------------------------------- vocabulary */

// Crunchbase funding rounds -> the seven rungs of the bot's stage ladder.
// Round types that are not a company stage (grants, debt, secondary sales,
// "Funding Round") are intentionally absent and get dropped.
const STAGE_MAP = {
  'angel': 'pre-seed',
  'pre-seed': 'pre-seed',
  'seed': 'seed',
  'series a': 'series-a',
  'series b': 'series-b',
  'series c': 'series-c',
  'series d': 'growth',
  'series e': 'growth',
  'series f': 'growth',
  'series g': 'growth',
  'series h': 'growth',
  'series i': 'growth',
  'post-ipo equity': 'growth',
  'post-ipo debt': 'growth',
  'private equity': 'buyout',
};

// Crunchbase industries -> the fifteen sector labels the classifier can emit.
const SECTOR_MAP = {
  // fintech
  'fintech': 'fintech', 'financial services': 'fintech', 'finance': 'fintech',
  'payments': 'fintech', 'banking': 'fintech', 'insurance': 'fintech',
  'insurtech': 'fintech', 'lending': 'fintech', 'wealth management': 'fintech',
  'mobile payments': 'fintech', 'credit': 'fintech',
  // healthtech
  'health care': 'healthtech', 'medical': 'healthtech', 'biotechnology': 'healthtech',
  'medical device': 'healthtech', 'health diagnostics': 'healthtech',
  'pharmaceutical': 'healthtech', 'mhealth': 'healthtech', 'life science': 'healthtech',
  'wellness': 'healthtech', 'hospital': 'healthtech', 'therapeutics': 'healthtech',
  // edtech
  'education': 'edtech', 'edtech': 'edtech', 'e-learning': 'edtech',
  'training': 'edtech', 'higher education': 'edtech',
  // enterprise-saas
  'saas': 'enterprise-saas', 'enterprise software': 'enterprise-saas',
  'enterprise': 'enterprise-saas', 'b2b': 'enterprise-saas', 'crm': 'enterprise-saas',
  'enterprise applications': 'enterprise-saas', 'cyber security': 'enterprise-saas',
  // ecommerce
  'e-commerce': 'ecommerce', 'ecommerce': 'ecommerce', 'retail': 'ecommerce',
  'marketplace': 'ecommerce', 'shopping': 'ecommerce', 'retail technology': 'ecommerce',
  // consumer
  'consumer goods': 'consumer', 'consumer': 'consumer', 'food and beverage': 'consumer',
  'fashion': 'consumer', 'beauty': 'consumer', 'restaurants': 'consumer',
  'travel': 'consumer', 'hospitality': 'consumer', 'fitness': 'consumer',
  // logistics
  'logistics': 'logistics', 'supply chain management': 'logistics',
  'delivery': 'logistics', 'shipping': 'logistics', 'transportation': 'logistics',
  'freight service': 'logistics', 'last mile transportation': 'logistics',
  // deeptech
  'artificial intelligence': 'deeptech', 'machine learning': 'deeptech',
  'robotics': 'deeptech', 'semiconductor': 'deeptech', 'nanotechnology': 'deeptech',
  'quantum computing': 'deeptech', 'space travel': 'deeptech', 'drones': 'deeptech',
  // climatetech
  'clean energy': 'climatetech', 'cleantech': 'climatetech', 'renewable energy': 'climatetech',
  'solar': 'climatetech', 'sustainability': 'climatetech', 'greentech': 'climatetech',
  'energy efficiency': 'climatetech', 'environmental engineering': 'climatetech',
  'recycling': 'climatetech', 'electric vehicle': 'climatetech',
  // agritech
  'agriculture': 'agritech', 'agtech': 'agritech', 'farming': 'agritech',
  'aquaculture': 'agritech', 'food processing': 'agritech',
  // web3
  'blockchain': 'web3', 'cryptocurrency': 'web3', 'web3': 'web3',
  'nft': 'web3', 'bitcoin': 'web3', 'ethereum': 'web3', 'defi': 'web3',
  'virtual currency': 'web3',
  // manufacturing
  'manufacturing': 'manufacturing', 'industrial': 'manufacturing',
  '3d printing': 'manufacturing', 'industrial automation': 'manufacturing',
  'advanced materials': 'manufacturing', 'industrial manufacturing': 'manufacturing',
  // media-gaming
  'gaming': 'media-gaming', 'video games': 'media-gaming', 'media and entertainment': 'media-gaming',
  'music': 'media-gaming', 'film': 'media-gaming', 'advertising': 'media-gaming',
  'social media': 'media-gaming', 'sports': 'media-gaming', 'esports': 'media-gaming',
  'digital media': 'media-gaming',
  // proptech
  'real estate': 'proptech', 'proptech': 'proptech', 'construction': 'proptech',
  'commercial real estate': 'proptech', 'real estate investment': 'proptech',
  // infrastructure
  'infrastructure': 'infrastructure', 'telecommunications': 'infrastructure',
  'cloud computing': 'infrastructure', 'data center': 'infrastructure',
  'cloud infrastructure': 'infrastructure', 'wireless': 'infrastructure',
};

// Regions the bot's GEO_COVERS map understands, normalised from the batch.
const GEO_MAP = {
  'malaysia': 'Malaysia',
  'singapore': 'Singapore',
  'indonesia': 'Southeast Asia', 'thailand': 'Southeast Asia',
  'vietnam': 'Southeast Asia', 'philippines': 'Southeast Asia',
  'southeast asia': 'Southeast Asia', 'south east asia': 'Southeast Asia',
  'asia': 'Asia', 'asia pacific': 'Asia Pacific', 'apac': 'Asia Pacific',
  'global': 'Global', 'worldwide': 'Global',
};

// Generic tags that describe almost every company and therefore signal nothing.
const IGNORED_INDUSTRIES = new Set([
  'software', 'internet', 'information technology', 'apps', 'mobile',
  'mobile apps', 'technology', 'consulting', 'service industry', 'startups',
  'venture capital', 'private equity', 'finance', 'financial services',
]);

/* ------------------------------------------------------------------ csv io */

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const csvCell = (value) => {
  const s = String(value == null ? '' : value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/* ----------------------------------------------------------------- mapping */

// The batch mixes ";" and "," as separators between multi-values.
const split = (v) => String(v || '').split(/[;,]/).map((s) => s.trim()).filter(Boolean);

const slug = (name) =>
  'inv-' + String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

/** Generic inboxes are a routing address, not a confirmed contact. */
const GENERIC_INBOX = /^(info|contact|hello|admin|enquiries|enquiry|general|office|mail|support|team)@/i;

function mapMulti(values, table) {
  const out = [];
  for (const value of values) {
    const mapped = table[value.toLowerCase()];
    if (mapped && !out.includes(mapped)) out.push(mapped);
  }
  return out;
}

/* --------------------------------------------------------------- execution */

const raw = fs.readFileSync(SOURCE, 'utf8').replace(/^﻿/, '');
const rows = parseCsv(raw);
const header = rows.shift().map((h) => h.trim());
const idx = {};
header.forEach((h, i) => { idx[h] = i; });

for (const required of ['Name', 'Country', 'Top Stages', 'Top Industries']) {
  if (!(required in idx)) {
    console.error(`Source is missing the "${required}" column — is this the right file?`);
    process.exit(1);
  }
}

const get = (row, col) => (row[idx[col]] || '').trim();

const out = [];
const seen = new Set();
const stats = {
  source: rows.length,
  inMarket: 0,
  duplicates: 0,
  withStage: 0,
  withSector: 0,
  withContact: 0,
  verifyFlagged: 0,
  droppedStageValues: new Map(),
  droppedIndustryValues: new Map(),
};

function note(map, key) { map.set(key, (map.get(key) || 0) + 1); }

for (const row of rows) {
  const country = get(row, 'Country');
  if (!MARKETS.has(country)) continue;
  stats.inMarket++;

  const name = get(row, 'Name');
  if (!name) continue;

  const id = slug(name);
  if (seen.has(id)) { stats.duplicates++; continue; }
  seen.add(id);

  // --- stages
  const rawStages = split(get(row, 'Top Stages'));
  const stages = mapMulti(rawStages, STAGE_MAP);
  for (const value of rawStages) {
    if (!STAGE_MAP[value.toLowerCase()]) note(stats.droppedStageValues, value);
  }
  // Keep the ladder order so the CSV reads naturally.
  const LADDER = ['pre-seed', 'seed', 'series-a', 'series-b', 'series-c', 'growth', 'buyout'];
  stages.sort((a, b) => LADDER.indexOf(a) - LADDER.indexOf(b));
  if (stages.length) stats.withStage++;

  // --- sectors
  const rawIndustries = split(get(row, 'Top Industries'));
  const sectors = mapMulti(
    rawIndustries.filter((v) => !IGNORED_INDUSTRIES.has(v.toLowerCase())),
    SECTOR_MAP
  );
  for (const value of rawIndustries) {
    const lower = value.toLowerCase();
    if (!SECTOR_MAP[lower] && !IGNORED_INDUSTRIES.has(lower)) {
      note(stats.droppedIndustryValues, value);
    }
  }
  if (sectors.length) stats.withSector++;

  // --- geography: where they invest if stated, else where they sit
  const targets = mapMulti(split(get(row, 'Countries')), GEO_MAP);
  const geography = targets.length ? targets : [country];
  if (!geography.includes(country)) geography.unshift(country);

  // --- contact
  const email = get(row, 'Email');
  const phone = get(row, 'Phone');
  const contact = email || phone;
  if (contact) stats.withContact++;
  // Flag anything that is a generic inbox or a bare phone number.
  const verify = contact && (!email || GENERIC_INBOX.test(email)) ? 'yes' : '';
  if (verify) stats.verifyFlagged++;

  // --- focus tags, derived from the mapped ladder
  const tags = [];
  if (stages.some((s) => s === 'pre-seed' || s === 'seed')) tags.push('early-stage');
  if (stages.some((s) => s === 'series-c' || s === 'growth' || s === 'buyout')) {
    tags.push('growth-capital');
  }

  out.push([
    id,
    '',                                   // name (individual contact) — not in the batch
    name,                                 // firm
    stages.join('; '),
    sectors.length ? sectors.join('; ') : 'sector-agnostic',
    geography.join('; '),
    '',                                   // ticket_size_min — never estimated
    '',                                   // ticket_size_max
    tags.join('; '),
    '',                                   // portfolio
    country === 'Malaysia' ? 'MY' : 'SG',
    get(row, 'Type'),
    contact,
    verify,
  ]);
}

const COLUMNS = [
  'investor_id', 'name', 'firm', 'stage_focus', 'sector_focus', 'geography',
  'ticket_size_min', 'ticket_size_max', 'focus_tags', 'portfolio', 'country',
  'investor_type', 'contact', 'verify',
];

fs.writeFileSync(
  OUT,
  [COLUMNS.join(','), ...out.map((r) => r.map(csvCell).join(','))].join('\n') + '\n',
  'utf8'
);

/* ------------------------------------------------------------------ report */

const pct = (n) => ((n / out.length) * 100).toFixed(1) + '%';
const top = (map, n) =>
  [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, v]) => `${k} (${v})`).join(', ');

console.log(`\nSource rows                 ${stats.source}`);
console.log(`In Malaysia or Singapore    ${stats.inMarket}`);
console.log(`Duplicate firm names merged ${stats.duplicates}`);
console.log(`\nWritten to bot/data/investors_botpress.csv: ${out.length} frames\n`);
console.log(`  with a usable stage       ${stats.withStage} (${pct(stats.withStage)})`);
console.log(`  with a mapped sector      ${stats.withSector} (${pct(stats.withSector)})`);
console.log(`  with a contact route      ${stats.withContact} (${pct(stats.withContact)})`);
console.log(`  contact needs verifying   ${stats.verifyFlagged} (${pct(stats.verifyFlagged)})`);
console.log(`\nMost common dropped stage values:\n  ${top(stats.droppedStageValues, 8) || 'none'}`);
console.log(`\nMost common unmapped industries:\n  ${top(stats.droppedIndustryValues, 10) || 'none'}`);
console.log('\nRe-run `npm run stats` to see the full distribution.\n');
