#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const PUBLIC_SCHEMA_ID = 'public-rogers-engineering-shards'
const PUBLIC_SCHEMA_VERSION = '1.0.0'
const MAX_COMPRESSED_BYTES = 50 * 1024 * 1024
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024

const FORBIDDEN_KEYS = new Set([
  'evidence',
  'evidence_quote',
  'evidence_samples',
  'evidence_spans',
  'explicit_statement',
  'extraction_confidence',
  'full_text',
  'original_text',
  'paper_text',
  'pdf_path',
  'pdf_relative_path',
  'provenance',
  'qa_flags',
  'quote',
  'quarantined',
  'quarantined_measurement_ids',
  'raw_text',
  'section_or_figure',
  'source_block_ids',
  'source_page_numbers',
  'source_path',
  'source_provenance',
  'supporting_text',
  'validation_flags',
  'verbatim_quote',
])

const FORBIDDEN_PREFIXES = ['legacy_', 'source_']
const FORBIDDEN_SUFFIXES = ['_key']
const ALLOWED_SOURCE_KEYS = new Set(['source_component_id', 'source_id'])

function usage() {
  console.error('Usage:')
  console.error('  node scripts/public_engineering_data.mjs export SOURCE_BUNDLE OUTPUT_DIRECTORY')
  console.error('  node scripts/public_engineering_data.mjs check MANIFEST_JSON')
  process.exit(2)
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'))
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function shouldRemoveKey(key) {
  const normalized = String(key).toLocaleLowerCase()
  if (ALLOWED_SOURCE_KEYS.has(normalized)) return false
  return FORBIDDEN_KEYS.has(normalized)
    || FORBIDDEN_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    || FORBIDDEN_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
}

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !shouldRemoveKey(key))
      .map(([key, item]) => [key, sanitize(item)]),
  )
}

function sanitizePaper(row) {
  const paper = sanitize(row)
  const citationTitle = String(paper.citation || '').replace(/\s+\([^()]*,\s*\d{4}[a-z]?\)\s*$/u, '').trim()
  if (/\.pdf$/iu.test(String(paper.title || ''))) paper.title = citationTitle || `Paper ${paper.publication_year || ''}`.trim()
  if (/\.pdf$/iu.test(String(paper.document_title || ''))) paper.document_title = paper.title
  return paper
}

function audit(value, trail = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => audit(item, [...trail, index]))
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (shouldRemoveKey(key)) throw new Error(`Forbidden field at ${[...trail, key].join('.')}`)
      audit(item, [...trail, key])
    }
    return
  }
  if (typeof value !== 'string') return
  const location = trail.join('.')
  if (/^(?:file:\/\/|\/(?:gpfs|home|Users|mnt|tmp)\/|[A-Za-z]:[\\/])/u.test(value)) {
    throw new Error(`Local filesystem path at ${location}`)
  }
  if (/\.pdf(?:$|[?#])/iu.test(value)) {
    throw new Error(`PDF filename or URL at ${location}`)
  }
}

function cleanIndexes(indexes) {
  const output = sanitize(indexes)
  for (const collection of Object.values(output)) {
    for (const item of Object.values(collection)) {
      delete item.plot_timeline
      delete item.activity_by_year
      if (item.records) delete item.records.quarantined_measurement_ids
    }
  }
  return output
}

function splitAcceptedByYear(rows) {
  const ranges = [
    ['2003-2010', 2003, 2010],
    ['2011-2016', 2011, 2016],
    ['2017-2021', 2017, 2021],
    ['2022-2026', 2022, 2026],
  ]
  return ranges.map(([label, minimum, maximum]) => ({
    label,
    rows: rows.filter((row) => {
      const year = Number(row.publication_year ?? row.year ?? 0)
      return year >= minimum && year <= maximum
    }),
  }))
}

function rowCount(value) {
  if (Array.isArray(value)) return value.length
  if (value && typeof value === 'object') {
    return Object.values(value).reduce((sum, item) => sum + (Array.isArray(item) ? item.length : 0), 0)
  }
  return 0
}

function writeShard(outputDirectory, spec, value) {
  audit(value, [spec.target])
  const raw = Buffer.from(JSON.stringify(value))
  const compressed = zlib.gzipSync(raw, { level: 9, mtime: 0 })
  if (raw.length > MAX_UNCOMPRESSED_BYTES) {
    throw new Error(`${spec.path} exceeds the ${MAX_UNCOMPRESSED_BYTES}-byte uncompressed safety limit`)
  }
  if (compressed.length > MAX_COMPRESSED_BYTES) {
    throw new Error(`${spec.path} exceeds the ${MAX_COMPRESSED_BYTES}-byte compressed safety limit`)
  }
  fs.writeFileSync(path.join(outputDirectory, spec.path), compressed)
  return {
    ...spec,
    rows: rowCount(value),
    bytes: compressed.length,
    uncompressed_bytes: raw.length,
    sha256: sha256(compressed),
    content_sha256: sha256(raw),
  }
}

function exportPublicBundle(sourceFilename, outputDirectory) {
  const source = readJson(sourceFilename)
  if (source.schema_id !== 'rogers-engineering-frontend-bundle') {
    throw new Error(`Unexpected source schema: ${source.schema_id}`)
  }
  if (source.qa?.passed !== true) throw new Error('Refusing to publish a source bundle that did not pass QA')

  fs.mkdirSync(outputDirectory, { recursive: true })
  for (const filename of fs.readdirSync(outputDirectory)) {
    if (filename === 'manifest.json' || filename.endsWith('.json.gz')) {
      fs.rmSync(path.join(outputDirectory, filename))
    }
  }

  const entities = sanitize(source.entities || {})
  entities.papers = (source.entities?.papers || []).map(sanitizePaper)
  const paperTitleById = new Map(entities.papers.map((paper) => [paper.paper_id, paper.title]))
  const accepted = sanitize(source.measurements?.accepted || [])
  const plotPoints = sanitize(source.measurements?.plot_points || [])
  const knowledge = sanitize(source.knowledge || {})
  const indexes = cleanIndexes(source.indexes || {})
  const graph = sanitize(source.graph || { nodes: [], edges: [] })
  for (const [paperId, item] of Object.entries(indexes.papers || {})) {
    const paper = entities.papers.find((row) => row.paper_id === paperId)
    item.title = paperTitleById.get(paperId) || item.title
    item.doi = paper?.doi || ''
    item.citation = paper?.citation || ''
  }
  for (const node of graph.nodes || []) {
    if (node.type === 'paper') node.label = paperTitleById.get(node.id) || node.label
  }
  const measurementRanges = splitAcceptedByYear(accepted)

  const shards = []
  shards.push(writeShard(outputDirectory, {
    path: 'entities.json.gz', target: 'entities', merge: 'replace',
  }, entities))
  for (const range of measurementRanges) {
    shards.push(writeShard(outputDirectory, {
      path: `measurements-${range.label}.json.gz`, target: 'measurements.accepted', merge: 'concat',
    }, range.rows))
  }
  shards.push(writeShard(outputDirectory, {
    path: 'measurement-plots.json.gz', target: 'measurements.plot_points', merge: 'replace',
  }, plotPoints))
  shards.push(writeShard(outputDirectory, {
    path: 'knowledge.json.gz', target: 'knowledge', merge: 'replace',
  }, knowledge))
  shards.push(writeShard(outputDirectory, {
    path: 'indexes.json.gz', target: 'indexes', merge: 'replace',
  }, indexes))
  shards.push(writeShard(outputDirectory, {
    path: 'graph.json.gz', target: 'graph', merge: 'replace',
  }, graph))

  const manifest = {
    schema_id: PUBLIC_SCHEMA_ID,
    schema_version: PUBLIC_SCHEMA_VERSION,
    generated_at: source.generated_at,
    bundle_schema_id: source.schema_id,
    bundle_schema_version: source.schema_version,
    bundle_qa_passed: true,
    public_release: {
      contains_article_pdfs: false,
      contains_full_text: false,
      contains_source_quotations: false,
      contains_page_or_block_provenance: false,
      contains_local_paths: false,
      contains_quarantined_records: false,
      contains_paper_titles_and_dois: true,
      contains_device_and_variant_records: true,
      contains_accepted_normalized_measurements: true,
      contains_complete_atomic_graph: true,
    },
    counts: {
      papers: entities.papers?.length || 0,
      devices: entities.devices?.length || 0,
      device_variants: entities.device_variants?.length || 0,
      components: entities.components?.length || 0,
      interfaces: entities.interfaces?.length || 0,
      motifs: entities.motifs?.length || 0,
      accepted_measurements: accepted.length,
      plot_measurements: plotPoints.length,
      relationships: knowledge.relationships?.length || 0,
      failures: knowledge.failures?.length || 0,
      constraints: knowledge.constraints?.length || 0,
      coverage: knowledge.coverage?.length || 0,
      graph_nodes: graph.nodes?.length || 0,
      graph_edges: graph.edges?.length || 0,
    },
    measurements: {
      plot_policy: 'Only accepted, normalized, finite numeric values/ranges/bounds enter plots. Quarantined records are not included in the public release.',
    },
    shards,
  }
  audit(manifest, ['manifest'])
  fs.writeFileSync(path.join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  validatePublicBundle(path.join(outputDirectory, 'manifest.json'))
  console.log(`Wrote ${outputDirectory}: ${shards.length} shards, ${manifest.counts.graph_nodes} graph nodes, ${manifest.counts.accepted_measurements} accepted measurements`)
}

function setPath(root, target, value, merge) {
  const parts = target.split('.')
  let current = root
  for (const part of parts.slice(0, -1)) {
    current[part] ||= {}
    current = current[part]
  }
  const leaf = parts.at(-1)
  if (merge === 'concat') current[leaf] = [...(current[leaf] || []), ...value]
  else current[leaf] = value
}

function loadPublicBundle(manifestFilename) {
  const manifest = readJson(manifestFilename)
  if (manifest.schema_id !== PUBLIC_SCHEMA_ID) throw new Error(`Unexpected public manifest schema: ${manifest.schema_id}`)
  const directory = path.dirname(manifestFilename)
  const bundle = {
    schema_id: manifest.bundle_schema_id,
    schema_version: manifest.bundle_schema_version,
    generated_at: manifest.generated_at,
    qa: { passed: manifest.bundle_qa_passed, counts: manifest.counts },
    measurements: { accepted: [], quarantined: [], plot_points: [], ...manifest.measurements },
    knowledge: {},
    indexes: {},
    graph: { nodes: [], edges: [] },
    public_release: manifest.public_release,
  }
  for (const shard of manifest.shards || []) {
    if (path.basename(shard.path) !== shard.path || !shard.path.endsWith('.json.gz')) {
      throw new Error(`Unsafe shard path: ${shard.path}`)
    }
    const compressed = fs.readFileSync(path.join(directory, shard.path))
    if (compressed.length !== shard.bytes) throw new Error(`Size mismatch: ${shard.path}`)
    if (sha256(compressed) !== shard.sha256) throw new Error(`Compressed checksum mismatch: ${shard.path}`)
    const raw = zlib.gunzipSync(compressed)
    if (raw.length !== shard.uncompressed_bytes) throw new Error(`Uncompressed size mismatch: ${shard.path}`)
    if (sha256(raw) !== shard.content_sha256) throw new Error(`Content checksum mismatch: ${shard.path}`)
    const value = JSON.parse(raw)
    if (rowCount(value) !== shard.rows) throw new Error(`Row count mismatch: ${shard.path}`)
    audit(value, [shard.path])
    setPath(bundle, shard.target, value, shard.merge)
  }
  return { manifest, bundle }
}

function assertUnique(rows, field, label) {
  const ids = rows.map((row) => row[field])
  if (ids.some((id) => !id)) throw new Error(`${label} contains a missing ${field}`)
  if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicate ${field} values`)
  return new Set(ids)
}

function validatePublicBundle(manifestFilename) {
  const { manifest, bundle } = loadPublicBundle(manifestFilename)
  audit(manifest, ['manifest'])
  const entities = bundle.entities || {}
  const paperIds = assertUnique(entities.papers || [], 'paper_id', 'papers')
  const deviceIds = assertUnique(entities.devices || [], 'device_id', 'devices')
  const variantIds = assertUnique(entities.device_variants || [], 'device_variant_id', 'variants')
  const componentIds = assertUnique(entities.components || [], 'component_id', 'components')
  const interfaceIds = assertUnique(entities.interfaces || [], 'interface_id', 'interfaces')
  const motifIds = assertUnique(entities.motifs || [], 'motif_id', 'motifs')
  const measurementIds = assertUnique(bundle.measurements.accepted || [], 'measurement_id', 'accepted measurements')

  for (const row of entities.devices || []) if (!paperIds.has(row.paper_id)) throw new Error(`Device references unknown paper: ${row.device_id}`)
  for (const row of entities.device_variants || []) {
    if (!paperIds.has(row.paper_id) || !deviceIds.has(row.device_id)) throw new Error(`Variant has an invalid endpoint: ${row.device_variant_id}`)
  }
  for (const row of entities.components || []) {
    if (!paperIds.has(row.paper_id) || !variantIds.has(row.device_variant_id)) throw new Error(`Component has an invalid endpoint: ${row.component_id}`)
  }
  for (const row of entities.interfaces || []) {
    if (!paperIds.has(row.paper_id) || !variantIds.has(row.device_variant_id)
      || !componentIds.has(row.source_component_id) || !componentIds.has(row.target_component_id)) {
      throw new Error(`Interface has an invalid endpoint: ${row.interface_id}`)
    }
  }
  for (const row of bundle.measurements.accepted || []) {
    if (!paperIds.has(row.paper_id)) throw new Error(`Measurement references unknown paper: ${row.measurement_id}`)
    if (row.device_id && !deviceIds.has(row.device_id)) throw new Error(`Measurement references unknown device: ${row.measurement_id}`)
    if (row.device_variant_id && !variantIds.has(row.device_variant_id)) throw new Error(`Measurement references unknown variant: ${row.measurement_id}`)
    if (row.component_id && !componentIds.has(row.component_id)) throw new Error(`Measurement references unknown component: ${row.measurement_id}`)
    if (row.interface_id && !interfaceIds.has(row.interface_id)) throw new Error(`Measurement references unknown interface: ${row.measurement_id}`)
    if (row.motif_id && !motifIds.has(row.motif_id)) throw new Error(`Measurement references unknown motif: ${row.measurement_id}`)
  }

  const graphNodeIds = assertUnique(bundle.graph.nodes || [], 'id', 'graph nodes')
  if (graphNodeIds.size !== manifest.counts.graph_nodes) throw new Error('Graph node count does not match manifest')
  if ((bundle.graph.edges || []).length !== manifest.counts.graph_edges) throw new Error('Graph edge count does not match manifest')
  for (const edge of bundle.graph.edges || []) {
    if (!graphNodeIds.has(edge.source_id) || !graphNodeIds.has(edge.target_id)) {
      throw new Error(`Graph edge has an unknown endpoint: ${edge.edge_id}`)
    }
  }
  if (measurementIds.size !== manifest.counts.accepted_measurements) throw new Error('Measurement count does not match manifest')
  if ((bundle.measurements.quarantined || []).length) throw new Error('Public bundle contains quarantined measurements')
  console.log(`Public engineering data check passed: ${manifest.shards.length} shards, ${graphNodeIds.size} nodes, ${measurementIds.size} accepted measurements`)
  return { manifest, bundle }
}

const [command, ...args] = process.argv.slice(2)
if (command === 'export' && args.length === 2) {
  exportPublicBundle(args[0], args[1])
} else if (command === 'check' && args.length === 1) {
  validatePublicBundle(args[0])
} else {
  usage()
}
