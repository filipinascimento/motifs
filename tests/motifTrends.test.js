import test from 'node:test'
import assert from 'node:assert/strict'
import { motifAdoptionSeries, motifCharacteristicTrends, motifTimelineGroups } from '../src/motifTrends.js'

test('adoption series includes zero years and corpus-relative share', () => {
  const series = motifAdoptionSeries(
    { annual_paper_counts: { 2021: 2 } },
    { 2020: 10, 2021: 20 },
  )
  assert.deepEqual(series, [
    { year: 2020, papers: 0, share: 0 },
    { year: 2021, papers: 2, share: 0.1 },
  ])
})

test('emerging motifs exclude overall leaders and require negligible prior share', () => {
  const corpus = { 2018: 100, 2019: 100, 2020: 100, 2021: 100, 2022: 100, 2023: 100 }
  const nodes = [
    { id: 'overall', level: 'L2', label: 'Overall', paper_count: 100, annual_paper_counts: { 2023: 20 } },
    { id: 'emerging', level: 'L2', label: 'Emerging', paper_count: 20, annual_paper_counts: { 2022: 8, 2023: 12 } },
    { id: 'old', level: 'L2', label: 'Old', paper_count: 19, annual_paper_counts: { 2018: 3, 2023: 16 } },
  ]
  const groups = motifTimelineGroups(nodes, corpus, {
    top_n: 1,
    recent_year_window: 2,
    prior_share_max_exclusive: 0.01,
  })
  assert.deepEqual(groups.overall.map((node) => node.id), ['overall'])
  assert.deepEqual(groups.emerging.map((node) => node.id), ['emerging'])
  assert.equal(groups.recentStart, 2022)
})

test('characteristic trends merge category partitions while preserving unit compatibility', () => {
  const nodes = [{ id: 'M', parent_ids: [] }]
  const implementations = Array.from({ length: 11 }, (_, index) => ({
    implementation_id: `I${index}`,
    device_id: `D${index}`,
    direct_motif_ids: ['M'],
  }))
  const observations = [
    ...Array.from({ length: 11 }, (_, index) => ({
      observation_id: `O${index}`,
      implementation_id: `I${index}`,
      device_id: `D${index}`,
      year: 2010 + index,
      category: index < 6 ? 'geometry' : 'fabrication',
      metric: 'thickness',
      normalized_value: index + 1,
      normalized_unit: 'cm',
      plottable: true,
    })),
    {
      observation_id: 'wrong-unit',
      implementation_id: 'I0',
      device_id: 'D0',
      year: 2020,
      category: 'geometry',
      metric: 'thickness',
      normalized_value: 1,
      normalized_unit: 'm',
      plottable: true,
    },
  ]
  const result = motifCharacteristicTrends('M', { implementations, observations }, nodes)
  assert.equal(result.deviceCount, 11)
  assert.equal(result.series.length, 1)
  assert.equal(result.series[0].unit, 'cm')
  assert.equal(result.series[0].observationCount, 11)
  assert.equal(result.series[0].category, 'combined')
  assert.deepEqual(result.series[0].categories, ['fabrication', 'geometry'])
  assert.deepEqual(result.series[0].categoryCounts, { geometry: 6, fabrication: 5 })
  assert.equal(result.series[0].scopes.length, 1)
  assert.equal(result.series[0].scopes[0].scope, 'unspecified')
  assert.equal(result.series[0].scopes[0].observationCount, 11)
})

test('characteristic trends preserve comparable scope partitions', () => {
  const nodes = [{ id: 'M', parent_ids: [] }]
  const implementations = Array.from({ length: 12 }, (_, index) => ({
    implementation_id: `I${index}`,
    device_id: `D${index}`,
    direct_motif_ids: ['M'],
  }))
  const observations = Array.from({ length: 12 }, (_, index) => ({
    observation_id: `O${index}`,
    implementation_id: `I${index}`,
    device_id: `D${index}`,
    year: 2010 + index,
    category: 'geometry',
    metric: 'thickness',
    normalized_value: index + 1,
    normalized_unit: 'cm',
    scope: index < 8 ? 'component' : 'whole_device',
    plottable: true,
  }))
  const result = motifCharacteristicTrends('M', { implementations, observations }, nodes)
  assert.deepEqual(result.series[0].scopes.map((scope) => [scope.scope, scope.observationCount, scope.deviceCount]), [
    ['component', 8, 8],
    ['whole_device', 4, 4],
  ])
})
