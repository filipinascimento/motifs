function asArray(value) {
  return Array.isArray(value) ? value : []
}

function asStrings(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== null && item !== undefined && item !== '').map(String)
  if (value === null || value === undefined || value === '') return []
  return [String(value)]
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ''))]
}

function numeric(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function yearForPaper(paper) {
  return Number(paper?.publication_year ?? paper?.year ?? 0) || 0
}

async function compressedJson(response) {
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    return JSON.parse(new TextDecoder().decode(bytes))
  }
  if (typeof DecompressionStream !== 'function') {
    throw new Error('This browser does not support gzip DecompressionStream')
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).json()
}

function setPath(root, target, value, merge) {
  const parts = target.split('.')
  let current = root
  for (const part of parts.slice(0, -1)) {
    current[part] ||= {}
    current = current[part]
  }
  const leaf = parts.at(-1)
  if (merge === 'concat') current[leaf] = [...(current[leaf] || []), ...value]
  else current[leaf] = value
}

export async function assembleEngineeringShards(manifest, manifestUrl, fetcher = globalThis.fetch) {
  if (manifest?.schema_id !== 'public-rogers-engineering-shards') {
    throw new Error('Unrecognized public engineering manifest')
  }
  const base = manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1)
  const bundle = {
    schema_id: manifest.bundle_schema_id,
    schema_version: manifest.bundle_schema_version,
    generated_at: manifest.generated_at,
    qa: { passed: manifest.bundle_qa_passed === true, counts: manifest.counts || {} },
    measurements: { accepted: [], quarantined: [], plot_points: [], ...(manifest.measurements || {}) },
    knowledge: {},
    indexes: {},
    graph: { nodes: [], edges: [] },
    public_release: manifest.public_release || {},
  }
  const values = await Promise.all((manifest.shards || []).map(async (shard) => {
    const response = await fetcher(`${base}${shard.path}`)
    if (!response.ok) throw new Error(`${shard.path}: ${response.status} ${response.statusText}`)
    const value = await compressedJson(response)
    const rows = Array.isArray(value)
      ? value.length
      : Object.values(value || {}).reduce((sum, item) => sum + (Array.isArray(item) ? item.length : 0), 0)
    if (Number(shard.rows) !== rows) throw new Error(`${shard.path}: row count mismatch`)
    return { shard, value }
  }))
  for (const { shard, value } of values) setPath(bundle, shard.target, value, shard.merge)
  if (bundle.schema_id !== 'rogers-engineering-frontend-bundle' || bundle.qa.passed !== true) {
    throw new Error('Assembled public engineering bundle failed schema or QA validation')
  }
  return bundle
}

/**
 * Prefer the public sharded manifest, then retain compatibility with a
 * monolithic engineering bundle for local/private deployments.
 */
export async function fetchEngineeringBundle(
  fetcher = globalThis.fetch,
  urls = ['./data/engineering/manifest.json', './data/frontend_engineering_bundle.json'],
) {
  const failures = []
  for (const url of urls) {
    try {
      const response = await fetcher(url)
      if (!response.ok) {
        failures.push(`${url}: ${response.status} ${response.statusText}`)
        continue
      }
      const payload = await response.json()
      const bundle = payload?.schema_id === 'public-rogers-engineering-shards'
        ? await assembleEngineeringShards(payload, url, fetcher)
        : payload
      if (bundle?.schema_id !== 'rogers-engineering-frontend-bundle') {
        failures.push(`${url}: unrecognized schema`)
        continue
      }
      return { bundle, url }
    } catch (error) {
      failures.push(`${url}: ${error?.message || error}`)
    }
  }
  throw new Error(`Engineering bundle unavailable (${failures.join('; ')})`)
}

function relationComparator(relation) {
  return ({ approx: 'approximately', lt: 'less_than', lte: 'less_than_or_equal', gt: 'greater_than', gte: 'greater_than_or_equal' })[relation] || ''
}

function valueKind(row) {
  return ({ point: 'exact', interval: 'range', categorical: 'qualitative' })[row.value_form || row.value_type]
    || row.value_form || row.value_type || ''
}

function evidenceFor(row) {
  const provenance = row.source_provenance || row.provenance || {}
  const pages = asArray(provenance.page_numbers)
  const sourceBlockIds = asArray(provenance.source_block_ids)
  // Unified schema v1 stores literal supporting_text as a string. Keep array
  // support for older bundles without discarding the schema-native value.
  const supporting = asStrings(provenance.supporting_text)
  const quote = supporting[0] || provenance.evidence_quote || row.verbatim_quote || row.original_text || ''
  return [{
    quote,
    page: pages[0] ?? provenance.source_page ?? asArray(row.source_page_numbers)[0] ?? '',
    source_block_ids: sourceBlockIds.length ? sourceBlockIds : asArray(row.source_block_ids),
  }]
}

export function observationFromEngineeringMeasurement(row = {}) {
  const valueForm = row.value_form || row.value_type || ''
  const hasNormalizationStatus = Object.prototype.hasOwnProperty.call(row, 'normalization_status')
  const normalized = hasNormalizationStatus
    ? row.normalization_status === 'normalized'
    : row.validation_status === 'accepted'
  const comparator = relationComparator(row.relation)
    || (valueForm === 'approximate' ? 'approximately' : '')
  return {
    ...row,
    observation_id: row.measurement_id || row.observation_id || row.categorical_record_id || '',
    implementation_id: row.device_variant_id || row.implementation_id || '',
    year: Number(row.publication_year ?? row.year ?? 0) || 0,
    category: row.characteristic_class || row.category || 'other',
    metric: row.characteristic_id || row.metric || 'other',
    model_metric: row.original_metric || '',
    value_kind: valueKind(row),
    comparator,
    raw_value: row.numeric_value ?? row.value ?? null,
    raw_min: row.numeric_min ?? row.lower_value ?? null,
    raw_max: row.numeric_max ?? row.upper_value ?? null,
    raw_unit: row.original_unit || row.source_unit || '',
    raw_value_text: row.categorical_value || row.raw_value_text || row.original_text || '',
    source_snippet: row.original_text || row.raw_value_text || '',
    normalized_value: normalized ? (row.normalized_value ?? row.canonical_value ?? null) : null,
    normalized_min: normalized ? (row.normalized_min ?? row.canonical_lower ?? null) : null,
    normalized_max: normalized ? (row.normalized_max ?? row.canonical_upper ?? null) : null,
    normalized_unit: normalized ? (row.canonical_unit || '') : '',
    subject_part: row.subject || row.subject_part || '',
    scope: row.scope || row.subject_scope || '',
    device_level: row.device_level === true || row.scope === 'whole_device' || row.subject_scope === 'whole_device',
    condition_text: row.condition_text || '',
    uncertainty_type: row.uncertainty_type || '',
    evidence: evidenceFor(row),
    plottable: valueForm !== 'categorical' && normalized,
  }
}

function recordCounts(records = {}) {
  return {
    accepted: asArray(records.accepted_measurement_ids).length,
    quarantined: asArray(records.quarantined_measurement_ids).length,
    relationships: asArray(records.relationship_ids).length,
    failures: asArray(records.failure_ids).length,
    constraints: asArray(records.constraint_ids).length,
    coverage: asArray(records.coverage_ids).length,
  }
}

const KNOWLEDGE_KINDS = {
  relationship: ['relationship_ids', 'relationships', 'relationship_id'],
  failure: ['failure_ids', 'failures', 'failure_constraint_id'],
  constraint: ['constraint_ids', 'constraints', 'failure_constraint_id'],
  coverage: ['coverage_ids', 'coverage', 'coverage_id'],
}

function indexedKnowledgeRows(characteristics, index, kind = 'all') {
  const records = index?.records || {}
  const knowledge = characteristics?.knowledge || {}
  const selectedKinds = kind === 'all' ? Object.keys(KNOWLEDGE_KINDS) : [kind]
  const result = []
  for (const selectedKind of selectedKinds) {
    const config = KNOWLEDGE_KINDS[selectedKind]
    if (!config) continue
    const [recordField, collectionField, idField] = config
    const ids = new Set(asArray(records[recordField]))
    for (const row of asArray(knowledge[collectionField])) {
      const identifier = String(row[idField] || '')
      if (ids.has(identifier)) result.push({ ...row, knowledge_kind: selectedKind, knowledge_id: identifier })
    }
  }
  return result
}

/**
 * Resolve schema-native knowledge for a selected motif, device, or variant.
 *
 * Index membership is authoritative: motif indexes include canonical ancestor
 * rollups, while device and variant indexes retain exact atomic endpoints.
 */
export function engineeringRecordsForSelection(characteristics, selection = {}, filters = {}) {
  if (!characteristics || characteristics.schema_id !== 'rogers-engineering-frontend-bundle') {
    return { target: null, records: [], counts: {} }
  }
  const implementation = asArray(characteristics.implementations)
    .find((row) => row.implementation_id === selection.implementationId)
  const targetType = selection.target || 'motif'
  let index = null
  let target = null
  if (targetType === 'implementation' && implementation) {
    index = characteristics.indexes?.variants?.[implementation.implementation_id]
    target = { type: 'implementation', id: implementation.implementation_id, label: implementation.implementation_name || implementation.implementation_id }
  } else if (targetType === 'device' && implementation?.device_id) {
    index = characteristics.indexes?.devices?.[implementation.device_id]
    target = { type: 'device', id: implementation.device_id, label: index?.name || implementation.device_id }
  } else if (selection.motifId) {
    index = characteristics.indexes?.motifs?.[selection.motifId]
    target = { type: 'motif', id: selection.motifId, label: index?.label || selection.motifId }
  }
  if (!index || !target) return { target, records: [], counts: {} }

  const kind = filters.kind || 'all'
  const scope = filters.scope || 'all'
  const coverageStatus = filters.coverageStatus || 'all'
  const yearMin = numeric(filters.yearMin)
  const yearMax = numeric(filters.yearMax)
  let rows = indexedKnowledgeRows(characteristics, index, kind)
  rows = rows.filter((row) => {
    const year = numeric(row.publication_year ?? row.year)
    if (yearMin !== null && (year === null || year < yearMin)) return false
    if (yearMax !== null && (year === null || year > yearMax)) return false
    if (scope === 'device_level' && row.device_level !== true) return false
    if (scope === 'component_level' && row.device_level === true) return false
    if (coverageStatus !== 'all' && (row.knowledge_kind !== 'coverage' || row.status !== coverageStatus)) return false
    return true
  }).sort((a, b) => Number(a.publication_year ?? a.year ?? 0) - Number(b.publication_year ?? b.year ?? 0)
    || String(a.paper_id || '').localeCompare(String(b.paper_id || ''))
    || a.knowledge_id.localeCompare(b.knowledge_id))

  const counts = {}
  for (const row of rows) counts[row.knowledge_kind] = (counts[row.knowledge_kind] || 0) + 1
  return { target, records: rows, counts }
}

/** Convert the atomic engineering bundle into the dated implementation view. */
export function engineeringBundleToCharacteristics(bundle = {}) {
  if (bundle.schema_id !== 'rogers-engineering-frontend-bundle') {
    throw new Error('Unrecognized engineering frontend bundle')
  }
  const entities = bundle.entities || {}
  const papers = asArray(entities.papers)
  const devices = asArray(entities.devices)
  const variants = asArray(entities.device_variants)
  const components = asArray(entities.components)
  const interfaces = asArray(entities.interfaces)
  const paperById = new Map(papers.map((row) => [row.paper_id, row]))
  const deviceById = new Map(devices.map((row) => [row.device_id, row]))
  const componentsByVariant = new Map()
  const interfacesByVariant = new Map()
  for (const component of components) {
    const rows = componentsByVariant.get(component.device_variant_id) || []
    rows.push(component)
    componentsByVariant.set(component.device_variant_id, rows)
  }
  for (const item of interfaces) {
    const rows = interfacesByVariant.get(item.device_variant_id) || []
    rows.push(item)
    interfacesByVariant.set(item.device_variant_id, rows)
  }

  const hasPlotProjection = Array.isArray(bundle.measurements?.plot_points)
  const plotIds = new Set(asArray(bundle.measurements?.plot_points).map((row) => row.measurement_id).filter(Boolean))
  const accepted = asArray(bundle.measurements?.accepted).map((row) => {
    const observation = observationFromEngineeringMeasurement(row)
    return hasPlotProjection ? { ...observation, plottable: plotIds.has(observation.observation_id) } : observation
  })
  const quarantined = asArray(bundle.measurements?.quarantined).map((row) => ({
    ...observationFromEngineeringMeasurement(row),
    plottable: false,
  }))
  const acceptedByVariant = new Map()
  for (const observation of accepted) {
    const rows = acceptedByVariant.get(observation.implementation_id) || []
    rows.push(observation)
    acceptedByVariant.set(observation.implementation_id, rows)
  }

  const implementations = variants.map((variant) => {
    const device = deviceById.get(variant.device_id) || {}
    const paper = paperById.get(variant.paper_id) || {}
    const parts = componentsByVariant.get(variant.device_variant_id) || []
    const links = interfacesByVariant.get(variant.device_variant_id) || []
    const observations = acceptedByVariant.get(variant.device_variant_id) || []
    const index = bundle.indexes?.variants?.[variant.device_variant_id] || {}
    return {
      implementation_id: variant.device_variant_id,
      device_id: variant.device_id,
      paper_id: variant.paper_id,
      year: yearForPaper(paper),
      implementation_name: variant.variant_label || device.author_provided_name || device.descriptive_name || variant.device_variant_id,
      implementation_scope: 'physical_device',
      function: device.intended_function || device.function || device.device_function || '',
      configuration_label: variant.configuration_label || '',
      direct_motif_ids: unique(parts.flatMap((row) => asArray(row.motif_ids))),
      component_ids: parts.map((row) => row.component_id),
      components: parts.map((row) => row.name || row.component_name || row.component_id),
      materials: unique(parts.flatMap((row) => asArray(row.materials).concat(row.material || []))),
      interfaces: links.map((row) => row.role || row.interface_type || row.interface_id),
      shape: unique(observations.filter((row) => row.metric === 'shape_class').map((row) => row.categorical_value || row.raw_value_text)),
      record_counts: recordCounts(index.records),
      record_ids: index.records || {},
    }
  }).sort((a, b) => a.year - b.year || a.paper_id.localeCompare(b.paper_id) || a.implementation_id.localeCompare(b.implementation_id))

  return {
    schema_id: bundle.schema_id,
    schema_version: bundle.schema_version,
    status: bundle.qa?.passed ? 'complete' : 'partial',
    public_release: bundle.public_release || null,
    entities,
    graph: bundle.graph || { nodes: [], edges: [] },
    papers,
    implementations,
    observations: accepted,
    quarantined_observations: quarantined,
    knowledge: bundle.knowledge || {},
    indexes: bundle.indexes || {},
    qa: bundle.qa || {},
    warnings: { quarantined_measurements: quarantined.length },
  }
}
