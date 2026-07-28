# Motif explorer

A static, browser-side explorer for a hierarchical device-motif atlas. The
production site is published at
[filipinascimento.github.io/motifs](https://filipinascimento.github.io/motifs/).

The application has no API, database, or application server. GitHub Pages
serves the generated HTML, CSS, JavaScript, Web Workers, and a sanitized JSON
export. Filtering, search, layout, and interaction run in the visitor's
browser.

## Public-data boundary

This repository contains derived motif labels, descriptions, relationships,
aggregate counts, timelines, aliases, and facets. It intentionally does not
contain article PDFs, evidence excerpts, per-paper identifiers, full-text
extraction caches, internal run folders, or local filesystem paths. Full papers
remain in the private corpus and must never be copied into this repository.

The public-data tool removes the internal source path, evidence samples, and
per-paper identifiers, and rejects common full-text fields or local paths:

```bash
node scripts/public_data.mjs export \
  /path/to/private/network-export.json \
  public/data/hierarchical_motifs.json
```

Review the generated diff before committing it. The automated build runs the
same public-data checks again.

## Search behavior

Search prioritizes motif labels, visible descriptions, and aliases. When any
of those primary fields match, broader facet-only matches are left out. Facet
labels are used as a fallback when no primary field matches. Hidden facet
descriptions and internal curation metadata are never searched. Multiword
queries require every term, and exact label matches rank first.

## Local development

Node.js 22 is recommended.

```bash
npm ci
npm run dev -- --host 127.0.0.1 --port 4174
```

Open `http://127.0.0.1:4174`. A direct `file://` URL is not supported because
browsers block the JSON request; any ordinary static HTTP host works.

For a production check:

```bash
npm run build
npm run preview -- --host 127.0.0.1 --port 4174
```

## Release

Push an approved change to `main`. The GitHub Pages workflow validates the
public dataset, builds `dist/`, and deploys that directory. The Vite base URL
and all application data URLs are relative, so the bundle works at the
`/motifs/` project path without a hard-coded domain.

## Browser support

The network view uses Helios Web with WebGPU rendering and its WebGL2 fallback.
Use a current desktop browser. The bundle has no operating-system-specific
runtime dependency, but Safari/macOS should still be included in release QA.

## Content notice

This public repository does not distribute source articles, article excerpts,
or their full text.
