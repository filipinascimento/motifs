#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

function usage() {
  console.error('Usage:')
  console.error('  node scripts/check_bundle_parity.mjs HIERARCHY_JSON ENGINEERING_MANIFEST [--forbid-id MOTIF_ID ...]')
  process.exit(2)
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'))
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function sortedStrings(values = []) {
  return [...values].map(String).sort()
}

function sameStrings(left, right) {
  return JSON.stringify(sortedStrings(left)) === JSON.stringify(sortedStrings(right))
}

function indexUnique(rows, idField, label) {
  const output = new Map()
  for (const row of rows) {
    const id = String(row?.[idField] || '')
    if (!id) throw new Error(`${label} contains a row without ${idField}`)
    if (output.has(id)) throw new Error(`${label} contains duplicate ID: ${id}`)
    output.set(id, row)
  }
  return output
}

export function compareMotifCatalogs(hierarchy, engineeringEntities) {
  const hierarchyById = indexUnique(hierarchy?.nodes || [], 'id', 'hierarchy nodes')
  const engineeringById = indexUnique(engineeringEntities?.motifs || [], 'motif_id', 'engineering motifs')
  const hierarchyIds = new Set(hierarchyById.keys())
  const engineeringIds = new Set(engineeringById.keys())
  const missingEngineering = [...hierarchyIds].filter((id) => !engineeringIds.has(id)).sort()
  const extraEngineering = [...engineeringIds].filter((id) => !hierarchyIds.has(id)).sort()
  if (missingEngineering.length || extraEngineering.length) {
    throw new Error(
      `Motif ID sets differ: missing in engineering=${missingEngineering.slice(0, 10).join(', ') || 'none'}; `
      + `extra in engineering=${extraEngineering.slice(0, 10).join(', ') || 'none'}`,
    )
  }

  for (const [id, hierarchyNode] of hierarchyById) {
    const engineeringMotif = engineeringById.get(id)
    if (String(hierarchyNode.label || '') !== String(engineeringMotif.label || '')) {
      throw new Error(`Motif label mismatch for ${id}`)
    }
    if (String(hierarchyNode.level || '') !== String(engineeringMotif.level || '')) {
      throw new Error(`Motif level mismatch for ${id}`)
    }
    if (!sameStrings(hierarchyNode.parent_ids, engineeringMotif.parent_ids)) {
      throw new Error(`Motif parent mismatch for ${id}`)
    }
  }
  return { motifs: hierarchyById.size }
}

function collectExactStringPaths(value, targets, trail = [], output = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectExactStringPaths(item, targets, [...trail, index], output))
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      collectExactStringPaths(item, targets, [...trail, key], output)
    }
  } else if (typeof value === 'string' && targets.has(value)) {
    output.push({ id: value, path: trail.join('.') })
  }
  return output
}

export function assertForbiddenIdsAbsent(payloads, forbiddenIds) {
  const targets = new Set(forbiddenIds.map(String).filter(Boolean))
  if (!targets.size) return { forbidden_ids: 0 }
  const matches = []
  for (const [label, value] of Object.entries(payloads)) {
    collectExactStringPaths(value, targets, [label], matches)
  }
  if (matches.length) {
    const preview = matches.slice(0, 10).map((item) => `${item.id} at ${item.path}`).join('; ')
    throw new Error(`Retired motif ID remains in public data: ${preview}`)
  }
  return { forbidden_ids: targets.size }
}

export function loadEngineeringShards(manifestFilename) {
  const manifest = readJson(manifestFilename)
  const directory = path.dirname(manifestFilename)
  const shards = {}
  for (const shard of manifest.shards || []) {
    if (path.basename(shard.path) !== shard.path || !shard.path.endsWith('.json.gz')) {
      throw new Error(`Unsafe engineering shard path: ${shard.path}`)
    }
    const compressed = fs.readFileSync(path.join(directory, shard.path))
    if (Number.isFinite(shard.bytes) && compressed.length !== shard.bytes) {
      throw new Error(`Engineering shard size mismatch: ${shard.path}`)
    }
    if (shard.sha256 && sha256(compressed) !== shard.sha256) {
      throw new Error(`Engineering shard checksum mismatch: ${shard.path}`)
    }
    const raw = zlib.gunzipSync(compressed)
    if (Number.isFinite(shard.uncompressed_bytes) && raw.length !== shard.uncompressed_bytes) {
      throw new Error(`Engineering shard uncompressed size mismatch: ${shard.path}`)
    }
    if (shard.content_sha256 && sha256(raw) !== shard.content_sha256) {
      throw new Error(`Engineering shard content checksum mismatch: ${shard.path}`)
    }
    shards[shard.path] = JSON.parse(raw)
  }
  const entitiesSpec = (manifest.shards || []).find((shard) => shard.target === 'entities')
  if (!entitiesSpec || !shards[entitiesSpec.path]) throw new Error('Engineering manifest has no entities shard')
  return { manifest, shards, entities: shards[entitiesSpec.path] }
}

export function validateBundleParity(hierarchyFilename, manifestFilename, forbiddenIds = []) {
  const hierarchy = readJson(hierarchyFilename)
  const engineering = loadEngineeringShards(manifestFilename)
  const catalog = compareMotifCatalogs(hierarchy, engineering.entities)
  const retired = assertForbiddenIdsAbsent(
    { hierarchy, engineering_manifest: engineering.manifest, ...engineering.shards },
    forbiddenIds,
  )
  return { ...catalog, ...retired, shards: Object.keys(engineering.shards).length }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const [hierarchyFilename, manifestFilename, ...options] = process.argv.slice(2)
  if (!hierarchyFilename || !manifestFilename) usage()
  const forbiddenIds = []
  while (options.length) {
    const option = options.shift()
    const value = options.shift()
    if (option !== '--forbid-id' || !value) usage()
    forbiddenIds.push(value)
  }
  const result = validateBundleParity(hierarchyFilename, manifestFilename, forbiddenIds)
  console.log(
    `Cross-bundle parity check passed: ${result.motifs} motifs, ${result.shards} engineering shards, `
    + `${result.forbidden_ids} retired IDs checked`,
  )
}
