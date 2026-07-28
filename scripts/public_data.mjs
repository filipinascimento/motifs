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
  console.error('  node scripts/public_data.mjs export INPUT_JSON OUTPUT_JSON')
  console.error('  node scripts/public_data.mjs check PUBLIC_JSON')
  process.exit(2)
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'))
}

function sanitize(data) {
  const output = structuredClone(data)

  if (output.source && typeof output.source === 'object') {
    delete output.source.path
    output.source.note = 'Derived public network export; private source path removed.'
  }

  for (const node of output.nodes ?? []) {
    delete node.evidence_samples
    delete node.paper_ids
  }

  output.public_release = {
    schema_version: '1.1',
    contains_article_pdfs: false,
    contains_evidence_samples: false,
    contains_full_text: false,
    contains_paper_ids: false,
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
}

const [command, ...args] = process.argv.slice(2)

if (command === 'export' && args.length === 2) {
  const [input, output] = args
  const data = sanitize(readJson(input))
  validatePublicData(data)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, `${JSON.stringify(data, null, 2)}\n`)
  console.log(`Wrote ${output}: ${data.nodes.length} nodes, ${data.edges.length} edges`)
} else if (command === 'check' && args.length === 1) {
  const [input] = args
  const data = readJson(input)
  validatePublicData(data)
  console.log(`Public data check passed: ${data.nodes.length} nodes, ${data.edges.length} edges`)
} else {
  usage()
}
