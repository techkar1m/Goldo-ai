#!/usr/bin/env node
/**
 * Smoke test for the static site. No dependencies, no browser.
 *
 *   node scripts/check-site.js
 *
 * Catches the things that actually break this site in practice: a page that
 * forgot the Botpress scripts, an internal link pointing at a file that isn't
 * there, a new page missing from the sitemap, a stale canonical URL.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public');
const BOTPRESS_INJECT = 'cdn.botpress.cloud/webchat/v5.0/inject.js';
const BOTPRESS_BOT = 'files.bpcontent.cloud/2026/08/03/19/20260803193922-PNDMOM69.js';

// Pages that must carry the full furniture (nav, footer, canonical, chat).
const NOINDEX = new Set(['404.html']);

const failures = [];
const warnings = [];

function fail(file, message) { failures.push(`${file}: ${message}`); }
function warn(file, message) { warnings.push(`${file}: ${message}`); }

function htmlFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...htmlFiles(full));
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

/** Mirrors the server's resolution order: exact, +.html, /index.html. */
function resolves(urlPath) {
  const clean = urlPath.split('#')[0].split('?')[0];
  if (clean === '' || clean === '/') return fs.existsSync(path.join(ROOT, 'index.html'));
  const target = path.join(ROOT, clean.replace(/^\/+/, ''));
  return (
    fs.existsSync(target) ||
    fs.existsSync(target + '.html') ||
    fs.existsSync(path.join(target, 'index.html'))
  );
}

const pages = htmlFiles(ROOT);
if (pages.length === 0) {
  console.error('No HTML found in public/. Nothing to check.');
  process.exit(1);
}

const canonicals = new Map();

for (const file of pages) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const html = fs.readFileSync(file, 'utf8');

  // --- head essentials -----------------------------------------------------
  const title = /<title>([^<]+)<\/title>/.exec(html);
  if (!title) fail(rel, 'missing <title>');
  else if (title[1].trim().length > 70) warn(rel, `title is ${title[1].trim().length} chars (>70)`);

  const desc = /<meta\s+name="description"\s+content="([^"]*)"/.exec(html);
  if (!desc) fail(rel, 'missing meta description');
  else if (desc[1].length < 50) warn(rel, 'meta description under 50 chars');
  else if (desc[1].length > 175) warn(rel, `meta description is ${desc[1].length} chars (>175)`);

  if (!/<html lang="en">/.test(html)) fail(rel, 'missing lang on <html>');
  if (!/name="viewport"/.test(html)) fail(rel, 'missing viewport meta');
  if (!/rel="icon"/.test(html)) fail(rel, 'missing favicon link');
  if (!/\/assets\/site\.css/.test(html)) fail(rel, 'does not load site.css');

  const canonical = /<link\s+rel="canonical"\s+href="([^"]+)"/.exec(html);
  if (NOINDEX.has(rel)) {
    if (!/name="robots"[^>]*noindex/.test(html)) fail(rel, 'error page should be noindex');
  } else {
    if (!canonical) fail(rel, 'missing canonical link');
    else {
      const seen = canonicals.get(canonical[1]);
      if (seen) fail(rel, `duplicate canonical, also used by ${seen}`);
      canonicals.set(canonical[1], rel);
      // The canonical path should point back at this same page.
      const expected = rel === 'index.html' ? '/' : '/' + rel.replace(/\.html$/, '');
      const actual = new URL(canonical[1]).pathname;
      if (actual !== expected) fail(rel, `canonical path is ${actual}, expected ${expected}`);
    }
  }

  // --- chat integration ----------------------------------------------------
  if (!html.includes(BOTPRESS_INJECT)) fail(rel, 'missing Botpress inject.js');
  if (!html.includes(BOTPRESS_BOT)) fail(rel, 'missing Botpress bot config script');
  if (!/\/assets\/site\.js/.test(html)) fail(rel, 'does not load site.js (chat bridge)');
  if (!/data-goldo-(open|prompt)/.test(html)) fail(rel, 'no control opens the chat');
  if (/\sonclick=/.test(html)) warn(rel, 'inline onclick found — prefer data-goldo-open');

  // --- structure -----------------------------------------------------------
  if (!/class="skip"/.test(html)) fail(rel, 'missing skip link');
  if (!/<main id="main">/.test(html)) fail(rel, 'missing <main id="main">');
  if (!/<footer class="site-footer">/.test(html)) fail(rel, 'missing site footer');
  if (!/class="site-nav"/.test(html)) fail(rel, 'missing site nav');

  const h1Count = (html.match(/<h1[\s>]/g) || []).length;
  if (h1Count !== 1) fail(rel, `expected exactly one <h1>, found ${h1Count}`);

  // Images need alt text; SVG needs a role/label.
  const imgs = html.match(/<img\b[^>]*>/g) || [];
  for (const img of imgs) {
    if (!/\salt=/.test(img)) fail(rel, `<img> without alt: ${img.slice(0, 60)}`);
  }

  // --- links ---------------------------------------------------------------
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  for (const href of hrefs) {
    if (/^(https?:|mailto:|tel:|#)/.test(href)) continue;
    if (!href.startsWith('/')) {
      warn(rel, `relative link "${href}" — prefer root-absolute`);
      continue;
    }
    if (/\.(css|js|svg|png|ico|xml|txt|webmanifest)$/.test(href)) {
      if (!resolves(href)) fail(rel, `asset not found: ${href}`);
      continue;
    }
    if (href.endsWith('.html')) fail(rel, `link uses .html (server redirects): ${href}`);
    if (!resolves(href)) fail(rel, `broken internal link: ${href}`);
  }
}

// --- sitemap agreement -----------------------------------------------------
const sitemapPath = path.join(ROOT, 'sitemap.xml');
if (!fs.existsSync(sitemapPath)) {
  fail('sitemap.xml', 'missing');
} else {
  const sitemap = fs.readFileSync(sitemapPath, 'utf8');
  const listed = new Set(
    [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname)
  );
  const indexable = pages
    .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
    .filter((rel) => !NOINDEX.has(rel))
    .map((rel) => (rel === 'index.html' ? '/' : '/' + rel.replace(/\.html$/, '')));

  for (const url of indexable) {
    if (!listed.has(url)) fail('sitemap.xml', `does not list ${url}`);
  }
  for (const url of listed) {
    if (!indexable.includes(url)) fail('sitemap.xml', `lists ${url}, which is not a page`);
  }
}

// --- robots ----------------------------------------------------------------
const robotsPath = path.join(ROOT, 'robots.txt');
if (!fs.existsSync(robotsPath)) {
  fail('robots.txt', 'missing');
} else if (!/Sitemap:\s*https?:\/\//.test(fs.readFileSync(robotsPath, 'utf8'))) {
  fail('robots.txt', 'no absolute Sitemap: line');
}

// --- report ----------------------------------------------------------------
console.log(`Checked ${pages.length} pages in public/\n`);

if (warnings.length) {
  console.log(`${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`  ~ ${w}`);
  console.log('');
}

if (failures.length) {
  console.log(`${failures.length} failure(s):`);
  for (const f of failures) console.log(`  x ${f}`);
  process.exit(1);
}

console.log('All checks passed.');
