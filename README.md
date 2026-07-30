# Motif explorer

A static, browser-side explorer for a hierarchical device-motif atlas. The
production site is published at
[filipinascimento.github.io/motifs](https://filipinascimento.github.io/motifs/).

The application has no API, database, or application server. GitHub Pages
serves the generated HTML, CSS, JavaScript, Web Workers, and sanitized JSON
exports. Filtering, search, gzip decompression, graph projection, layout, and
interaction run in the visitor's browser.

## Public-data boundary

This repository contains derived motif labels, descriptions, relationships,
aggregate counts, timelines, aliases, facets, reviewed observations, paper
titles and DOIs, device and variant records, component/motif assignments,
accepted normalized measurements, structured engineering relationships,
failures, constraints, coverage decisions, and the complete atomic entity
graph. These records describe papers already publicly available online.

It intentionally does not contain article PDFs, full text, source quotations,
page/block extraction provenance, quarantined records, internal run folders,
or local filesystem paths. Full papers and private extraction artifacts must
never be copied into this repository.

The motif public-data tool removes private source paths, evidence samples, and
internal paper identifiers from the aggregate motif atlas:

```bash
node scripts/public_data.mjs export \
  /path/to/private/network-export.json \
  public/data/hierarchical_motifs.json \
  --observations /path/to/private/singleton_observations_and_decisions.json \
  --aliases config/search_aliases.json
```

The engineering export is split into compressed shards so every file stays
well below GitHub's file limit:

```bash
node scripts/public_engineering_data.mjs export \
  /path/to/private/frontend_engineering_bundle.json \
  public/data/engineering
```

The manifest separates entities, the full graph, indexes, knowledge records,
plot points, and four chronological measurement groups. Review generated
changes before committing them. The automated build validates both public
datasets and reruns the frontend tests.

After a taxonomy migration, verify that both public bundles expose the exact
same motif IDs, labels, levels, and parents. Pass every retired motif ID so the
check also scans all compressed engineering shards for stale references:

```bash
node scripts/check_bundle_parity.mjs \
  public/data/hierarchical_motifs.json \
  public/data/engineering/manifest.json \
  --forbid-id L1-power-electronics-communication-computation \
  --forbid-id L2-radio-frequency-or-nfc-telemetry

# Equivalent repository command (expected to fail until migration is complete)
npm run data:parity
```

## Search behavior

Search prioritizes motif labels, visible descriptions, aliases, and the labels
of reviewed observations. When any of those primary fields match, broader
facet-only matches are left out. Facet labels are used as a fallback when no
primary field matches. Hidden facet descriptions, observation rationales, and
internal curation metadata are never searched. Multiword queries require every
term to occur together in one visible field, and exact motif labels rank first.

Reviewed single-paper observations do not become network nodes or compact motif
cards. Search routes them to their recurrent parent motif (or their controlled
L1 family when no recurrent parent exists). Selecting that motif opens the full
detail panel, where every mapped observation is listed with its rationale, year,
review status, confidence, and canonical-registry decision.

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
