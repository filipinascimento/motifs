#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

const FORBIDDEN_KEYS = new Set([
  'evidence_samples',
  'full_text',
  'raw_text',
  'paper_text',
  'pdf_path',
  'pdf_relative_path',
  'paper_ids',
  'local_path',
  'source_path',
])

function usage() {
  console.error('Usage:')
  console.error('  node scripts/public_data.mjs export INPUT_JSON OUTPUT_JSON [--observations SINGLETONS_JSON] [--aliases ALIASES_JSON]')
  console.error('  node scripts/public_data.mjs check PUBLIC_JSON')
  process.exit(2)
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'))
}

function cleanPublicText(value = '') {
  return String(value)
    .replace(/\bEV-[A-Za-z0-9-]+\b/gu, '')
    .replace(/\(\s*evidence\s*:?\s*(?:,\s*)*\)/giu, '')
    .replace(/\s+([,.;:])/gu, '$1')
    .replace(/\(\s*\)/gu, '')
    .replace(/\s{2,}/gu, ' ')
    .trim()
}

function sanitizeObservations(items, nodeIds) {
  return items.map((item) => {
    const resolvedParents = (item.resolved_parent_ids ?? []).filter((id) => nodeIds.has(id))
    const relatedNodeId = nodeIds.has(item.target_id) ? item.target_id : ''
    const familyIds = (item.family_ids ?? []).filter((id) => nodeIds.has(id))
    const anchorIds = [...new Set([
      ...resolvedParents,
      ...(relatedNodeId ? [relatedNodeId] : []),
      ...(resolvedParents.length || relatedNodeId ? [] : familyIds),
    ])]
    if (!anchorIds.length) throw new Error(`Reviewed observation has no public anchor: ${item.observation_id}`)
    return {
      id: item.observation_id,
      label: cleanPublicText(item.label),
      level: item.level,
      year: item.year,
      review_status: item.decision_status,
      registry_status: item.registry_status,
      confidence: item.confidence,
      decision: item.decision,
      exclusion_reason: cleanPublicText(item.exclusion_reason),
      rationale: cleanPublicText(item.rationale),
      parent_ids: resolvedParents,
      family_ids: familyIds,
      related_node_id: relatedNodeId || null,
      anchor_ids: anchorIds,
    }
  })
}

function mergeAliases(output, aliasMap = {}) {
  const byId = new Map((output.nodes ?? []).map((node) => [node.id, node]))
  for (const [nodeId, aliases] of Object.entries(aliasMap)) {
    const node = byId.get(nodeId)
    if (!node) throw new Error(`Alias overlay references an unknown node: ${nodeId}`)
    node.aliases = [...new Set([...(node.aliases ?? []), ...aliases])]
  }
}

function sanitize(data, observations = [], aliasMap = {}) {
  const output = structuredClone(data)

  if (output.source && typeof output.source === 'object') {
    delete output.source.path
    output.source.note = 'Derived public network export; private source path removed.'
  }

  for (const node of output.nodes ?? []) {
    delete node.evidence_samples
    delete node.paper_ids
  }

  mergeAliases(output, aliasMap)
  const nodeIds = new Set((output.nodes ?? []).map((node) => node.id))
  output.observations = sanitizeObservations(observations, nodeIds)

  output.public_release = {
    schema_version: '1.2',
    contains_article_pdfs: false,
    contains_evidence_samples: false,
    contains_full_text: false,
    contains_paper_ids: false,
    contains_reviewed_observations: true,
    reviewed_observation_count: output.observations.length,
  }

  return output
}

function audit(value, trail = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => audit(item, [...trail, index]))
    return
  }

  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
        throw new Error(`Forbidden field at ${[...trail, key].join('.')}`)
      }
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

function validatePublicData(data) {
  audit(data)
  if (data.source?.path) throw new Error('The private source path is still present')
  if (data.public_release?.contains_full_text !== false) {
    throw new Error('Missing public_release full-text declaration')
  }
  if (data.public_release?.contains_evidence_samples !== false) {
    throw new Error('Missing public_release evidence-sample declaration')
  }
  if (data.public_release?.contains_paper_ids !== false) {
    throw new Error('Missing public_release paper-ID declaration')
  }
  if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
    throw new Error('Expected nodes and edges arrays')
  }
  if (!Array.isArray(data.observations)) {
    throw new Error('Expected a reviewed observations array')
  }
  const nodeIds = new Set(data.nodes.map((node) => node.id))
  for (const observation of data.observations) {
    if (!observation.id || !observation.label) throw new Error('Observation is missing an ID or label')
    if (!Array.isArray(observation.anchor_ids) || !observation.anchor_ids.length) {
      throw new Error(`Observation has no anchors: ${observation.id}`)
    }
    for (const anchorId of observation.anchor_ids) {
      if (!nodeIds.has(anchorId)) throw new Error(`Observation references an unknown anchor: ${anchorId}`)
    }
  }
  if (data.public_release?.reviewed_observation_count !== data.observations.length) {
    throw new Error('Reviewed observation count does not match the public data')
  }
}

const [command, ...args] = process.argv.slice(2)

if (command === 'export' && args.length >= 2) {
  const [input, output, ...options] = args
  let observations = []
  let aliasMap = {}
  while (options.length) {
    const option = options.shift()
    const filename = options.shift()
    if (!filename || !['--observations', '--aliases'].includes(option)) usage()
    if (option === '--observations') observations = readJson(filename)
    if (option === '--aliases') aliasMap = readJson(filename)
  }
  const data = sanitize(readJson(input), observations, aliasMap)
  validatePublicData(data)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, `${JSON.stringify(data, null, 2)}\n`)
  console.log(`Wrote ${output}: ${data.nodes.length} nodes, ${data.edges.length} edges, ${data.observations.length} reviewed observations`)
} else if (command === 'check' && args.length === 1) {
  const [input] = args
  const data = readJson(input)
  validatePublicData(data)
  console.log(`Public data check passed: ${data.nodes.length} nodes, ${data.edges.length} edges, ${data.observations.length} reviewed observations`)
} else {
  usage()
}
