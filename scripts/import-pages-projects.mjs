#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

const [inventoryFile, publicDir] = process.argv.slice(2);
if (!inventoryFile || !publicDir) {
  throw new Error('usage: node scripts/import-pages-projects.mjs <inventory.json> <public-dir>');
}

const collection = 'sites-01';
const targetOrigin = 'https://cloudsites-hub.pages.dev';
const maxFilesPerProject = 100;
const manualMappings = {
  'car-finance-wollongong-guide': 'financebrokerwollongong-002',
  'google-reviews-toowoomba-guide': 'toowoombaseo-104',
  'local-seo-toowoomba-guide': 'toowoombaseo-101',
  'retaining-wall-cost-toowoomba': 'retainingwalltoowoomba-003',
  'business-equipment-finance-guide': 'loanphone-007',
  'kitchen-renovation-geelong': 'kitchenrenovationgeelong-001',
  'home-loan-broker-canberra': 'canberrahomeloanbroker-001',
  'first-home-buyer-conveyancing-brisbane': 'brisbaneconveyancers-002',
  'construction-bridging-finance-guide': 'bottomlinefinance-110',
  'property-development-finance-guide': 'bottomlinefinance-106',
  'home-loans-ballarat': 'ballaratmortgagebroker-001',
  'kitchen-renovation-adelaide': 'adelaidekitchenreno-001'
};
const legacyDuplicates = new Set([
  'roller-door-repairs-brisbane-guide',
  'kitchen-reno-brisbane-k-150',
  'seo-company-melbourne-tn-151',
  'refinancing-central-coast-f-150',
  'bathroom-renovation-gold-coast-guide',
  'car-finance-wollongong',
  'home-loan-broker-canberra'
]);

const inventory = JSON.parse(await fs.readFile(inventoryFile, 'utf8'));
const records = [
  ...inventory.projects,
  ...inventory.unmatched_projects.map(project => ({ ...project, rows: [] }))
].map(project => ({
  ...project,
  path_slug: legacyDuplicates.has(project.project)
    ? project.project
    : project.rows?.[0]?.slug || manualMappings[project.project] || project.project,
  db_slugs: legacyDuplicates.has(project.project)
    ? []
    : project.rows?.map(row => row.slug) || (manualMappings[project.project] ? [manualMappings[project.project]] : []),
  classification: !legacyDuplicates.has(project.project)
    && (project.rows?.length || manualMappings[project.project])
    ? 'tracked'
    : 'untracked-legacy-duplicate'
}));

const duplicatePaths = records
  .map(record => record.path_slug)
  .filter((value, index, all) => all.indexOf(value) !== index);
if (duplicatePaths.length) {
  throw new Error(`duplicate aggregate paths: ${[...new Set(duplicatePaths)].join(', ')}`);
}

function localFileFor(url, contentType) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';
  if (!path.extname(pathname) && contentType.includes('text/html')) pathname += '/index.html';
  return pathname.replace(/^\/+/, '') || 'index.html';
}

function candidates(text, baseUrl) {
  const found = new Set(['/robots.txt', '/sitemap.xml', '/llms.txt']);
  const patterns = [
    /(?:href|src|action)=["']([^"'#]+)["']/gi,
    /url\(\s*["']?([^"')#]+)["']?\s*\)/gi,
    /<loc>\s*([^<#\s]+)\s*<\/loc>/gi
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      try {
        const url = new URL(match[1], baseUrl);
        if (url.origin === baseUrl.origin) found.add(url.pathname + url.search);
      } catch {
        // Ignore malformed and non-HTTP references.
      }
    }
  }
  return found;
}

function rewriteText(text, sourceOrigin, targetBase, sourceUrl, contentType) {
  let output = text
    .replaceAll(sourceOrigin, targetBase.replace(/\/$/, ''))
    .replace(/((?:href|src|action)=["'])\/(?!\/)/gi, `$1${targetBase}`)
    .replace(/(url\(\s*["']?)\/(?!\/)/gi, `$1${targetBase}`)
    .replace(/(<loc>\s*)\/(?!\/)/gi, `$1${targetBase}`);

  if (contentType.includes('text/html')) {
    const relative = sourceUrl.pathname === '/' ? '' : sourceUrl.pathname.replace(/^\/+/, '');
    const canonical = new URL(relative, targetBase).href;
    output = output
      .replace(
        /(<link\s+[^>]*rel=["']canonical["'][^>]*href=["'])[^"']*/i,
        `$1${canonical}`
      )
      .replace(
        /(<meta\s+[^>]*property=["']og:url["'][^>]*content=["'])[^"']*/i,
        `$1${canonical}`
      );
  }
  return output;
}

async function importProject(record) {
  const sourceOrigin = `https://${record.subdomain}`;
  const targetBase = `${targetOrigin}/${collection}/${record.path_slug}/`;
  const destination = path.join(publicDir, collection, record.path_slug);
  const queue = ['/'];
  const seen = new Set();
  const fetched = [];

  await fs.rm(destination, { recursive: true, force: true });
  while (queue.length && seen.size < maxFilesPerProject) {
    const requestPath = queue.shift();
    if (seen.has(requestPath)) continue;
    seen.add(requestPath);

    const sourceUrl = new URL(requestPath, sourceOrigin);
    const response = await fetch(sourceUrl, { redirect: 'follow' });
    if (response.status === 404 && requestPath !== '/') continue;
    if (!response.ok) throw new Error(`${record.project} ${requestPath}: HTTP ${response.status}`);

    const contentType = response.headers.get('content-type') || '';
    const bytes = Buffer.from(await response.arrayBuffer());
    const localFile = localFileFor(sourceUrl, contentType);
    const outputFile = path.join(destination, localFile);
    await fs.mkdir(path.dirname(outputFile), { recursive: true });

    if (/text|json|xml|javascript|svg/.test(contentType)) {
      const text = bytes.toString('utf8');
      for (const next of candidates(text, sourceUrl)) {
        if (!seen.has(next)) queue.push(next);
      }
      await fs.writeFile(
        outputFile,
        rewriteText(text, sourceOrigin, targetBase, sourceUrl, contentType),
        'utf8'
      );
    } else {
      await fs.writeFile(outputFile, bytes);
    }
    fetched.push({ source: sourceUrl.href, file: localFile, status: response.status });
  }

  if (!fetched.some(file => file.file === 'index.html')) {
    throw new Error(`${record.project}: root index was not captured`);
  }
  return { ...record, source_origin: sourceOrigin, target_url: targetBase, fetched };
}

const imported = [];
for (const record of records) {
  process.stdout.write(`Importing ${record.project} -> ${record.path_slug} ... `);
  const result = await importProject(record);
  imported.push(result);
  process.stdout.write(`${result.fetched.length} files\n`);
}

const siteDirs = await fs.readdir(path.join(publicDir, collection), { withFileTypes: true });
const urls = [`${targetOrigin}/`];
for (const entry of siteDirs.filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  try {
    await fs.access(path.join(publicDir, collection, entry.name, 'index.html'));
    urls.push(`${targetOrigin}/${collection}/${entry.name}/`);
  } catch {
    // Only directories with a public root belong in the aggregate sitemap.
  }
}

const sitemap = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...urls.map(url => `  <url><loc>${url}</loc></url>`),
  '</urlset>',
  ''
].join('\n');
await fs.writeFile(path.join(publicDir, 'sitemap.xml'), sitemap, 'utf8');
await fs.writeFile(
  path.join(publicDir, 'migration-manifest.json'),
  `${JSON.stringify({ generated_at: new Date().toISOString(), imported }, null, 2)}\n`,
  'utf8'
);
console.log(`Imported ${imported.length} projects; aggregate sitemap now contains ${urls.length} URLs.`);
