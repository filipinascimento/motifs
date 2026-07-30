import test from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { filterImplementationView, implementationsForMotif, normalizedBounds, normalizedObservationDisplay, rawObservationDisplay, selectPlotSeries } from '../src/characteristics.js'
import { assembleEngineeringShards, engineeringBundleToCharacteristics, engineeringRecordsForSelection, fetchEngineeringBundle, observationFromEngineeringMeasurement } from '../src/engineering.js'

const nodes = [
  { id: 'L1', parent_ids: [] },
  { id: 'L2', parent_ids: ['L1'] },
  { id: 'L3', parent_ids: ['L2'] },
]

const characteristics = {
  implementations: [
    { implementation_id: 'I2', paper_id: 'P2', year: 2021, direct_motif_ids: ['L2'] },
    { implementation_id: 'I1', paper_id: 'P1', year: 2019, direct_motif_ids: ['L3'] },
    { implementation_id: 'I3', paper_id: 'P3', year: 2022, direct_motif_ids: ['OTHER'] },
  ],
}

test('motif rollups preserve distinct dated implementations', () => {
  assert.deepEqual(implementationsForMotif('L1', characteristics, nodes).map((item) => item.implementation_id), ['I1', 'I2'])
  assert.deepEqual(implementationsForMotif('L3', characteristics, nodes).map((item) => item.implementation_id), ['I1'])
})

test('characteristic filters are independent and keep chronology', () => {
  const implementations = implementationsForMotif('L1', characteristics, nodes)
  const observations = [
    { observation_id: 'O1', implementation_id: 'I1', category: 'geometry_shape', metric: 'thickness' },
    { observation_id: 'O2', implementation_id: 'I2', category: 'power_electrical', metric: 'power' },
  ]
  const view = filterImplementationView(implementations, observations, { yearMin: 2020, category: 'power_electrical', metric: 'all' })
  assert.deepEqual(view.implementations.map((item) => item.implementation_id), ['I2'])
  assert.deepEqual(view.observations.map((item) => item.observation_id), ['O2'])
})

test('normalized plot chooses one comparable metric and preserves ranges', () => {
  const observations = [
    { observation_id: 'O1', year: 2019, category: 'geometry_shape', metric: 'thickness', normalized_value: 0.1, normalized_unit: 'cm' },
    { observation_id: 'O2', year: 2020, category: 'geometry_shape', metric: 'thickness', normalized_min: 0.2, normalized_max: 0.4, normalized_unit: 'cm' },
    { observation_id: 'O3', year: 2020, category: 'power_electrical', metric: 'power', normalized_value: 1, normalized_unit: 'W' },
  ]
  const series = selectPlotSeries(observations)
  assert.equal(series.metric, 'thickness')
  assert.equal(series.unit, 'cm')
  assert.equal(series.observations.length, 2)
  assert.deepEqual(normalizedBounds(observations[1]), { minimum: 0.2, maximum: 0.4, point: 0.30000000000000004 })
})

test('other properties with different original labels stay in separate plot series', () => {
  const observations = [
    { observation_id: 'O1', year: 2019, category: 'performance_output', metric: 'other', model_metric: 'mobility_uncertainty', normalized_value: 1, normalized_unit: '%' },
    { observation_id: 'O2', year: 2020, category: 'performance_output', metric: 'other', model_metric: 'mobility_uncertainty', normalized_value: 2, normalized_unit: '%' },
    { observation_id: 'O3', year: 2021, category: 'performance_output', metric: 'other', model_metric: 'yield', normalized_value: 90, normalized_unit: '%' },
  ]
  const series = selectPlotSeries(observations, 'performance_output', 'other')
  assert.equal(series.metric, 'other')
  assert.equal(series.displayMetric, 'mobility_uncertainty')
  assert.deepEqual(series.observations.map((item) => item.observation_id), ['O1', 'O2'])
})

test('structured raw numeric values take precedence over source snippets', () => {
  assert.deepEqual(
    rawObservationDisplay({ raw_value_text: 'about 5 mW under load', raw_value: 5, raw_unit: 'mW', comparator: 'approximately' }),
    { text: '≈5 mW', numeric: true, snippet: 'about 5 mW under load' },
  )
  assert.deepEqual(
    rawObservationDisplay({ raw_value_text: 'between 1 and 3 mm', raw_value_low: 1, raw_value_high: 3, raw_unit: 'mm' }),
    { text: '1–3 mm', numeric: true, snippet: 'between 1 and 3 mm' },
  )
  assert.deepEqual(
    rawObservationDisplay({ raw_value_text: 'less than 100 ms', raw_value: 100, raw_unit: 'ms', value_kind: 'upper_bound' }),
    { text: '≤100 ms', numeric: true, snippet: 'less than 100 ms' },
  )
})

test('qualitative observations retain their source text as the primary value', () => {
  assert.deepEqual(
    rawObservationDisplay({ raw_value_text: 'approximately circular', value_kind: 'qualitative' }),
    { text: 'approximately circular', numeric: false, snippet: '' },
  )
})

test('unified measurements keep numeric values, normalization, uncertainty, and device scope', () => {
  const observation = observationFromEngineeringMeasurement({
    measurement_id: 'M1', device_variant_id: 'V1', publication_year: 2024,
    characteristic_id: 'power', characteristic_class: 'power_energy', scope: 'whole_device',
    original_text: 'the system consumed 5 ± 0.2 mW', value_type: 'exact', numeric_value: 5,
    original_unit: 'mW', normalized_value: 0.005, canonical_unit: 'W', normalization_status: 'normalized',
    uncertainty_value: 0.2, uncertainty_type: 'reported_unspecified', uncertainty_unit: 'mW',
  })
  assert.equal(observation.raw_value, 5)
  assert.equal(observation.normalized_value, 0.005)
  assert.equal(observation.device_level, true)
  assert.equal(observation.uncertainty_type, 'reported_unspecified')
})

test('explicit non-normalized status cannot be promoted by accepted validation status', () => {
  const observation = observationFromEngineeringMeasurement({
    measurement_id: 'M1', publication_year: 2024, value_type: 'exact', numeric_value: 5,
    normalized_value: 0.005, canonical_unit: 'W', normalization_status: 'not_normalized',
    validation_status: 'accepted',
  })
  assert.equal(observation.normalized_value, null)
  assert.equal(observation.normalized_unit, '')
  assert.equal(observation.plottable, false)
})

test('schema-native provenance strings and approximate and bound semantics survive adaptation', () => {
  const approximate = observationFromEngineeringMeasurement({
    measurement_id: 'M1', publication_year: 2024, value_type: 'approximate', numeric_value: 5,
    original_unit: 'mW', normalized_value: 0.005, canonical_unit: 'W', normalization_status: 'normalized',
    source_provenance: { page_numbers: [3], source_block_ids: ['B3'], supporting_text: 'approximately 5 mW under load' },
  })
  assert.equal(approximate.comparator, 'approximately')
  assert.equal(approximate.evidence[0].quote, 'approximately 5 mW under load')
  assert.equal(approximate.evidence[0].page, 3)
  assert.equal(normalizedObservationDisplay(approximate), '≈0.005 W')
  assert.equal(normalizedObservationDisplay({ value_kind: 'upper_bound', normalized_value: 2, normalized_unit: 'W' }), '≤2 W')
  assert.equal(normalizedObservationDisplay({ value_kind: 'lower_bound', normalized_value: 3, normalized_unit: 'W' }), '≥3 W')
})

test('plot selection obeys bundle eligibility and excludes missing-year records', () => {
  const observations = [
    { observation_id: 'M1', year: 2024, category: 'power_energy', metric: 'power', normalized_value: 1, normalized_unit: 'W', plottable: false },
    { observation_id: 'M2', year: 0, category: 'power_energy', metric: 'power', normalized_value: 2, normalized_unit: 'W', plottable: true },
    { observation_id: 'M3', year: 2025, category: 'power_energy', metric: 'power', normalized_value: 3, normalized_unit: 'W', plottable: true },
  ]
  assert.deepEqual(selectPlotSeries(observations).observations.map((row) => row.observation_id), ['M3'])
})

test('engineering bundle exposes variants, components, shapes, and record counts', () => {
  const bundle = {
    schema_id: 'rogers-engineering-frontend-bundle', schema_version: '1.0.0', qa: { passed: true },
    entities: {
      papers: [{ paper_id: 'P1', publication_year: 2024, title: 'Paper' }],
      devices: [{ device_id: 'D1', paper_id: 'P1', author_provided_name: 'Patch', intended_function: 'sense' }],
      device_variants: [{ device_variant_id: 'V1', device_id: 'D1', paper_id: 'P1', variant_label: 'wireless patch' }],
      components: [{ component_id: 'C1', device_variant_id: 'V1', paper_id: 'P1', name: 'coil', motif_ids: ['L2'] }],
      interfaces: [{ interface_id: 'I1', device_variant_id: 'V1', paper_id: 'P1', role: 'electrical' }],
    },
    measurements: { accepted: [
      { measurement_id: 'M1', device_variant_id: 'V1', publication_year: 2024, characteristic_id: 'shape_class', characteristic_class: 'geometry', value_type: 'categorical', categorical_value: 'serpentine', normalization_status: 'not_applicable', validation_status: 'accepted' },
      { measurement_id: 'M2', device_variant_id: 'V1', publication_year: 2024, characteristic_id: 'shape_class', characteristic_class: 'geometry', value_type: 'categorical', categorical_value: 'serpentine', normalization_status: 'not_applicable', validation_status: 'accepted' },
      { measurement_id: 'M3', device_variant_id: 'V1', publication_year: 2024, characteristic_id: 'power', characteristic_class: 'power_energy', value_type: 'exact', numeric_value: 2, normalized_value: 0.002, canonical_unit: 'W', normalization_status: 'normalized' },
    ], quarantined: [], plot_points: [{ measurement_id: 'M3' }] },
    indexes: { variants: { V1: { records: { accepted_measurement_ids: ['M1'], relationship_ids: ['R1'], failure_ids: [], constraint_ids: [], coverage_ids: [], quarantined_measurement_ids: [] } } } },
    knowledge: {},
  }
  const adapted = engineeringBundleToCharacteristics(bundle)
  assert.deepEqual(adapted.implementations[0].direct_motif_ids, ['L2'])
  assert.deepEqual(adapted.implementations[0].shape, ['serpentine'])
  assert.equal(adapted.implementations[0].record_counts.relationships, 1)
  assert.equal(adapted.observations[0].raw_value_text, 'serpentine')
  assert.equal(adapted.observations.find((row) => row.observation_id === 'M1').plottable, false)
  assert.equal(adapted.observations.find((row) => row.observation_id === 'M3').plottable, true)
})

test('schema-native engineering records resolve independently for motif, device, and variant', () => {
  const records = {
    relationship_ids: ['R1'], failure_ids: ['F1'], constraint_ids: ['C1'], coverage_ids: ['CV1'],
    accepted_measurement_ids: [], quarantined_measurement_ids: [], plot_measurement_ids: [],
  }
  const bundle = {
    schema_id: 'rogers-engineering-frontend-bundle', schema_version: '1.0.0', qa: { passed: true },
    entities: {
      papers: [{ paper_id: 'P1', publication_year: 2024, title: 'Paper' }],
      devices: [{ device_id: 'D1', paper_id: 'P1', author_provided_name: 'Patch' }],
      device_variants: [{ device_variant_id: 'V1', device_id: 'D1', paper_id: 'P1', variant_label: 'wireless patch' }],
      components: [{ component_id: 'C1', device_variant_id: 'V1', paper_id: 'P1', name: 'heater', motif_ids: ['L2'] }],
      interfaces: [],
    },
    measurements: { accepted: [], quarantined: [], plot_points: [] },
    knowledge: {
      relationships: [{ relationship_id: 'R1', paper_id: 'P1', year: 2024, relationship_type: 'tradeoff', device_level: true }],
      failures: [{ failure_constraint_id: 'F1', paper_id: 'P1', year: 2024, constraint_type: 'failure_mode', device_level: false }],
      constraints: [{ failure_constraint_id: 'C1', paper_id: 'P1', year: 2024, constraint_type: 'safety', device_level: true }],
      coverage: [{ coverage_id: 'CV1', paper_id: 'P1', year: 2024, status: 'unclear', characteristic_id: 'power', device_level: false }],
    },
    indexes: {
      motifs: { L2: { motif_id: 'L2', label: 'Thermal control', records } },
      devices: { D1: { device_id: 'D1', name: 'Patch', records } },
      variants: { V1: { device_variant_id: 'V1', records } },
    },
  }
  const adapted = engineeringBundleToCharacteristics(bundle)
  const motif = engineeringRecordsForSelection(adapted, { motifId: 'L2', target: 'motif' })
  assert.equal(motif.target.label, 'Thermal control')
  assert.deepEqual(motif.records.map((row) => row.knowledge_kind), ['constraint', 'coverage', 'failure', 'relationship'])

  const device = engineeringRecordsForSelection(adapted,
    { motifId: 'L2', implementationId: 'V1', target: 'device' },
    { scope: 'device_level' })
  assert.equal(device.target.id, 'D1')
  assert.deepEqual(device.records.map((row) => row.knowledge_id), ['C1', 'R1'])

  const coverage = engineeringRecordsForSelection(adapted,
    { motifId: 'L2', implementationId: 'V1', target: 'implementation' },
    { coverageStatus: 'unclear' })
  assert.deepEqual(coverage.records.map((row) => row.knowledge_id), ['CV1'])
})

test('engineering bundle loader prefers the public manifest and falls back to monolithic JSON', async () => {
  const bundle = { schema_id: 'rogers-engineering-frontend-bundle' }
  const manifest = {
    schema_id: 'public-rogers-engineering-shards',
    bundle_schema_id: 'rogers-engineering-frontend-bundle',
    bundle_qa_passed: true,
    shards: [],
  }
  const calls = []
  const preferred = await fetchEngineeringBundle(async (url) => {
    calls.push(url)
    return { ok: true, json: async () => manifest }
  })
  assert.equal(preferred.url, './data/engineering/manifest.json')
  assert.equal(calls.length, 1)

  const fallback = await fetchEngineeringBundle(async (url) => {
    if (url.endsWith('manifest.json')) return { ok: false, status: 404, statusText: 'Not Found' }
    return { ok: true, json: async () => bundle }
  })
  assert.equal(fallback.url, './data/frontend_engineering_bundle.json')
})

test('public manifest loader decompresses and assembles ordered shards', async () => {
  const entities = { papers: [{ paper_id: 'P1' }], devices: [], device_variants: [], components: [], interfaces: [], motifs: [] }
  const first = [{ measurement_id: 'M1' }]
  const second = [{ measurement_id: 'M2' }]
  const values = new Map([
    ['./data/engineering/entities.json.gz', entities],
    ['./data/engineering/measurements-a.json.gz', first],
    ['./data/engineering/measurements-b.json.gz', second],
  ])
  const manifest = {
    schema_id: 'public-rogers-engineering-shards',
    bundle_schema_id: 'rogers-engineering-frontend-bundle',
    bundle_qa_passed: true,
    shards: [
      { path: 'entities.json.gz', target: 'entities', merge: 'replace', rows: 1 },
      { path: 'measurements-a.json.gz', target: 'measurements.accepted', merge: 'concat', rows: 1 },
      { path: 'measurements-b.json.gz', target: 'measurements.accepted', merge: 'concat', rows: 1 },
    ],
  }
  const bundle = await assembleEngineeringShards(manifest, './data/engineering/manifest.json', async (url) => {
    const body = gzipSync(Buffer.from(JSON.stringify(values.get(url))))
    return new Response(body, { status: 200 })
  })
  assert.deepEqual(bundle.entities, entities)
  assert.deepEqual(bundle.measurements.accepted.map((row) => row.measurement_id), ['M1', 'M2'])
  assert.deepEqual(bundle.measurements.quarantined, [])
})
