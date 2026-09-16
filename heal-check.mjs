#!/usr/bin/env node
// Watchdog for the published device ledger.
//
// Something outside this machine republishes an old v1 snapshot of the cards
// every day at 01:04Z, which truncates the ALL-TIME total (2026-09-15 and
// 2026-09-16 so far; the source has not been identified — it is not this Mac's
// launchd, crontab, Actions in any repo, a container, or a second local user).
// usage-card.mjs already heals the ledger from the local archive, but it only
// runs once a day at 00:40Z — 24 minutes *before* the clobber, so the wrong
// numbers stay up for ~23h.
//
// This checks the published ledger against the archive and re-runs the
// generator only when the published one has actually lost ground. One API call
// when everything is fine, so it is cheap enough to run hourly.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = process.env.USAGE_CARD_REPO;
const DEVICE = process.env.USAGE_CARD_DEVICE;
const GH = process.env.GH_PATH ?? 'gh';
const HERE = fileURLToPath(new URL('.', import.meta.url));
const ARCHIVE = process.env.USAGE_CARD_LEDGER_DIR
  ? `${process.env.USAGE_CARD_LEDGER_DIR}/${DEVICE}.json`
  : `${HERE}ledger-history/${DEVICE}.json`;

const stamp = () => new Date().toISOString();
if (!REPO || !DEVICE) throw new Error('Set USAGE_CARD_REPO and USAGE_CARD_DEVICE');
if (!existsSync(ARCHIVE)) {
  console.log(`[heal-check] ${stamp()} no local archive yet — nothing to compare against`);
  process.exit(0);
}

const gh = (args) => execFileSync(GH, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const archive = JSON.parse(readFileSync(ARCHIVE, 'utf8'));

let published;
try {
  const raw = gh(['api', `repos/${REPO}/contents/cards/devices/${DEVICE}.json`, '--jq', '.content']);
  published = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
} catch (err) {
  // A transient API failure must not trigger a republish.
  console.error(`[heal-check] ${stamp()} could not read the published ledger — skipping: ${err.message}`);
  process.exit(0);
}

const days = (s) => (s.daily || []).length;
const behind = [
  ['days', days(archive), days(published)],
  ['tokens', archive.totals?.totalTokens || 0, published.totals?.totalTokens || 0],
  ['cost', archive.totals?.totalCost || 0, published.totals?.totalCost || 0],
].filter(([, mine, theirs]) => theirs < mine - 1e-6);

if (behind.length) {
  console.warn(`[heal-check] ${stamp()} published ledger (v${published.version ?? 1}) regressed: ${
    behind.map(([k, mine, theirs]) => `${k} ${Math.round(mine)} -> ${Math.round(theirs)}`).join(', ')
  } — republishing from the archive`);
  execFileSync(process.execPath, [`${HERE}usage-card.mjs`], { stdio: 'inherit' });
}

// The same clobber rewrites the README usage note, so check that too. The note
// is prose, not a ledger: read the ALL-TIME figures back out of it and compare
// numerically, which survives wording and formatting changes. Only a real drop
// triggers a rewrite — the note step is an expensive LLM pipeline.
const SCALE = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
let readme;
try {
  readme = Buffer.from(gh(['api', `repos/${REPO}/contents/README.md`, '--jq', '.content']), 'base64').toString('utf8');
} catch (err) {
  console.error(`[heal-check] ${stamp()} could not read the README — skipping the note check: ${err.message}`);
  process.exit(0);
}
const note = readme.slice(readme.indexOf('<!-- usage-note:start -->'));
const tok = note.match(/([\d.]+)([KMBT])\s*토큰/);
const cost = note.match(/\$([\d,]+)/);
const noteTokens = tok ? parseFloat(tok[1]) * SCALE[tok[2]] : null;
const noteCost = cost ? Number(cost[1].replace(/,/g, '')) : null;
// 3% covers the rounding in "9.2B" and "$13,784"; a clobber is off by far more.
const stale = (mine, theirs) => theirs !== null && theirs < mine * 0.97;

if (noteTokens === null || noteCost === null) {
  console.warn(`[heal-check] ${stamp()} could not read the ALL-TIME figures out of the usage note — leaving it alone`);
} else if (stale(archive.totals.totalTokens, noteTokens) || stale(archive.totals.totalCost, noteCost)) {
  console.warn(`[heal-check] ${stamp()} usage note is stale (${tok[0]} / $${cost[1]} vs ledger ${
    Math.round(archive.totals.totalTokens / 1e9 * 10) / 10}B / $${Math.round(archive.totals.totalCost)}) — rewriting`);
  for (let attempt = 1; attempt <= 5; attempt++) {
    try { execFileSync(process.execPath, [`${HERE}update-note.mjs`], { stdio: 'inherit' }); break; }
    catch { console.warn(`[heal-check] note attempt ${attempt} rejected; redrafting`); }
  }
} else if (!behind.length) {
  console.log(`[heal-check] ${stamp()} ok — published v${published.version ?? 1}, ${days(published)} days, note in sync`);
}
