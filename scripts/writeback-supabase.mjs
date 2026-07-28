#!/usr/bin/env node

import fs from 'node:fs/promises';

const [manifestFile, envFile, backupFile, mode] = process.argv.slice(2);
if (!manifestFile || !envFile || !backupFile) {
  throw new Error('usage: node scripts/writeback-supabase.mjs <manifest.json> <env-file> <backup.json> [--apply]');
}

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

const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
const placements = manifest.imported
  .filter(item => item.classification === 'tracked')
  .flatMap(item => item.db_slugs.map(slug => ({ slug, url: item.target_url })));
const headers = {
  apikey: key,
  Authorization: `Bearer ${key}`,
  'Content-Type': 'application/json',
  'Accept-Profile': 'deploy',
  'Content-Profile': 'deploy'
};

async function rest(table, query, options = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${table}?${query}`, {
    ...options,
    headers: { ...headers, ...options.headers }
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${table} ${response.status}: ${body}`);
  return body ? JSON.parse(body) : null;
}

const before = { captured_at: new Date().toISOString(), cloud_properties: [], link_edges: [] };
for (const placement of placements) {
  const slug = encodeURIComponent(placement.slug);
  const rows = await rest('cloud_properties', `slug=eq.${slug}&select=*`);
  if (rows.length !== 1) throw new Error(`${placement.slug}: expected one cloud_properties row, got ${rows.length}`);
  before.cloud_properties.push(rows[0]);
  before.link_edges.push(...await rest('link_edges', `source_ref=eq.${slug}&select=*`));
}
await fs.writeFile(backupFile, `${JSON.stringify(before, null, 2)}\n`, 'utf8');

if (mode !== '--apply') {
  console.log(JSON.stringify({
    mode: 'dry-run',
    placements: placements.length,
    link_edges: before.link_edges.length,
    backup: backupFile
  }, null, 2));
  process.exit(0);
}

const date = new Date().toISOString().slice(0, 10);
for (const placement of placements) {
  const existing = before.cloud_properties.find(row => row.slug === placement.slug);
  const note = `Cloudflare aggregate migration ${date}: ${placement.url}`;
  const notes = existing.notes?.includes(note)
    ? existing.notes
    : [existing.notes, note].filter(Boolean).join(' | ');
  await rest('cloud_properties', `slug=eq.${encodeURIComponent(placement.slug)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      live_url: placement.url,
      intended_url: placement.url,
      deploy_account: 'mambaqld/cloudsites-hub/sites-01',
      notes
    })
  });
  const oldEdges = before.link_edges.filter(edge => edge.source_ref === placement.slug);
  const edgesByTarget = new Map();
  for (const edge of oldEdges) {
    const current = edgesByTarget.get(edge.target_url);
    if (!current || edge.source_feed === 'link-map') edgesByTarget.set(edge.target_url, edge);
  }
  await rest('link_edges', `source_ref=eq.${encodeURIComponent(placement.slug)}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' }
  });
  const replacementEdges = [...edgesByTarget.values()].map(edge => ({
    source_url: placement.url,
    target_url: edge.target_url,
    source_type: edge.source_type,
    source_ref: edge.source_ref,
    target_type: edge.target_type,
    anchor: edge.anchor,
    rel: edge.rel,
    source_feed: edge.source_feed,
    first_seen: edge.first_seen
  }));
  if (replacementEdges.length) {
    await rest('link_edges', '', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(replacementEdges)
    });
  }
}

const failures = [];
let edgeCount = 0;
for (const placement of placements) {
  const slug = encodeURIComponent(placement.slug);
  const rows = await rest(
    'cloud_properties',
    `slug=eq.${slug}&select=slug,live_url,intended_url,deploy_account`
  );
  if (rows.length !== 1
    || rows[0].live_url !== placement.url
    || rows[0].intended_url !== placement.url
    || rows[0].deploy_account !== 'mambaqld/cloudsites-hub/sites-01') {
    failures.push({ slug: placement.slug, table: 'cloud_properties', rows });
  }
  const edges = await rest('link_edges', `source_ref=eq.${slug}&select=source_url`);
  edgeCount += edges.length;
  if (edges.some(edge => edge.source_url !== placement.url)) {
    failures.push({ slug: placement.slug, table: 'link_edges', edges });
  }
}

console.log(JSON.stringify({
  mode: 'applied',
  placements: placements.length,
  link_edges: edgeCount,
  backup: backupFile,
  passed: failures.length === 0,
  failures
}, null, 2));
if (failures.length) process.exitCode = 1;
