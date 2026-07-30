#!/usr/bin/env node

import fs from 'node:fs/promises';
import {
  RECEIPT_KIND,
  RECEIPT_VERSION,
  manifestSha256
} from './migration-acceptance-lib.mjs';

const [manifestFile, envFile, receiptFile] = process.argv.slice(2);
if (!manifestFile || !envFile || !receiptFile) {
  throw new Error('usage: node scripts/verify-migration.mjs <manifest.json> <env-file> <acceptance.json>');
}

const manifestText = await fs.readFile(manifestFile, 'utf8');
const manifest = JSON.parse(manifestText);
const envText = await fs.readFile(envFile, 'utf8');
const env = Object.fromEntries(
  envText.split(/\r?\n/)
    .filter(line => /^[A-Z0-9_]+=/.test(line))
    .map(line => {
      const index = line.indexOf('=');
      return [line.slice(0, index), line.slice(index + 1)];
    })
);
const supabaseUrl = env.SUPABASE_URL?.replace(/\/$/, '');
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');

const headers = {
  apikey: key,
  Authorization: `Bearer ${key}`,
  'Accept-Profile': 'deploy',
  'Content-Profile': 'deploy'
};
const normalise = value => String(value || '').replace(/\/+$/, '');
const trackedPlacements = manifest.imported
  .filter(item => item.classification === 'tracked')
  .flatMap(item => item.db_slugs.map(slug => ({ slug, url: item.target_url })));
const targetToMigration = new Map(
  manifest.imported.map(item => [normalise(item.target_url), item])
);
const oldOrigins = new Set(manifest.imported.map(item => normalise(item.source_origin)));

async function restAll(table) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/${table}?select=*&limit=1000&offset=${offset}`,
      { headers }
    );
    const text = await response.text();
    if (!response.ok) throw new Error(`${table} ${response.status}: ${text.slice(0, 500)}`);
    const page = text ? JSON.parse(text) : [];
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

async function runBatches(items, check, size = 16) {
  const rows = [];
  for (let index = 0; index < items.length; index += size) {
    rows.push(...await Promise.all(items.slice(index, index + size).map(check)));
  }
  return rows;
}

async function fetchPage(url) {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000)
    });
    return { status: response.status, body: await response.text(), error: null };
  } catch (error) {
    return { status: 0, body: '', error: error.message };
  }
}

const [properties, edges] = await Promise.all([
  restAll('cloud_properties'),
  restAll('link_edges')
]);
const propertiesBySlug = new Map();
for (const row of properties) {
  const list = propertiesBySlug.get(row.slug) || [];
  list.push(row);
  propertiesBySlug.set(row.slug, list);
}

const missingProperties = [];
const staleProperties = [];
for (const placement of trackedPlacements) {
  const rows = propertiesBySlug.get(placement.slug) || [];
  if (rows.length !== 1) {
    missingProperties.push({ slug: placement.slug, rows: rows.length });
    continue;
  }
  const row = rows[0];
  if (
    row.live_url !== placement.url ||
    row.intended_url !== placement.url ||
    row.deploy_account !== 'mambaqld/cloudsites-hub/sites-01'
  ) {
    staleProperties.push({
      slug: placement.slug,
      expected: placement.url,
      live_url: row.live_url,
      intended_url: row.intended_url,
      deploy_account: row.deploy_account
    });
  }
}

const placementBySlug = new Map(trackedPlacements.map(item => [item.slug, item.url]));
const migratedSourceEdges = edges.filter(edge => placementBySlug.has(edge.source_ref));
const staleSourceEdges = migratedSourceEdges.filter(
  edge => edge.source_url !== placementBySlug.get(edge.source_ref)
);
const staleTargetEdges = edges.filter(edge => oldOrigins.has(normalise(edge.target_url)));

const targetChecks = await runBatches(manifest.imported, async item => {
  const page = await fetchPage(item.target_url);
  const canonical = page.body.match(
    /<link\b(?=[^>]*\brel=["'][^"']*\bcanonical\b[^"']*["'])(?=[^>]*\bhref=["']([^"']+)["'])[^>]*>/i
  )?.[1] || null;
  return {
    project: item.project,
    url: item.target_url,
    status: page.status,
    canonical,
    error: page.error,
    passed: page.status === 200 && normalise(canonical) === normalise(item.target_url)
  };
});
const targetFailures = targetChecks.filter(row => !row.passed);

const backlinkCandidates = edges
  .filter(edge => targetToMigration.has(normalise(edge.target_url)))
  .map(edge => ({
    ...edge,
    migration: targetToMigration.get(normalise(edge.target_url))
  }));
const backlinkChecks = await runBatches(backlinkCandidates, async edge => {
  const page = await fetchPage(edge.source_url);
  const oldOrigin = normalise(edge.migration.source_origin);
  return {
    source_ref: edge.source_ref,
    source_url: edge.source_url,
    target_url: edge.target_url,
    rel: edge.rel,
    status: page.status,
    target_present: page.body.includes(edge.target_url),
    retired_target_present: page.body.includes(oldOrigin),
    dofollow: !String(edge.rel || '').toLowerCase().includes('nofollow'),
    error: page.error,
    passed:
      page.status === 200 &&
      page.body.includes(edge.target_url) &&
      !page.body.includes(oldOrigin) &&
      !String(edge.rel || '').toLowerCase().includes('nofollow')
  };
});
const liveBacklinkFailures = backlinkChecks.filter(row => !row.passed);

const receipt = {
  receipt_version: RECEIPT_VERSION,
  kind: RECEIPT_KIND,
  generated_at: new Date().toISOString(),
  manifest_sha256: manifestSha256(manifestText),
  counts: {
    imported_projects: manifest.imported.length,
    tracked_placements: trackedPlacements.length,
    target_paths_checked: targetChecks.length,
    tracked_properties_checked: trackedPlacements.length - missingProperties.length,
    source_edges_checked: migratedSourceEdges.length,
    expected_live_backlinks: backlinkCandidates.length,
    live_backlinks_checked: backlinkChecks.length
  },
  defects: {
    missing_properties: missingProperties.length,
    stale_properties: staleProperties.length,
    stale_source_edges: staleSourceEdges.length,
    stale_target_edges: staleTargetEdges.length,
    target_failures: targetFailures.length,
    live_backlink_failures: liveBacklinkFailures.length
  },
  failures: {
    missing_properties: missingProperties,
    stale_properties: staleProperties,
    stale_source_edges: staleSourceEdges,
    stale_target_edges: staleTargetEdges,
    target_failures: targetFailures,
    live_backlink_failures: liveBacklinkFailures
  }
};
receipt.passed = Object.values(receipt.defects).every(value => value === 0);
await fs.writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  ...receipt,
  failures: undefined,
  receipt: receiptFile
}, null, 2));
if (!receipt.passed) process.exitCode = 1;
