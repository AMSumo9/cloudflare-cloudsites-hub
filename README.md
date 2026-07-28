# Cloudsites Hub

Durable source for the neutral Cloudflare Pages aggregate host:

`https://cloudsites-hub.pages.dev/sites-01/<path>/`

Each property owns one directory under `public/sites-01`. Deployments publish
the complete `public` tree so an update to one property cannot erase its
siblings.

The root is provider infrastructure, not a cloud property. It remains neutral
and does not link across property stacks. Discovery is managed through the
project-level sitemap.
