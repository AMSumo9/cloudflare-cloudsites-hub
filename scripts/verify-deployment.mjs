#!/usr/bin/env node

import fs from 'node:fs/promises';

const [baseUrl = 'https://cloudsites-hub.pages.dev', outputFile] = process.argv.slice(2);
const origin = new URL(baseUrl).origin;
const sitemapResponse = await fetch(`${origin}/sitemap.xml`);
if (!sitemapResponse.ok) throw new Error(`sitemap: HTTP ${sitemapResponse.status}`);
const sitemap = await sitemapResponse.text();
const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);

async function verify(url) {
  const response = await fetch(url, { redirect: 'manual' });
  const body = await response.text();
  const canonical = body.match(
    /<link\s+[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)/i
  )?.[1] || body.match(
    /<link\s+[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical/i
  )?.[1] || null;
  const anchors = [...body.matchAll(/<a\s+([^>]*href=["'](https?:\/\/[^"']+)["'][^>]*)>/gi)];
  const upwardLinks = anchors
    .filter(match => new URL(match[2]).origin !== origin)
    .filter(match => !/rel=["'][^"']*nofollow/i.test(match[1]))
    .map(match => match[2]);
  const authMarker = /<form[^>]+(?:login|sign-?in)|type=["']password["']/i.test(body);
  const expectedCanonical = url.endsWith('/') ? url : `${url}/`;

  return {
    url,
    status: response.status,
    redirected: response.status >= 300 && response.status < 400,
    canonical,
    expected_canonical: expectedCanonical,
    auth_marker: authMarker,
    dofollow_upward_links: upwardLinks,
    passed: response.status === 200
      && canonical === expectedCanonical
      && !authMarker
      && (url === `${origin}/` || upwardLinks.length > 0)
  };
}

const results = [];
for (let offset = 0; offset < urls.length; offset += 10) {
  results.push(...await Promise.all(urls.slice(offset, offset + 10).map(verify)));
}
const proof = {
  verified_at: new Date().toISOString(),
  origin,
  sitemap_status: sitemapResponse.status,
  sitemap_url_count: urls.length,
  passed: results.every(result => result.passed),
  failures: results.filter(result => !result.passed),
  results
};
if (outputFile) await fs.writeFile(outputFile, `${JSON.stringify(proof, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  verified_at: proof.verified_at,
  sitemap_url_count: proof.sitemap_url_count,
  passed: proof.passed,
  failure_count: proof.failures.length,
  failures: proof.failures
}, null, 2));
if (!proof.passed) process.exitCode = 1;
