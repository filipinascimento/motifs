import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { assembleEngineeringShards, engineeringBundleToCharacteristics } from '../src/engineering.js'
import { deviceCatalog, motifResults, paperCatalog } from '../src/explorerData.js'
import { motifTimelineGroups } from '../src/motifTrends.js'

const publicData = new URL('../public/data/', import.meta.url)

test('published release keeps motifs, papers, devices, components, metrics, and adoption aligned', async () => {
  const atlas = JSON.parse(await readFile(new URL('hierarchical_motifs.json', publicData), 'utf8'))
  const manifestUrl = new URL('engineering/manifest.json', publicData)
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'))
  const bundle = await assembleEngineeringShards(manifest, manifestUrl.href, async (url) => {
    try {
      return new Response(await readFile(fileURLToPath(url)), { status: 200 })
    } catch {
      return new Response(null, { status: 404, statusText: 'Not Found' })
    }
  })
  const characteristics = engineeringBundleToCharacteristics(bundle)
  const recurrent = motifResults(atlas.nodes, { registry: 'recurrent' })
  const allMotifs = motifResults(atlas.nodes, { registry: 'all' })
  const devices = deviceCatalog(characteristics, atlas.nodes)
  const papers = paperCatalog(characteristics, atlas.nodes, devices)
  const timelines = motifTimelineGroups(recurrent, atlas.corpus_papers_by_year, atlas.timeline_policy)

  assert.equal(recurrent.length, 590)
  assert.equal(allMotifs.length, 1401)
  assert.equal(recurrent.some((node) => node.level === 'L1'), false)
  assert.equal(devices.length, 1008)
  assert.equal(papers.length, 901)
  assert.equal(characteristics.entities.components.length, 2513)
  assert.equal(characteristics.observations.length, 4170)
  assert.equal(characteristics.observations.filter((row) => row.plottable).length, 2956)
  assert.equal(characteristics.knowledge.relationships.length, 1902)
  assert.ok(Object.values(characteristics.indexes.motifs).some((index) => index.records.relationship_ids.length))
  assert.ok(characteristics.entities.components.some((row) => row.interface_terms?.length))
  assert.ok(devices.some((device) => device.component_ids.length && device.motif_ids.length))
  assert.ok(papers.some((paper) => paper.device_ids.length && paper.motif_ids.length))
  assert.equal(timelines.overall.length, 10)
  assert.ok(timelines.overall.every((node) => (
    Object.values(node.annual_paper_counts || {}).reduce((sum, value) => sum + Number(value), 0) > 0
  )))
  assert.ok(timelines.overall.some((node) => node.device_count > 0 && node.component_count > 0))
})
