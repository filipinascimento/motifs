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

  assert.equal(recurrent.length, 727)
  assert.equal(allMotifs.length, 727)
  assert.equal(recurrent.filter((node) => node.level === 'L1').length, 9)
  assert.equal(devices.length, 1057)
  assert.equal(papers.length, 901)
  assert.equal(characteristics.entities.components.length, 5162)
  assert.equal(characteristics.observations.length, 4505)
  assert.equal(characteristics.observations.filter((row) => row.plottable).length, 3554)
  assert.equal(characteristics.knowledge.relationships.length, 1476)
  assert.ok(Object.values(characteristics.indexes.motifs).some((index) => index.records.relationship_ids.length))
  assert.equal(characteristics.entities.interfaces.length, 3834)
  assert.ok(devices.some((device) => device.component_ids.length && device.motif_ids.length))
  assert.ok(papers.some((paper) => paper.device_ids.length && paper.motif_ids.length))
  assert.equal(timelines.overall.length, 10)
  assert.ok(timelines.overall.every((node) => (
    Object.values(node.annual_paper_counts || {}).reduce((sum, value) => sum + Number(value), 0) > 0
  )))
  assert.ok(timelines.overall.some((node) => node.paper_count > 0 && node.component_count > 0))
})
