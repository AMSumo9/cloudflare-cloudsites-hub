import crypto from 'node:crypto';

export const RECEIPT_VERSION = 1;
export const RECEIPT_KIND = 'cloudflare_hub_migration_acceptance';
export const MAX_RECEIPT_AGE_MS = 2 * 60 * 60 * 1000;

export function manifestSha256(manifestText) {
  return crypto.createHash('sha256').update(manifestText).digest('hex');
}

export function validateMigrationAcceptance({
  manifestText,
  manifest,
  receipt,
  now = Date.now(),
  maxAgeMs = MAX_RECEIPT_AGE_MS
}) {
  const errors = [];
  const importedProjects = manifest.imported?.length || 0;
  const trackedPlacements = (manifest.imported || [])
    .filter(item => item.classification === 'tracked')
    .reduce((total, item) => total + (item.db_slugs?.length || 0), 0);
  const generatedAt = Date.parse(receipt.generated_at);
  const expectedHash = manifestSha256(manifestText);
  const counts = receipt.counts || {};
  const defects = receipt.defects || {};

  if (receipt.receipt_version < RECEIPT_VERSION) errors.push('receipt_version is missing or obsolete');
  if (receipt.kind !== RECEIPT_KIND) errors.push(`kind must be ${RECEIPT_KIND}`);
  if (receipt.manifest_sha256 !== expectedHash) errors.push('manifest_sha256 does not match');
  if (!Number.isFinite(generatedAt)) {
    errors.push('generated_at is invalid');
  } else {
    if (generatedAt > now + 5 * 60 * 1000) errors.push('generated_at is in the future');
    if (now - generatedAt > maxAgeMs) errors.push('receipt is stale');
  }
  if (counts.imported_projects !== importedProjects) {
    errors.push(`imported_projects must be ${importedProjects}`);
  }
  if (counts.tracked_placements !== trackedPlacements) {
    errors.push(`tracked_placements must be ${trackedPlacements}`);
  }
  if (counts.target_paths_checked !== importedProjects) {
    errors.push(`target_paths_checked must be ${importedProjects}`);
  }
  if (counts.tracked_properties_checked !== trackedPlacements) {
    errors.push(`tracked_properties_checked must be ${trackedPlacements}`);
  }
  if (
    !Number.isInteger(counts.expected_live_backlinks) ||
    counts.live_backlinks_checked !== counts.expected_live_backlinks
  ) {
    errors.push('every expected live backlink must be checked');
  }
  for (const key of [
    'missing_properties',
    'stale_properties',
    'stale_source_edges',
    'stale_target_edges',
    'target_failures',
    'live_backlink_failures'
  ]) {
    if (defects[key] !== 0) errors.push(`${key} must be 0`);
  }
  if (receipt.passed !== true) errors.push('receipt passed must be true');

  return {
    passed: errors.length === 0,
    errors,
    manifest_sha256: expectedHash,
    imported_projects: importedProjects,
    tracked_placements: trackedPlacements
  };
}
