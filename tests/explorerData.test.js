import assert from 'node:assert/strict'
import test from 'node:test'
import {
  componentsForDevice,
  deviceCatalog,
  deviceResults,
  edgeCategory,
  familyForMotif,
  filterEdgesByCategory,
  measurementsForDevice,
  motifResults,
  paperCatalog,
  paperResults,
} from '../src/explorerData.js'

const motifs = [
  { id: 'family', label: 'Sensing', level: 'L1', paper_count: 5, family_ids: [] },
  { id: 'wireless', label: 'Wireless power', level: 'L2', paper_count: 4, family_ids: ['family'], aliases: ['inductive power'] },
  { id: 'strain', label: 'Strain sensor', level: 'L3', paper_count: 2, family_ids: ['family'] },
]

const characteristics = {
  papers: [
    { paper_id: 'p1', title: 'wirelessfile', citation: 'A wireless device (Rogers et al., 2024)', publication_year: 2024, doi: '10.1/example' },
    { paper_id: 'p2', title: 'Stretchable sensing', publication_year: 2020 },
  ],
  indexes: {
    devices: {
      d1: { device_id: 'd1', name: 'Skin patch', paper_id: 'p1', year: 2024, direct_motif_ids: ['family', 'wireless'], variant_ids: ['v1'], component_ids: ['c1'], interface_ids: [], records: { accepted_measurement_ids: ['m1'] } },
      d2: { device_id: 'd2', name: 'Strain platform', paper_id: 'p2', year: 2020, direct_motif_ids: ['strain'], variant_ids: ['v2'], component_ids: [], interface_ids: [], records: {} },
    },
    papers: {
      p1: { paper_id: 'p1', year: 2024, device_ids: ['d1'], records: { accepted_measurement_ids: ['m1'] } },
      p2: { paper_id: 'p2', year: 2020, device_ids: ['d2'], records: {} },
    },
  },
  entities: {
    devices: [{ device_id: 'd1', intended_function: 'continuous monitoring', application: 'skin' }],
    components: [{ component_id: 'c1', device_variant_id: 'v1', component_name: 'antenna' }],
  },
  implementations: [{ implementation_id: 'v1', device_id: 'd1' }],
  observations: [{ observation_id: 'm1', device_id: 'd1', characteristic_name: 'thickness', year: 2024 }],
}

test('motif explorer filters by level, family, aliases, and ranks by paper count', () => {
  assert.equal(familyForMotif(motifs[1]), 'family')
  assert.deepEqual(motifResults(motifs, { family: 'family', level: 'L2' }).map((row) => row.id), ['wireless'])
  assert.deepEqual(motifResults(motifs, { query: 'inductive' }).map((row) => row.id), ['wireless'])
  assert.deepEqual(motifResults(motifs, { query: 'wireless', searchField: 'name' }).map((row) => row.id), ['wireless'])
  assert.deepEqual(motifResults(motifs, { query: 'inductive', searchField: 'name' }), [])
  assert.deepEqual(motifResults(motifs, { query: 'inductive', searchField: 'aliases' }).map((row) => row.id), ['wireless'])
})

test('device explorer excludes organizing L1 motifs and searches paper and function fields', () => {
  const devices = deviceCatalog(characteristics, motifs)
  assert.deepEqual(devices.find((row) => row.id === 'd1').motif_ids, ['wireless'])
  assert.equal(devices.find((row) => row.id === 'd1').paper_title, 'A wireless device')
  assert.deepEqual(deviceResults(devices, 'continuous').map((row) => row.id), ['d1'])
  assert.deepEqual(deviceResults(devices, 'stretchable').map((row) => row.id), ['d2'])
  assert.deepEqual(deviceResults(devices, 'wireless', 'title').map((row) => row.id), ['d1'])
  assert.deepEqual(deviceResults(devices, 'continuous', 'title'), [])
})

test('paper explorer derives motifs through devices and supports DOI and motif search', () => {
  const devices = deviceCatalog(characteristics, motifs)
  const papers = paperCatalog(characteristics, motifs, devices)
  assert.deepEqual(papers.find((row) => row.id === 'p1').motif_ids, ['wireless'])
  assert.deepEqual(paperResults(papers, 'wireless').map((row) => row.id), ['p1'])
  assert.deepEqual(paperResults(papers, '10.1/example').map((row) => row.id), ['p1'])
  assert.deepEqual(paperResults(papers, 'skin patch', 'devices').map((row) => row.id), ['p1'])
  assert.deepEqual(paperResults(papers, 'wireless', 'motifs').map((row) => row.id), ['p1'])
  assert.deepEqual(paperResults(papers, '10.1/example', 'title'), [])
})

test('device details resolve only the selected device measurements and components', () => {
  assert.deepEqual(measurementsForDevice(characteristics, 'd1').map((row) => row.observation_id), ['m1'])
  assert.deepEqual(componentsForDevice(characteristics, 'd1').map((row) => row.component_id), ['c1'])
  assert.deepEqual(measurementsForDevice(characteristics, 'd2'), [])
})

test('network edges can be filtered by their visible relationship category', () => {
  const edges = [
    { id: 'e1', group: 'parent_of', type: 'parent_of' },
    { id: 'e2', group: 'used_with', type: 'used_with' },
    { id: 'e3', type: 'similarity' },
  ]
  assert.equal(edgeCategory(edges[2]), 'similarity')
  assert.deepEqual(filterEdgesByCategory(edges, ['parent_of', 'similarity']).map((edge) => edge.id), ['e1', 'e3'])
  assert.deepEqual(filterEdgesByCategory(edges, []), [])
  assert.equal(filterEdgesByCategory(edges, null).length, 3)
})
