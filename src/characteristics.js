function asArray(value) {
  return Array.isArray(value) ? value : []
}

function numeric(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function compactNumber(value) {
  const number = numeric(value)
  if (number === null) return ''
  const absolute = Math.abs(number)
  if ((absolute > 0 && absolute < .001) || absolute >= 100000) return number.toExponential(3)
  return String(Number(number.toPrecision(6)))
}

const COMPARATOR_SYMBOLS = {
  approximately: '≈',
  less_than: '<',
  less_than_or_equal: '≤',
  greater_than: '>',
  greater_than_or_equal: '≥',
}

/**
 * Return a value-first representation of an extracted observation.
 *
 * The source snippet remains available for provenance, but it must not hide
 * structured point, range, or bound fields when those fields are present.
 */
export function rawObservationDisplay(observation = {}) {
  const low = numeric(observation.raw_min ?? observation.raw_value_low ?? observation.value_low)
  const high = numeric(observation.raw_max ?? observation.raw_value_high ?? observation.value_high)
  const point = numeric(observation.raw_value ?? observation.value)
  const unit = String(observation.raw_unit || observation.unit || '').trim()
  const categorical = String(observation.categorical_value || '').trim()
  const snippet = String(observation.raw_value_text || observation.raw_text || '').trim()
  const sourceSnippet = String(observation.source_snippet || '').trim()
  const comparator = COMPARATOR_SYMBOLS[String(observation.comparator || '').trim()] || ''
  const suffix = unit ? ` ${unit}` : ''

  let text = ''
  if (low !== null && high !== null) {
    text = `${comparator}${compactNumber(low)}–${compactNumber(high)}${suffix}`
  } else if (point !== null) {
    const inferredComparator = comparator
      || (observation.value_kind === 'upper_bound' ? '≤' : observation.value_kind === 'lower_bound' ? '≥' : '')
    text = `${inferredComparator}${compactNumber(point)}${suffix}`
  } else if (low !== null) {
    text = `${comparator || '≥'}${compactNumber(low)}${suffix}`
  } else if (high !== null) {
    text = `${comparator || '≤'}${compactNumber(high)}${suffix}`
  }

  if (text) return { text, numeric: true, snippet: (sourceSnippet || snippet) && (sourceSnippet || snippet) !== text ? (sourceSnippet || snippet) : '' }
  if (categorical) return { text: categorical, numeric: false, snippet: sourceSnippet && sourceSnippet !== categorical ? sourceSnippet : '' }
  return { text: snippet || sourceSnippet || 'reported', numeric: false, snippet: '' }
}

export function motifAncestors(nodes = []) {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const cache = new Map()
  const ancestors = (id, visiting = new Set()) => {
    if (cache.has(id)) return cache.get(id)
    if (visiting.has(id)) return new Set()
    visiting.add(id)
    const result = new Set()
    for (const parentId of asArray(byId.get(id)?.parent_ids)) {
      if (!byId.has(parentId)) continue
      result.add(parentId)
      for (const ancestorId of ancestors(parentId, visiting)) result.add(ancestorId)
    }
    visiting.delete(id)
    cache.set(id, result)
    return result
  }
  for (const id of byId.keys()) ancestors(id)
  return cache
}

export function implementationsForMotif(motifId, characteristics, motifNodes = []) {
  if (!motifId || !characteristics) return []
  const ancestorMap = motifAncestors(motifNodes)
  return asArray(characteristics.implementations)
    .filter((implementation) => {
      const direct = asArray(implementation.direct_motif_ids || implementation.motif_ids)
      const rollup = new Set(asArray(implementation.rollup_motif_ids))
      for (const directId of direct) {
        rollup.add(directId)
        for (const ancestorId of ancestorMap.get(directId) || []) rollup.add(ancestorId)
      }
      return rollup.has(motifId)
    })
    .sort((a, b) => Number(a.year || 0) - Number(b.year || 0)
      || String(a.paper_id || '').localeCompare(String(b.paper_id || ''))
      || String(a.implementation_id || '').localeCompare(String(b.implementation_id || '')))
}

export function filterImplementationView(implementations, observations, filters = {}) {
  const yearMin = numeric(filters.yearMin)
  const yearMax = numeric(filters.yearMax)
  const category = filters.category || 'all'
  const metric = filters.metric || 'all'
  const yearEligible = asArray(implementations).filter((implementation) => {
    const year = numeric(implementation.year)
    if (yearMin !== null && (year === null || year < yearMin)) return false
    if (yearMax !== null && (year === null || year > yearMax)) return false
    return true
  })
  const eligibleIds = new Set(yearEligible.map((item) => item.implementation_id))
  let filteredObservations = asArray(observations).filter((observation) => eligibleIds.has(observation.implementation_id))
  if (category !== 'all') filteredObservations = filteredObservations.filter((item) => item.category === category)
  if (metric !== 'all') filteredObservations = filteredObservations.filter((item) => item.metric === metric)
  if (category === 'all' && metric === 'all') {
    return { implementations: yearEligible, observations: filteredObservations }
  }
  const observedIds = new Set(filteredObservations.map((item) => item.implementation_id))
  return {
    implementations: yearEligible.filter((item) => observedIds.has(item.implementation_id)),
    observations: filteredObservations,
  }
}

export function characteristicOptions(observations = [], category = 'all') {
  const categories = [...new Set(asArray(observations).map((item) => item.category).filter(Boolean))].sort()
  const metrics = [...new Set(asArray(observations)
    .filter((item) => category === 'all' || item.category === category)
    .map((item) => item.metric)
    .filter(Boolean))].sort()
  return { categories, metrics }
}

export function normalizedBounds(observation) {
  const point = numeric(observation.normalized_value)
  let minimum = numeric(observation.normalized_min ?? observation.normalized_value_low)
  let maximum = numeric(observation.normalized_max ?? observation.normalized_value_high)
  if (minimum === null && point !== null) minimum = point
  if (maximum === null && point !== null) maximum = point
  if (minimum === null && maximum !== null) minimum = maximum
  if (maximum === null && minimum !== null) maximum = minimum
  if (minimum === null || maximum === null) return null
  return { minimum: Math.min(minimum, maximum), maximum: Math.max(minimum, maximum), point: point ?? (minimum + maximum) / 2 }
}

export function normalizedObservationDisplay(observation = {}) {
  const bounds = normalizedBounds(observation)
  const unit = String(observation.normalized_unit || '').trim()
  if (!bounds || !unit) return ''
  const value = bounds.minimum === bounds.maximum
    ? compactNumber(bounds.point)
    : `${compactNumber(bounds.minimum)}–${compactNumber(bounds.maximum)}`
  const comparator = COMPARATOR_SYMBOLS[String(observation.comparator || '').trim()]
    || (observation.value_kind === 'upper_bound' ? '≤'
      : observation.value_kind === 'lower_bound' ? '≥'
        : observation.value_kind === 'approximate' ? '≈' : '')
  return `${comparator}${value} ${unit}`
}

export function selectPlotSeries(observations = [], category = 'all', metric = 'all') {
  const candidates = asArray(observations).filter((observation) => {
    if (category !== 'all' && observation.category !== category) return false
    if (metric !== 'all' && observation.metric !== metric) return false
    if (observation.plottable === false) return false
    const year = numeric(observation.year)
    return year !== null && year > 0 && Boolean(observation.normalized_unit) && normalizedBounds(observation)
  })
  const groups = new Map()
  for (const observation of candidates) {
    // Canonical properties are intentionally compact.  Keep unknown/other
    // model labels separate so unrelated quantities with the same unit are
    // never drawn as one time series.
    const specificMetric = observation.metric === 'other' ? (observation.model_metric || 'other') : ''
    const key = `${observation.category || ''}\u0000${observation.metric || ''}\u0000${specificMetric}\u0000${observation.normalized_unit || ''}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(observation)
  }
  const selected = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0]
  if (!selected) return { category: null, metric: null, unit: null, observations: [] }
  const [selectedCategory, selectedMetric, specificMetric, unit] = selected[0].split('\u0000')
  return {
    category: selectedCategory,
    metric: selectedMetric,
    displayMetric: specificMetric || selectedMetric,
    unit,
    observations: selected[1].sort((a, b) => Number(a.year || 0) - Number(b.year || 0)
      || String(a.observation_id || '').localeCompare(String(b.observation_id || ''))),
  }
}
