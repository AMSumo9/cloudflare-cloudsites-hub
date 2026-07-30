import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RECEIPT_KIND,
  RECEIPT_VERSION,
  manifestSha256,
  validateMigrationAcceptance
} from './migration-acceptance-lib.mjs';

const manifest = {
  imported: [
    {
      project: 'legacy-one',
      classification: 'tracked',
      db_slugs: ['one'],
      target_url: 'https://hub.example/sites-01/one/'
    },
    {
      project: 'legacy-two',
      classification: 'preserved',
      db_slugs: [],
      target_url: 'https://hub.example/sites-01/two/'
    }
  ]
};
const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
const now = Date.parse('2026-07-30T06:00:00.000Z');

function cleanReceipt() {
  return {
    receipt_version: RECEIPT_VERSION,
    kind: RECEIPT_KIND,
    generated_at: '2026-07-30T05:30:00.000Z',
    manifest_sha256: manifestSha256(manifestText),
    counts: {
      imported_projects: 2,
      tracked_placements: 1,
      target_paths_checked: 2,
      tracked_properties_checked: 1,
      expected_live_backlinks: 3,
      live_backlinks_checked: 3
    },
    defects: {
      missing_properties: 0,
      stale_properties: 0,
      stale_source_edges: 0,
      stale_target_edges: 0,
      target_failures: 0,
      live_backlink_failures: 0
    },
    passed: true
  };
}

test('accepts a fresh, complete, manifest-bound receipt', () => {
  const result = validateMigrationAcceptance({
    manifestText,
    manifest,
    receipt: cleanReceipt(),
    now
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.errors, []);
});

test('rejects manifest drift and incomplete live backlink coverage', () => {
  const receipt = cleanReceipt();
  receipt.manifest_sha256 = 'obsolete';
  receipt.counts.live_backlinks_checked = 2;
  const result = validateMigrationAcceptance({
    manifestText,
    manifest,
    receipt,
    now
  });
  assert.equal(result.passed, false);
  assert.match(result.errors.join('; '), /manifest_sha256/);
  assert.match(result.errors.join('; '), /every expected live backlink/);
});

test('rejects stale receipts and any non-zero defect', () => {
  const receipt = cleanReceipt();
  receipt.generated_at = '2026-07-30T01:00:00.000Z';
  receipt.defects.stale_target_edges = 1;
  const result = validateMigrationAcceptance({
    manifestText,
    manifest,
    receipt,
    now
  });
  assert.equal(result.passed, false);
  assert.match(result.errors.join('; '), /receipt is stale/);
  assert.match(result.errors.join('; '), /stale_target_edges must be 0/);
});
