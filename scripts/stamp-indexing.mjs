#!/usr/bin/env node

import fs from 'node:fs/promises';

const [envFile, projectId, backupFile] = process.argv.slice(2);
if (!envFile || !projectId || !backupFile) {
  throw new Error('usage: node scripts/stamp-indexing.mjs <env-file> <rapid-project-id> <backup.json>');
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
const headers = {
  apikey: key,
  Authorization: `Bearer ${key}`,
  'Content-Type': 'application/json',
  'Accept-Profile': 'deploy',
  'Content-Profile': 'deploy'
};

async function request(query, options = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1/cloud_properties?${query}`, {
    ...options,
    headers: { ...headers, ...options.headers }
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`cloud_properties ${response.status}: ${body}`);
  return body ? JSON.parse(body) : null;
}

const prefix = 'https://cloudsites-hub.pages.dev/sites-01/';
const rows = await request(`live_url=like.${encodeURIComponent(`${prefix}*`)}&select=*`);
if (rows.length !== 93) {
  throw new Error(`expected 93 tracked aggregate rows, got ${rows.length}`);
}
await fs.writeFile(
  backupFile,
  `${JSON.stringify({ captured_at: new Date().toISOString(), cloud_properties: rows }, null, 2)}\n`,
  'utf8'
);

const date = new Date().toISOString().slice(0, 10);
for (const row of rows) {
  const stamp = `RapidURLIndexer project ${projectId} submitted ${date}; IndexNow accepted`;
  const notes = row.notes?.includes(stamp)
    ? row.notes
    : [row.notes, stamp].filter(Boolean).join(' | ');
  await request(`slug=eq.${encodeURIComponent(row.slug)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      indexed_at: date,
      rapidurl_project: Number(projectId),
      notes
    })
  });
}

const readback = await request(
  `live_url=like.${encodeURIComponent(`${prefix}*`)}`
  + '&select=slug,indexed_at,rapidurl_project'
);
const failures = readback.filter(
  row => row.indexed_at !== date || Number(row.rapidurl_project) !== Number(projectId)
);
console.log(JSON.stringify({
  rows: readback.length,
  indexed_at: date,
  rapidurl_project: Number(projectId),
  passed: readback.length === 93 && failures.length === 0,
  failures
}, null, 2));
if (readback.length !== 93 || failures.length) process.exitCode = 1;
