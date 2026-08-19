import { implementationsForMotif, motifAncestors, normalizedBounds } from './characteristics.js'

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function numeric(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function adoptionYears(corpusPapersByYear = {}) {
  return Object.keys(corpusPapersByYear)
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
}

export function motifAdoptionSeries(node = {}, corpusPapersByYear = {}) {
  return adoptionYears(corpusPapersByYear).map((year) => {
    const papers = Number(node.annual_paper_counts?.[year] || 0)
    const corpusPapers = Number(corpusPapersByYear[year] || 0)
    return {
      year,
      papers,
      share: corpusPapers ? papers / corpusPapers : 0,
    }
  })
}

/**
 * Rank established and emerging motifs for the adoption overview.
 *
 * L1 families are organizational rollups, so L2/L3 motifs take precedence
 * whenever any are present. Emerging motifs exclude the overall leaders and
 * must account for less than 1% of all papers before the recent window.
 */
export function motifTimelineGroups(nodes = [], corpusPapersByYear = {}, policy = {}) {
  const years = adoptionYears(corpusPapersByYear)
  if (!years.length) return { years, overall: [], emerging: [], recentStart: null }

  const topN = Number(policy.top_n || 10)
  const recentWindow = Number(policy.recent_year_window || 5)
  const priorShareLimit = Number(policy.prior_share_max_exclusive ?? 0.01)
  const recentStart = years.at(-1) - recentWindow + 1
  const available = asArray(nodes).filter((node) => !node.pending)
  const detailed = available.filter((node) => node.level !== 'L1')
  const candidates = detailed.length ? detailed : available

  const overall = candidates.slice()
    .sort((a, b) => Number(b.paper_count || 0) - Number(a.paper_count || 0)
      || String(a.label || '').localeCompare(String(b.label || '')))
    .slice(0, topN)
  const overallIds = new Set(overall.map((node) => node.id))
  const priorYears = years.filter((year) => year < recentStart)
  const recentYears = years.filter((year) => year >= recentStart)
  const priorPapers = priorYears.reduce((sum, year) => sum + Number(corpusPapersByYear[year] || 0), 0)
  const recentPapers = recentYears.reduce((sum, year) => sum + Number(corpusPapersByYear[year] || 0), 0)

  const emerging = candidates
    .filter((node) => !overallIds.has(node.id))
    .map((node) => {
      const priorCount = priorYears.reduce((sum, year) => sum + Number(node.annual_paper_counts?.[year] || 0), 0)
      const recentCount = recentYears.reduce((sum, year) => sum + Number(node.annual_paper_counts?.[year] || 0), 0)
      return {
        node,
        priorShare: priorPapers ? priorCount / priorPapers : 0,
        recentShare: recentPapers ? recentCount / recentPapers : 0,
        recentCount,
      }
    })
    .filter((item) => item.priorShare < priorShareLimit && item.recentCount > 0)
    .sort((a, b) => b.recentShare - a.recentShare
      || b.recentCount - a.recentCount
      || String(a.node.label || '').localeCompare(String(b.node.label || '')))
    .slice(0, topN)
    .map((item) => item.node)

  return { years, overall, emerging, recentStart }
}

function seriesIdentity(observation = {}) {
  const metric = observation.metric || 'other'
  const specificMetric = metric === 'other' ? (observation.model_metric || 'other') : ''
  return [
    metric,
    specificMetric,
    observation.normalized_unit || '',
  ]
}

/**
 * Return comparable, normalized characteristic series for a motif.
 *
 * Measurements are restricted to implementations carrying the motif (or a
 * descendant for rollups). Series with different canonical units or property
 * identities remain separate.
 */
export function motifCharacteristicTrends(
  motifId,
  characteristics,
  motifNodes = [],
  { minDevicesExclusive = 2, minObservationsExclusive = 2 } = {},
) {
  if (!motifId || !characteristics) return { deviceCount: 0, series: [] }
  const implementations = implementationsForMotif(motifId, characteristics, motifNodes)
  const deviceIds = new Set(implementations.map((item) => item.device_id).filter(Boolean))
  const implementationIds = new Set(implementations.map((item) => item.implementation_id).filter(Boolean))
  const ancestorMap = motifAncestors(motifNodes)
  const scopedMotifIds = new Set([motifId])
  for (const node of asArray(motifNodes)) {
    if (ancestorMap.get(node.id)?.has(motifId)) scopedMotifIds.add(node.id)
  }
  const directMotifObservations = asArray(characteristics.observations)
    .filter((item) => item.motif_id && scopedMotifIds.has(item.motif_id))
  if (deviceIds.size <= minDevicesExclusive && directMotifObservations.length <= minObservationsExclusive) {
    return { deviceCount: deviceIds.size, series: [] }
  }

  const groups = new Map()
  for (const observation of asArray(characteristics.observations)) {
    if (!implementationIds.has(observation.implementation_id)
      && !(observation.motif_id && scopedMotifIds.has(observation.motif_id))) continue
    if (observation.plottable === false || !observation.normalized_unit) continue
    const year = numeric(observation.year)
    const bounds = normalizedBounds(observation)
    if (year === null || year <= 0 || !bounds) continue
    const identity = seriesIdentity(observation)
    const key = identity.map((value) => encodeURIComponent(value)).join('|')
    if (!groups.has(key)) groups.set(key, { identity, observations: [] })
    groups.get(key).observations.push({ ...observation, bounds })
  }

  const series = [...groups.entries()]
    .filter(([, group]) => group.observations.length > minObservationsExclusive)
    .map(([key, group]) => {
      const [metric, specificMetric, unit] = group.identity
      const observations = group.observations.sort((a, b) => Number(a.year) - Number(b.year)
        || String(a.observation_id || '').localeCompare(String(b.observation_id || '')))
      const categoryCounts = observations.reduce((counts, observation) => {
        const category = observation.category || 'other'
        counts[category] = (counts[category] || 0) + 1
        return counts
      }, {})
      const categories = Object.keys(categoryCounts).sort()
      const scopes = [...observations.reduce((groups, observation) => {
        const scope = observation.scope || 'unspecified'
        if (!groups.has(scope)) groups.set(scope, [])
        groups.get(scope).push(observation)
        return groups
      }, new Map()).entries()]
        .map(([scope, scopeObservations]) => ({
          scope,
          observationCount: scopeObservations.length,
          deviceCount: new Set(scopeObservations.map((item) => item.device_id).filter(Boolean)).size,
          observations: scopeObservations,
        }))
        .sort((a, b) => b.observationCount - a.observationCount
          || b.deviceCount - a.deviceCount
          || a.scope.localeCompare(b.scope))
      return {
        key,
        category: categories.length === 1 ? categories[0] : 'combined',
        categories,
        categoryCounts,
        metric,
        displayMetric: specificMetric || metric,
        unit,
        observationCount: observations.length,
        deviceCount: new Set(observations.map((item) => item.device_id).filter(Boolean)).size,
        observations,
        scopes,
      }
    })
    .sort((a, b) => b.observationCount - a.observationCount
      || b.deviceCount - a.deviceCount
      || a.key.localeCompare(b.key))

  return { deviceCount: deviceIds.size, series }
}
