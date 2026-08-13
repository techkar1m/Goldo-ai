#!/usr/bin/env node
/**
 * Recompute the knowledge-base figures quoted on the site.
 *
 *   node scripts/stats.js
 *
 * Run this after editing bot/data/investors_botpress.csv, then reconcile
 * public/coverage.html and the hero strip in public/index.html with the output.
 * The site quotes hard numbers, so they have to come from somewhere checkable.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CSV = path.join(__dirname, '..', 'bot', 'data', 'investors_botpress.csv');

/** Minimal RFC-4180 parser: handles quoted fields and embedded commas. */
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

const raw = fs.readFileSync(CSV, 'utf8').replace(/^﻿/, '');
const rows = parseCsv(raw);
const header = rows.shift().map((h) => h.trim());
const records = rows.map((r) => {
  const rec = {};
  header.forEach((h, i) => { rec[h] = (r[i] || '').trim(); });
  return rec;
});

const multi = (value) => String(value || '').split(';').map((s) => s.trim()).filter(Boolean);

function tally(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

const total = records.length;
const pct = (n) => ((n / total) * 100).toFixed(1);

function section(label, entries) {
  console.log(`\n${label}`);
  console.log('-'.repeat(label.length));
  for (const [name, count] of entries) {
    console.log(`  ${String(count).padStart(4)}  ${pct(count).padStart(5)}%  ${name}`);
  }
}

console.log(`\nInvestor frames: ${total}`);
console.log(`With a contact route:      ${records.filter((r) => r.contact).length}`);
console.log(`Flagged "verify contact":  ${records.filter((r) => r.verify.toLowerCase() === 'yes').length}`);
console.log(`With a cheque range:       ${records.filter((r) => r.ticket_size_min || r.ticket_size_max).length}`);
console.log(`Sector-agnostic:           ${records.filter((r) => multi(r.sector_focus).includes('sector-agnostic')).length}`);

section('By country', tally(records.map((r) => r.country)));
section('By investor type', tally(records.map((r) => r.investor_type)));
section('By stage (multi-valued)', tally(records.flatMap((r) => multi(r.stage_focus))));
section('By sector (multi-valued)', tally(records.flatMap((r) => multi(r.sector_focus))));
section('By region declared (multi-valued)', tally(records.flatMap((r) => multi(r.geography))));

// Labels outside the classifier's vocabulary can never win a sector match.
const SECTOR_VOCAB = new Set([
  'sector-agnostic', 'fintech', 'healthtech', 'edtech', 'enterprise-saas', 'ecommerce',
  'consumer', 'logistics', 'deeptech', 'climatetech', 'agritech', 'web3',
  'manufacturing', 'media-gaming', 'proptech', 'infrastructure',
]);
const strays = tally(records.flatMap((r) => multi(r.sector_focus)).filter((s) => !SECTOR_VOCAB.has(s)));
if (strays.length) {
  console.log('\nSector labels outside the classifier vocabulary (unmatchable):');
  for (const [name, count] of strays) console.log(`  ${count}  ${name}`);
}

const STAGE_VOCAB = new Set(['pre-seed', 'seed', 'series-a', 'series-b', 'series-c', 'growth', 'buyout']);
const strayStages = tally(records.flatMap((r) => multi(r.stage_focus)).filter((s) => !STAGE_VOCAB.has(s)));
if (strayStages.length) {
  console.log('\nStage labels outside the ladder (unmatchable):');
  for (const [name, count] of strayStages) console.log(`  ${count}  ${name}`);
}

console.log('');
