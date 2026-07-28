#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

const MAX_QUOTE_CHARS = 500
const FORBIDDEN_KEYS = new Set([
  'full_text',
  'raw_text',
  'paper_text',
  'pdf_path',
  'pdf_relative_path',
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

function normalizeWhitespace(value) {
  return value.replace(/\s+/gu, ' ').trim()
}

function boundedQuote(value) {
  const quote = normalizeWhitespace(value)
  if (quote.length <= MAX_QUOTE_CHARS) {
    return { quote, truncated: false }
  }

  const candidate = quote.slice(0, MAX_QUOTE_CHARS - 1)
  const lastSpace = candidate.lastIndexOf(' ')
  const boundary = lastSpace >= Math.floor(MAX_QUOTE_CHARS * 0.75)
    ? lastSpace
    : candidate.length
  return { quote: `${candidate.slice(0, boundary)}…`, truncated: true }
}

function publicDocumentTitle(value) {
  const basename = value.replaceAll('\\', '/').split('/').at(-1)
  return basename.replace(/\.pdf$/iu, '')
}

function sanitize(data) {
  const output = structuredClone(data)

  if (output.source && typeof output.source === 'object') {
    delete output.source.path
    output.source.note = 'Derived public network export; private source path removed.'
  }

  for (const node of output.nodes ?? []) {
    for (const sample of node.evidence_samples ?? []) {
      if (typeof sample.document_title === 'string') {
        sample.document_title = publicDocumentTitle(sample.document_title)
      }
      if (typeof sample.quote === 'string') {
        const bounded = boundedQuote(sample.quote)
        sample.quote = bounded.quote
        if (bounded.truncated) sample.quote_truncated = true
        else delete sample.quote_truncated
      }
    }
  }

  output.public_release = {
    schema_version: '1.0',
    contains_article_pdfs: false,
    contains_full_text: false,
    evidence_quote_max_characters: MAX_QUOTE_CHARS,
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
  if (trail.at(-1) === 'quote' && value.length > MAX_QUOTE_CHARS) {
    throw new Error(`Evidence excerpt exceeds ${MAX_QUOTE_CHARS} characters at ${location}`)
  }
}

function validatePublicData(data) {
  audit(data)
  if (data.source?.path) throw new Error('The private source path is still present')
  if (data.public_release?.contains_full_text !== false) {
    throw new Error('Missing public_release full-text declaration')
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
