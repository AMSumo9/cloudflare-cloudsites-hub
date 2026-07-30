# Cloudsites Hub

Durable source for the neutral Cloudflare Pages aggregate host:

`https://cloudsites-hub.pages.dev/sites-01/<path>/`

Each property owns one directory under `public/sites-01`. Deployments publish
the complete `public` tree so an update to one property cannot erase its
siblings.

The root is provider infrastructure, not a cloud property. It remains neutral
and does not link across property stacks. Discovery is managed through the
project-level sitemap.

## Capacity And Reuse

Cloudflare's Pages project quota is not the placement limit for these static
properties. New properties reuse this project and receive a unique directory
below `public/sites-01`; the complete `public` tree is deployed each time.

The deploy sequence is:

1. Copy or update one property directory.
2. Rewrite its canonical and same-origin asset paths to the aggregate URL.
3. Commit and push the complete durable tree.
4. Deploy the complete `public` directory.
5. Require public HTTP 200, no redirect, exact self-canonical, and a dofollow
   upward link before DB writeback or index submission.

Never remove a property directory merely because its DB row is retired. Archive
or replace it in the durable repository first, verify that no active
`cloud_properties` or `link_edges` row points to it, and obtain explicit
approval before deleting the public copy or the provider project.

`public/migration-manifest.json` records the source project, source URL,
aggregate path, fetched files, and whether the imported project was an
authoritative DB placement or a preserved legacy duplicate.

## Legacy Project Removal Gate

Deleting source projects is gated by a fresh, manifest-bound acceptance
receipt. Generate it only after the aggregate deployment and every inbound
source-page repair are live:

```powershell
node scripts/verify-migration.mjs public/migration-manifest.json <env-file> migration-acceptance.json
```

The verifier requires every aggregate path to return HTTP 200 with its exact
self-canonical, every tracked DB property and source edge to use the aggregate
URL, no DB target edge to reference a retired project, and every current
inbound backlink to be live, dofollow, and updated.

`--apply` refuses a missing, stale, incomplete, or different-manifest receipt:

```powershell
node scripts/remove-legacy-projects.mjs public/migration-manifest.json <env-file> deletion-receipt.json --acceptance migration-acceptance.json --apply
```
