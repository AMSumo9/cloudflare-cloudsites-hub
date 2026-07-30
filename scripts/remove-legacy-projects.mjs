#!/usr/bin/env node

import fs from 'node:fs/promises';
import { validateMigrationAcceptance } from './migration-acceptance-lib.mjs';

const [manifestFile, envFile, receiptFile, ...flags] = process.argv.slice(2);
if (!manifestFile || !envFile || !receiptFile) {
  throw new Error('usage: node scripts/remove-legacy-projects.mjs <manifest.json> <env-file> <receipt.json> [--acceptance <acceptance.json>] [--apply]');
}

const manifestText = await fs.readFile(manifestFile, 'utf8');
const manifest = JSON.parse(manifestText);
const expectedLegacy = new Set(manifest.imported.map(item => item.project));
if (!expectedLegacy.size || expectedLegacy.size !== manifest.imported.length) {
  throw new Error('manifest must contain a non-empty, unique imported project list');
}
const apply = flags.includes('--apply');
const acceptanceIndex = flags.indexOf('--acceptance');
const acceptanceFile = acceptanceIndex >= 0 ? flags[acceptanceIndex + 1] : null;
let acceptance = null;
if (apply) {
  if (!acceptanceFile || acceptanceFile.startsWith('--')) {
    throw new Error('--apply requires --acceptance <acceptance.json>');
  }
  acceptance = JSON.parse(await fs.readFile(acceptanceFile, 'utf8'));
  const validation = validateMigrationAcceptance({
    manifestText,
    manifest,
    receipt: acceptance
  });
  if (!validation.passed) {
    throw new Error(`Migration acceptance guard failed: ${validation.errors.join('; ')}`);
  }
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
const accountId = env.CLOUDFLARE_ACCOUNT_ID;
const token = env.CLOUDFLARE_API_TOKEN;
if (!accountId || !token) throw new Error('Cloudflare credentials are required');
const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects`;
const headers = { Authorization: `Bearer ${token}` };

async function api(method, endpoint) {
  const response = await fetch(`${base}${endpoint}`, { method, headers });
  const body = await response.text();
  const payload = body ? JSON.parse(body) : {};
  if (!response.ok || payload.success === false) {
    throw new Error(`${method} ${endpoint}: HTTP ${response.status} ${body}`);
  }
  return payload;
}

async function listProjects() {
  const projects = [];
  for (let page = 1; page <= 50; page++) {
    const payload = await api('GET', `?per_page=10&page=${page}`);
    projects.push(...payload.result);
    if (page >= (payload.result_info?.total_pages || 1)) break;
  }
  return projects;
}

const before = await listProjects();
const beforeNames = new Set(before.map(project => project.name));
const unexpected = [...beforeNames].filter(
  name => name !== 'cloudsites-hub' && !expectedLegacy.has(name)
);
const missing = [...expectedLegacy].filter(name => !beforeNames.has(name));
if (unexpected.length || missing.length || beforeNames.size !== 91) {
  throw new Error(JSON.stringify({
    message: 'Cloudflare project guard failed',
    count: beforeNames.size,
    unexpected,
    missing
  }));
}

if (!apply) {
  console.log(JSON.stringify({
    mode: 'dry-run',
    projects: beforeNames.size,
    delete: expectedLegacy.size,
    apply_requires: '--acceptance <fresh acceptance.json>'
  }, null, 2));
  process.exit(0);
}

const deleted = [];
for (const name of [...expectedLegacy].sort()) {
  process.stdout.write(`Deleting ${name} ... `);
  await api('DELETE', `/${encodeURIComponent(name)}`);
  deleted.push(name);
  process.stdout.write('ok\n');
}

const after = await listProjects();
const receipt = {
  completed_at: new Date().toISOString(),
  before_count: before.length,
  deleted_count: deleted.length,
  deleted,
  after: after.map(project => ({
    name: project.name,
    subdomain: project.subdomain,
    domains: project.domains
  })),
  acceptance: {
    file: acceptanceFile,
    generated_at: acceptance.generated_at,
    manifest_sha256: acceptance.manifest_sha256
  },
  passed: after.length === 1 && after[0].name === 'cloudsites-hub'
};
await fs.writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  before_count: receipt.before_count,
  deleted_count: receipt.deleted_count,
  after_count: receipt.after.length,
  remaining: receipt.after.map(project => project.name),
  passed: receipt.passed,
  receipt: receiptFile
}, null, 2));
if (!receipt.passed) process.exitCode = 1;
