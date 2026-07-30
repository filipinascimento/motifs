import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import zlib from 'node:zlib'

import {
  assertForbiddenIdsAbsent,
  compareMotifCatalogs,
  validateBundleParity,
} from '../scripts/check_bundle_parity.mjs'

const hierarchy = {
  nodes: [
    { id: 'L1-communication', label: 'Communication', level: 'L1', parent_ids: [] },
    { id: 'L2-bluetooth', label: 'Bluetooth telemetry', level: 'L2', parent_ids: ['L1-communication'] },
  ],
}

const entities = {
  motifs: [
    { motif_id: 'L1-communication', label: 'Communication', level: 'L1', parent_ids: [] },
    { motif_id: 'L2-bluetooth', label: 'Bluetooth telemetry', level: 'L2', parent_ids: ['L1-communication'] },
  ],
  components: [{ component_id: 'C1', motif_ids: ['L2-bluetooth'] }],
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function writeFixture(directory, engineeringEntities = entities) {
  fs.writeFileSync(path.join(directory, 'hierarchy.json'), JSON.stringify(hierarchy))
  const raw = Buffer.from(JSON.stringify(engineeringEntities))
  const compressed = zlib.gzipSync(raw)
  fs.writeFileSync(path.join(directory, 'entities.json.gz'), compressed)
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
    shards: [{
      path: 'entities.json.gz',
      target: 'entities',
      bytes: compressed.length,
      uncompressed_bytes: raw.length,
      sha256: sha256(compressed),
      content_sha256: sha256(raw),
    }],
  }))
}

test('catalog parity requires the same IDs, labels, levels, and parents', () => {
  assert.deepEqual(compareMotifCatalogs(hierarchy, entities), { motifs: 2 })
  assert.throws(
    () => compareMotifCatalogs(hierarchy, {
      ...entities,
      motifs: entities.motifs.map((row) => row.motif_id === 'L2-bluetooth' ? { ...row, label: 'Wrong' } : row),
    }),
    /label mismatch/,
  )
})

test('retired IDs are rejected anywhere in nested public payloads', () => {
  assert.deepEqual(assertForbiddenIdsAbsent({ entities }, ['L2-retired']), { forbidden_ids: 1 })
  assert.throws(
    () => assertForbiddenIdsAbsent({ entities: { ...entities, components: [{ motif_ids: ['L2-retired'] }] } }, ['L2-retired']),
    /Retired motif ID remains/,
  )
})

test('manifest-backed parity validates compressed engineering shards', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'motif-parity-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  writeFixture(directory)
  assert.deepEqual(
    validateBundleParity(
      path.join(directory, 'hierarchy.json'),
      path.join(directory, 'manifest.json'),
      ['L2-retired'],
    ),
    { motifs: 2, forbidden_ids: 1, shards: 1 },
  )
})
