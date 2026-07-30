import './style.css'
import HeliosNetwork, { AttributeType } from 'helios-network'
import { EVENTS, Helios } from 'helios-web'
import { characteristicOptions, filterImplementationView, implementationsForMotif, normalizedBounds, normalizedObservationDisplay, rawObservationDisplay, selectPlotSeries } from './characteristics.js'
import { engineeringBundleToCharacteristics, engineeringRecordsForSelection, fetchEngineeringBundle } from './engineering.js'
import { networkEntityDetail, projectedEntityNetwork, sharedMotifLabels } from './networkViews.js'
import { matchesObservationSearch, matchesPrimarySearch, matchesSearch, matchingSearchFields, searchRelevance } from './search.js'

const CATEGORY10 = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf']
const EDGE_GROUPS = [
  ['parent_of', 'Hierarchy'],
  ['used_with', 'Used with'],
  ['similarity', 'Similarity'],
  ['lifecycle', 'Lifecycle'],
]

const state = {
  data: null,
  characteristicData: null,
  query: '',
  levels: new Set(['L1', 'L2', 'L3']),
  family: 'all',
  edgeGroups: new Set(EDGE_GROUPS.map(([id]) => id)),
  selectedNode: null,
  selectedEdge: null,
  selectedNetworkNode: null,
  selectedNetworkEdge: null,
  networkView: 'motif',
  networkMinShared: 2,
  networkMaxNodes: 250,
  networkTopK: 8,
  networkMode: '2d',
  showNetworkLabels: true,
  characteristicCategory: 'all',
  characteristicMetric: 'all',
  characteristicScope: 'all',
  characteristicYearMin: '',
  characteristicYearMax: '',
  selectedImplementation: null,
  implementationCardLimit: 120,
  engineeringTarget: 'motif',
  engineeringKind: 'all',
  engineeringScope: 'all',
  engineeringCoverageStatus: 'all',
  engineeringRecordLimit: 60,
}

const app = document.querySelector('#app')
let networkRenderVersion = 0
let networkRuntime = null
let searchRenderTimer = null

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char])
}

function familyFor(node) {
  if (node.level === 'L1') return node.id
  return node.family_ids?.[0] || 'unassigned'
}

function familyLabel(familyId) {
  return state.data.nodes.find((node) => node.id === familyId)?.label || 'Unassigned'
}

function familyColor(familyId) {
  const families = state.data.nodes.filter((node) => node.level === 'L1').map((node) => node.id)
  const index = Math.max(0, families.indexOf(familyId))
  return CATEGORY10[index % CATEGORY10.length]
}

function formatCount(value) {
  return value === null || value === undefined || value === '' ? 'Pending' : Number(value).toLocaleString()
}

function yearRange(node) {
  if (!node.first_year) return 'Pending'
  return node.first_year === node.last_year ? String(node.first_year) : `${node.first_year}–${node.last_year}`
}

function filteredNodes() {
  const candidates = state.data.nodes.filter((node) => {
    if (!state.levels.has(node.level)) return false
    if (state.family !== 'all' && familyFor(node) !== state.family && node.id !== state.family) return false
    return true
  })
  if (!state.query.trim()) return candidates
  const primary = candidates.filter((node) => matchesPrimarySearch(node, state.query))
  const matches = primary.length ? primary : candidates.filter((node) => matchesSearch(node, state.query))
  return matches.sort((a, b) => searchRelevance(b, state.query) - searchRelevance(a, state.query) || a.label.localeCompare(b.label))
}

function timelineGroups() {
  const denominators = state.data.corpus_papers_by_year || {}
  const years = Object.keys(denominators).map(Number).sort((a, b) => a - b)
  if (!years.length) return { years, overall: [], emerging: [], recentStart: null }
  const policy = state.data.timeline_policy || {}
  const topN = Number(policy.top_n || 10)
  const recentStart = years.at(-1) - Number(policy.recent_year_window || 5) + 1
  const visibleCandidates = filteredNodes().filter((node) => !node.pending)
  // L1 nodes are organizing families, not Lego pieces. When any L2/L3 nodes
  // are visible, rank those building blocks for the top/emerging timelines;
  // an explicit L1-only filter still produces family-level timelines.
  const detailedCandidates = visibleCandidates.filter((node) => node.level !== 'L1')
  const candidates = detailedCandidates.length ? detailedCandidates : visibleCandidates
  const overall = [...candidates]
    .sort((a, b) => Number(b.paper_count || 0) - Number(a.paper_count || 0) || a.label.localeCompare(b.label))
    .slice(0, topN)
  const overallIds = new Set(overall.map((node) => node.id))
  const priorPapers = years.filter((year) => year < recentStart).reduce((sum, year) => sum + Number(denominators[year] || 0), 0)
  const recentPapers = years.filter((year) => year >= recentStart).reduce((sum, year) => sum + Number(denominators[year] || 0), 0)
  const emerging = candidates
    .filter((node) => !overallIds.has(node.id))
    .map((node) => {
      const counts = node.annual_paper_counts || {}
      const priorCount = years.filter((year) => year < recentStart).reduce((sum, year) => sum + Number(counts[year] || 0), 0)
      const recentCount = years.filter((year) => year >= recentStart).reduce((sum, year) => sum + Number(counts[year] || 0), 0)
      return { node, priorShare: priorPapers ? priorCount / priorPapers : 0, recentShare: recentPapers ? recentCount / recentPapers : 0, recentCount }
    })
    .filter((item) => item.priorShare < Number(policy.prior_share_max_exclusive ?? 0.01) && item.recentCount > 0)
    .sort((a, b) => b.recentShare - a.recentShare || b.recentCount - a.recentCount || a.node.label.localeCompare(b.node.label))
    .slice(0, topN)
    .map((item) => item.node)
  return { years, overall, emerging, recentStart }
}

function timelineChartMarkup(id, title, nodes, years, relative) {
  if (!nodes.length) return `<article class="timeline-card"><h3>${escapeHtml(title)}</h3><p class="timeline-empty">No motifs meet this definition yet.</p></article>`
  const width = 850; const height = 330
  const margin = { left: 54, right: 18, top: 20, bottom: 43 }
  const plotWidth = width - margin.left - margin.right
  const plotHeight = height - margin.top - margin.bottom
  const denominator = state.data.corpus_papers_by_year || {}
  const values = nodes.flatMap((node) => years.map((year) => {
    const count = Number(node.annual_paper_counts?.[year] || 0)
    return relative ? (Number(denominator[year]) ? 100 * count / Number(denominator[year]) : 0) : count
  }))
  const maxValue = Math.max(1, ...values)
  const x = (year) => margin.left + (years.length === 1 ? plotWidth / 2 : (year - years[0]) * plotWidth / (years.at(-1) - years[0]))
  const y = (value) => margin.top + plotHeight - value * plotHeight / maxValue
  const ticks = [0, .25, .5, .75, 1].map((fraction) => ({ value: maxValue * fraction, y: y(maxValue * fraction) }))
  const xTicks = years.filter((year, index) => index === 0 || index === years.length - 1 || year % 5 === 0)
  const lines = nodes.map((node, index) => {
    const points = years.map((year) => {
      const count = Number(node.annual_paper_counts?.[year] || 0)
      const value = relative ? (Number(denominator[year]) ? 100 * count / Number(denominator[year]) : 0) : count
      return `${x(year).toFixed(1)},${y(value).toFixed(1)}`
    }).join(' ')
    return `<polyline class="timeline-line" data-timeline-node="${node.id}" points="${points}" style="--series-color:${CATEGORY10[index % CATEGORY10.length]}"><title>${escapeHtml(node.label)}</title></polyline>`
  }).join('')
  return `<article class="timeline-card"><h3>${escapeHtml(title)}</h3>
    <svg class="timeline-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}">
      ${ticks.map((tick) => `<line class="grid-line" x1="${margin.left}" x2="${width - margin.right}" y1="${tick.y}" y2="${tick.y}"/><text class="axis-label" x="${margin.left - 8}" y="${tick.y + 4}" text-anchor="end">${relative ? tick.value.toFixed(tick.value < 10 ? 1 : 0) + '%' : Math.round(tick.value)}</text>`).join('')}
      ${xTicks.map((year) => `<text class="axis-label" x="${x(year)}" y="${height - 15}" text-anchor="middle">${year}</text>`).join('')}
      ${lines}
    </svg>
    <div class="timeline-legend">${nodes.map((node, index) => `<button type="button" data-timeline-node="${node.id}" style="--series-color:${CATEGORY10[index % CATEGORY10.length]}"><span></span>${escapeHtml(node.label)}</button>`).join('')}</div>
  </article>`
}

function timelinesMarkup() {
  const { years, overall, emerging, recentStart } = timelineGroups()
  if (!years.length) return `<section class="timelines"><div class="section-heading"><div><p class="eyebrow">Usage through time</p><h2>Motif timelines</h2></div></div><p class="timeline-empty">Yearly usage becomes available after corpus consolidation.</p></section>`
  return `<section class="timelines" aria-labelledby="timeline-title">
    <div class="section-heading"><div><p class="eyebrow">Usage through time</p><h2 id="timeline-title">Motif timelines</h2></div><p>Timelines follow the active level, family, and search filters; L2/L3 building blocks take precedence when visible. Emerging = outside the filtered top 10, &lt;1% of pre-${recentStart} papers, ranked over ${recentStart}–${years.at(-1)}.</p></div>
    <div class="timeline-measure"><h3>Absolute usage <span>papers per year</span></h3><div class="timeline-grid">${timelineChartMarkup('absolute-overall', 'Top 10 in current view', overall, years, false)}${timelineChartMarkup('absolute-emerging', 'Emerging in current view', emerging, years, false)}</div></div>
    <div class="timeline-measure"><h3>Relative usage <span>share of corpus papers that year</span></h3><div class="timeline-grid">${timelineChartMarkup('relative-overall', 'Top 10 in current view', overall, years, true)}${timelineChartMarkup('relative-emerging', 'Emerging in current view', emerging, years, true)}</div></div>
  </section>`
}

function displayLabel(value = '') {
  return String(value || '').replaceAll('_', ' ')
}

function doiUrl(value = '') {
  const doi = String(value).trim()
  return /^10\.\d{4,9}\//u.test(doi) ? `https://doi.org/${encodeURI(doi)}` : ''
}

function formatNumber(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  const absolute = Math.abs(number)
  if ((absolute > 0 && absolute < .001) || absolute >= 100000) return number.toExponential(3)
  return Number(number.toPrecision(5)).toLocaleString()
}

function implementationEvidence(observation) {
  const evidence = Array.isArray(observation?.evidence) ? observation.evidence[0] : null
  return {
    quote: evidence?.quote || observation?.quote || '',
    page: evidence?.page || observation?.page || '',
    sourceBlockIds: evidence?.source_block_ids || observation?.source_block_ids || [],
  }
}

function normalizedValue(observation) {
  return normalizedObservationDisplay(observation)
}

function selectedImplementationData() {
  if (!state.selectedNode || !state.characteristicData) return { motif: null, allImplementations: [], allObservations: [], implementations: [], observations: [] }
  const motif = state.data.nodes.find((node) => node.id === state.selectedNode)
  const allImplementations = implementationsForMotif(state.selectedNode, state.characteristicData, state.data.nodes)
  const implementationIds = new Set(allImplementations.map((item) => item.implementation_id))
  const allObservations = (state.characteristicData.observations || []).filter((item) => implementationIds.has(item.implementation_id))
  const filtered = filterImplementationView(allImplementations, allObservations, {
    yearMin: state.characteristicYearMin,
    yearMax: state.characteristicYearMax,
    category: state.characteristicCategory,
    metric: state.characteristicMetric,
  })
  if (state.characteristicScope !== 'all') {
    filtered.observations = filtered.observations.filter((item) => state.characteristicScope === 'device_level' ? item.device_level : item.scope === state.characteristicScope)
    const observedIds = new Set(filtered.observations.map((item) => item.implementation_id))
    filtered.implementations = filtered.implementations.filter((item) => observedIds.has(item.implementation_id))
  }
  return { motif, allImplementations, allObservations, ...filtered }
}

function characteristicPlotMarkup(observations) {
  const series = selectPlotSeries(observations, state.characteristicCategory, state.characteristicMetric)
  if (!series.observations.length) return `<article class="characteristic-plot-card"><h3>Normalized value by year</h3><p class="implementation-empty">No normalized numeric observations meet these filters.</p></article>`
  const width = 980; const height = 340
  const margin = { left: 80, right: 22, top: 30, bottom: 48 }
  const plotWidth = width - margin.left - margin.right
  const plotHeight = height - margin.top - margin.bottom
  const years = series.observations.map((item) => Number(item.year)).filter(Number.isFinite)
  const minYear = Math.min(...years); const maxYear = Math.max(...years)
  const bounds = series.observations.map(normalizedBounds)
  let minValue = Math.min(...bounds.map((item) => item.minimum)); let maxValue = Math.max(...bounds.map((item) => item.maximum))
  if (minValue === maxValue) { const padding = Math.max(Math.abs(minValue) * .15, 1); minValue -= padding; maxValue += padding }
  else { const padding = (maxValue - minValue) * .08; minValue -= padding; maxValue += padding }
  const x = (year, index) => margin.left + (minYear === maxYear ? plotWidth / 2 : (year - minYear) * plotWidth / (maxYear - minYear)) + ((index % 5) - 2) * 2.5
  const y = (value) => margin.top + plotHeight - (value - minValue) * plotHeight / (maxValue - minValue)
  const yTicks = [0, .25, .5, .75, 1].map((fraction) => minValue + (maxValue - minValue) * fraction)
  const uniqueYears = [...new Set(years)].sort((a, b) => a - b)
  const yearStep = Math.max(1, Math.ceil(uniqueYears.length / 8))
  const xTicks = uniqueYears.filter((_, index) => index % yearStep === 0 || index === uniqueYears.length - 1)
  const marks = series.observations.map((observation, index) => {
    const itemBounds = bounds[index]
    const cx = x(Number(observation.year), index)
    const title = `${observation.year} · ${displayLabel(observation.model_metric || observation.metric)} · ${normalizedValue(observation)}`
    const boundDirection = observation.value_kind === 'upper_bound' ? 'upper' : observation.value_kind === 'lower_bound' ? 'lower' : ''
    const boundMark = boundDirection === 'upper'
      ? `<path d="M ${cx - 4} ${y(itemBounds.point) + 8} L ${cx + 4} ${y(itemBounds.point) + 8} L ${cx} ${y(itemBounds.point) + 14} Z"/>`
      : boundDirection === 'lower'
        ? `<path d="M ${cx - 4} ${y(itemBounds.point) - 8} L ${cx + 4} ${y(itemBounds.point) - 8} L ${cx} ${y(itemBounds.point) - 14} Z"/>`
        : ''
    return `<g class="characteristic-mark ${boundDirection ? 'bound' : ''} ${state.selectedImplementation === observation.implementation_id ? 'selected' : ''}" data-implementation="${escapeHtml(observation.implementation_id)}" tabindex="0" role="button" aria-label="${escapeHtml(title)}">
      ${itemBounds.minimum !== itemBounds.maximum ? `<line x1="${cx}" x2="${cx}" y1="${y(itemBounds.minimum)}" y2="${y(itemBounds.maximum)}"/><line x1="${cx - 4}" x2="${cx + 4}" y1="${y(itemBounds.minimum)}" y2="${y(itemBounds.minimum)}"/><line x1="${cx - 4}" x2="${cx + 4}" y1="${y(itemBounds.maximum)}" y2="${y(itemBounds.maximum)}"/>` : ''}
      <circle cx="${cx}" cy="${y(itemBounds.point)}" r="4.3"><title>${escapeHtml(title)}</title></circle>
      ${boundMark}
    </g>`
  }).join('')
  return `<article class="characteristic-plot-card"><div class="plot-title"><div><h3>Normalized value by year</h3><p>${escapeHtml(displayLabel(series.category))} · ${escapeHtml(displayLabel(series.displayMetric || series.metric))} (${escapeHtml(series.unit)})</p></div><span>${series.observations.length} observations</span></div>
    <svg class="characteristic-plot" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(displayLabel(series.displayMetric || series.metric))} by publication year">
      ${yTicks.map((tick) => `<line class="grid-line" x1="${margin.left}" x2="${width - margin.right}" y1="${y(tick)}" y2="${y(tick)}"/><text class="axis-label" x="${margin.left - 9}" y="${y(tick) + 4}" text-anchor="end">${formatNumber(tick)}</text>`).join('')}
      ${xTicks.map((year) => `<text class="axis-label" x="${x(year, 2)}" y="${height - 16}" text-anchor="middle">${year}</text>`).join('')}
      ${marks}
    </svg>
    <p class="plot-note">Each point is a paper-local implementation; vertical whiskers preserve reported ranges and triangles mark upper or lower bounds. The largest comparable normalized series is shown when “All properties” is selected.</p>
  </article>`
}

function egoGraphMarkup(motif, implementations) {
  if (!implementations.length) return `<article class="ego-card"><h3>Motif → implementation → paper</h3><p class="implementation-empty">No implementations meet these filters.</p></article>`
  const limit = 40
  const shown = implementations.slice(0, limit)
  const paperById = new Map((state.characteristicData.papers || []).map((paper) => [paper.paper_id, paper]))
  const paperIds = [...new Set(shown.map((item) => item.paper_id))]
  const width = 1080; const rowHeight = 34; const marginY = 30
  const height = Math.max(300, shown.length * rowHeight + marginY * 2)
  const middleX = 390; const paperX = 800
  const motifY = height / 2
  const paperY = new Map(paperIds.map((id, index) => [id, paperIds.length === 1 ? height / 2 : marginY + index * (height - marginY * 2) / (paperIds.length - 1)]))
  const rows = shown.map((implementation, index) => ({ implementation, y: marginY + index * rowHeight }))
  return `<article class="ego-card"><div class="plot-title"><div><h3>Motif → implementation → paper</h3><p>Focused chronological ego graph</p></div><span>${shown.length}${implementations.length > limit ? ` of ${implementations.length}` : ''} implementations</span></div>
    <div class="ego-scroll"><svg class="ego-graph" viewBox="0 0 ${width} ${height}" style="min-height:${height}px" role="img" aria-label="Focused implementation graph for ${escapeHtml(motif.label)}">
      ${rows.map(({ implementation, y }) => `<line class="ego-link motif-link" x1="260" y1="${motifY}" x2="${middleX - 8}" y2="${y}"/><line class="ego-link paper-link" x1="${middleX + 210}" y1="${y}" x2="${paperX - 8}" y2="${paperY.get(implementation.paper_id)}"/>`).join('')}
      <g class="ego-motif"><rect x="20" y="${motifY - 29}" width="240" height="58" rx="8"/><text x="34" y="${motifY - 3}">${escapeHtml(motif.label.slice(0, 31))}</text><text class="ego-subtext" x="34" y="${motifY + 16}">${escapeHtml(motif.level)} motif</text></g>
      ${rows.map(({ implementation, y }) => `<g class="ego-implementation ${state.selectedImplementation === implementation.implementation_id ? 'selected' : ''}" data-implementation="${escapeHtml(implementation.implementation_id)}" tabindex="0" role="button"><rect x="${middleX}" y="${y - 12}" width="210" height="24" rx="5"/><text x="${middleX + 8}" y="${y + 4}">${escapeHtml(String(implementation.implementation_name || implementation.component_name || implementation.implementation_id).slice(0, 29))}</text><title>${escapeHtml(implementation.implementation_name || implementation.component_name || implementation.implementation_id)}</title></g>`).join('')}
      ${paperIds.map((paperId) => { const paper = paperById.get(paperId) || {}; const label = `${paper.year || ''} ${paper.title || paper.document_title || paperId}`.trim(); return `<g class="ego-paper"><rect x="${paperX}" y="${paperY.get(paperId) - 13}" width="250" height="26" rx="5"/><text x="${paperX + 8}" y="${paperY.get(paperId) + 4}">${escapeHtml(label.slice(0, 36))}</text><title>${escapeHtml(label)}</title></g>` }).join('')}
    </svg></div>
    ${implementations.length > limit ? `<p class="plot-note">The graph shows the first ${limit} filtered implementations to stay readable; all ${implementations.length} remain in the chronological cards below.</p>` : ''}
  </article>`
}

function observationMarkup(observation) {
  const raw = rawObservationDisplay(observation)
  const normalized = normalizedValue(observation)
  const evidence = implementationEvidence(observation)
  const role = observation.role || observation.power_role
  const canonicalMetric = observation.metric || 'characteristic'
  const specificMetric = observation.model_metric && observation.model_metric !== canonicalMetric ? observation.model_metric : ''
  const subject = observation.subject_part || observation.applies_to
  const condition = observation.condition_text || observation.condition
  const scope = observation.device_level ? 'device level' : displayLabel(observation.scope || observation.subject_scope || '')
  const uncertainty = observation.uncertainty_value !== null && observation.uncertainty_value !== undefined
    ? `±${formatNumber(observation.uncertainty_value)}${observation.uncertainty_unit ? ` ${escapeHtml(observation.uncertainty_unit)}` : ''} (${escapeHtml(displayLabel(observation.uncertainty_type || 'reported unspecified'))})`
    : ''
  return `<li><div class="observation-heading"><strong>${escapeHtml(displayLabel(specificMetric || canonicalMetric))}</strong><div>${scope ? `<span>${escapeHtml(scope)}</span>` : ''}${specificMetric ? `<span>${escapeHtml(displayLabel(canonicalMetric))}</span>` : ''}${role ? `<span>Role: ${escapeHtml(displayLabel(role))}</span>` : ''}</div></div>
    <p class="observation-value"><span class="value-primary">${escapeHtml(raw.text)}</span>${normalized ? `<span class="normalized-value"><b>Normalized</b> ${escapeHtml(normalized)}</span>` : ''}</p>
    ${uncertainty ? `<p class="observation-context"><b>Uncertainty</b> ${uncertainty}</p>` : ''}
    ${raw.snippet ? `<p class="observation-snippet"><span>Reported as</span> “${escapeHtml(raw.snippet)}”</p>` : ''}
    ${subject ? `<p class="observation-context"><b>Subject</b> ${escapeHtml(subject)}</p>` : ''}
    ${condition ? `<p class="observation-context"><b>Condition</b> ${escapeHtml(condition)}</p>` : ''}
    ${evidence.quote ? `<details><summary>Source evidence · p. ${escapeHtml(evidence.page || '?')}</summary><blockquote>“${escapeHtml(evidence.quote)}”</blockquote></details>` : ''}</li>`
}

function implementationMetadataMarkup(label, values) {
  const items = (Array.isArray(values) ? values : []).map((item) => String(item || '').trim()).filter(Boolean)
  if (!items.length) return ''
  const limit = 8
  return `<div class="implementation-metadata"><strong>${escapeHtml(label)}</strong><div>${items.slice(0, limit).map((item) => `<span>${escapeHtml(item)}</span>`).join('')}${items.length > limit ? `<span>+${items.length - limit} more</span>` : ''}</div></div>`
}

function knowledgeEvidence(row) {
  const items = []
  const provenance = row.source_provenance || {}
  const add = (quote, pages = [], blockIds = [], kind = '') => {
    const text = String(quote || '').trim()
    if (!text) return
    const key = `${text}\u0000${(pages || []).join(',')}\u0000${(blockIds || []).join(',')}`
    if (items.some((item) => item.key === key)) return
    items.push({ key, quote: text, pages: Array.isArray(pages) ? pages : [pages], blockIds: Array.isArray(blockIds) ? blockIds : [blockIds], kind })
  }
  add(provenance.supporting_text, provenance.page_numbers, provenance.source_block_ids, 'source')
  const spans = row.evidence_spans || []
  const spanPages = row.source_page_numbers || provenance.page_numbers || []
  spans.forEach((span, index) => {
    const pages = spanPages.length === spans.length ? [spanPages[index]] : spanPages
    add(span.evidence_quote, pages, [span.source_block_id], 'source span')
  })
  for (const evidence of row.evidence || []) {
    add(evidence.verbatim_quote || evidence.evidence_quote || evidence.raw_value_text,
      evidence.source_page_numbers || [], evidence.source_block_ids || [], evidence.evidence_kind || 'coverage evidence')
  }
  return items
}

function knowledgeFields(row) {
  const fields = []
  const add = (label, value) => {
    if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) return
    fields.push([label, Array.isArray(value) ? value.join(', ') : String(value)])
  }
  if (row.knowledge_kind === 'relationship') {
    add('Variables', row.variable_a && row.variable_b ? `${row.variable_a}${row.variable_a_change ? ` (${row.variable_a_change})` : ''} → ${row.variable_b}${row.variable_b_change ? ` (${row.variable_b_change})` : ''}` : '')
    add('Direction', row.direction)
    add('Expression', row.relationship_expression)
    add('Optimum', row.optimum_range_text)
    add('Threshold', row.threshold_text)
    add('Conditions', row.conditions)
    add('Support', [row.assertion_basis, row.support_kind].filter(Boolean))
  } else if (row.knowledge_kind === 'failure' || row.knowledge_kind === 'constraint') {
    add('Trigger', row.triggering_condition)
    add('Threshold', row.threshold_text)
    add('Consequence', row.observed_consequence)
    add('Mitigation', row.mitigation ? `${row.mitigation}${row.mitigation_status ? ` (${displayLabel(row.mitigation_status)})` : ''}` : '')
    add('Conditions', row.conditions)
    add('Evidence', row.evidence_status)
  } else if (row.knowledge_kind === 'coverage') {
    add('Assessment', row.assessment_basis)
    add('Rationale', row.rationale)
    add('Measurements', row.matched_measurement_ids)
    add('QA', row.qa_flags)
  }
  add('Components', row.component_ids || row.component_id)
  add('Interfaces', row.interface_ids || row.interface_id)
  return fields
}

function knowledgeHeadline(row) {
  if (row.knowledge_kind === 'relationship') {
    return row.explicit_statement || row.relationship_expression
      || [row.variable_a, row.direction ? displayLabel(row.direction) : '', row.variable_b].filter(Boolean).join(' · ')
      || displayLabel(row.relationship_type)
  }
  if (row.knowledge_kind === 'coverage') {
    return `${row.characteristic_name || displayLabel(row.characteristic_id) || 'Expected characteristic'} · ${displayLabel(row.status || 'unclear')}`
  }
  return row.failure_mode_or_constraint || displayLabel(row.constraint_type) || 'Reported limitation'
}

function knowledgeRecordMarkup(row) {
  const paper = (state.characteristicData.papers || []).find((item) => item.paper_id === row.paper_id) || {}
  const evidence = knowledgeEvidence(row)
  const fields = knowledgeFields(row)
  const typeLabel = row.knowledge_kind === 'relationship'
    ? displayLabel(row.relationship_type || 'relationship')
    : row.knowledge_kind === 'coverage'
      ? `coverage · ${displayLabel(row.status || 'unclear')}`
      : displayLabel(row.constraint_type || row.knowledge_kind)
  return `<article class="knowledge-record knowledge-${escapeHtml(row.knowledge_kind)}">
    <div class="knowledge-record-top"><span>${escapeHtml(typeLabel)}</span><span>${escapeHtml(row.device_level ? 'device level' : 'component / interface level')}</span></div>
    <h4>${escapeHtml(knowledgeHeadline(row))}</h4>
    <p class="knowledge-paper">${escapeHtml(`${row.publication_year || row.year || 'Year unknown'} · ${paper.title || paper.document_title || row.paper_id || 'Paper unknown'}`)}</p>
    ${fields.length ? `<dl>${fields.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>` : ''}
    <div class="knowledge-id"><code>${escapeHtml(row.knowledge_id)}</code></div>
    ${evidence.length ? `<details class="knowledge-provenance"><summary>Source provenance · ${evidence.length} evidence item${evidence.length === 1 ? '' : 's'}</summary>${evidence.slice(0, 4).map((item) => `<blockquote>“${escapeHtml(item.quote)}”<footer>${item.pages.filter(Boolean).length ? `p. ${escapeHtml(item.pages.filter(Boolean).join(', '))}` : 'page not recorded'}${item.blockIds.filter(Boolean).length ? ` · ${escapeHtml(item.blockIds.filter(Boolean).join(', '))}` : ''}</footer></blockquote>`).join('')}</details>` : '<p class="knowledge-no-provenance">Source quotations and page/block extraction provenance are omitted from the public release.</p>'}
  </article>`
}

function engineeringKnowledgeMarkup(motif) {
  if (state.characteristicData?.schema_id !== 'rogers-engineering-frontend-bundle') return ''
  const implementation = (state.characteristicData.implementations || []).find((row) => row.implementation_id === state.selectedImplementation)
  const target = implementation ? state.engineeringTarget : 'motif'
  const result = engineeringRecordsForSelection(state.characteristicData, {
    motifId: motif.id,
    implementationId: implementation?.implementation_id,
    target,
  }, {
    kind: state.engineeringKind,
    scope: state.engineeringScope,
    coverageStatus: state.engineeringCoverageStatus,
    yearMin: state.characteristicYearMin,
    yearMax: state.characteristicYearMax,
  })
  const coverageStatuses = [...new Set((state.characteristicData.knowledge?.coverage || []).map((row) => row.status).filter(Boolean))].sort()
  const shown = result.records.slice(0, state.engineeringRecordLimit)
  const countLabel = Object.entries(result.counts).map(([kind, count]) => `${count} ${kind}${count === 1 ? '' : 's'}`).join(' · ')
  return `<section class="engineering-knowledge" aria-labelledby="engineering-knowledge-title">
    <div class="engineering-heading"><div><p class="eyebrow">Schema-native atomic records</p><h3 id="engineering-knowledge-title">Relationships, failures, constraints, and coverage</h3><p>Showing indexed public records for <strong>${escapeHtml(result.target?.label || motif.label)}</strong>, linked to their papers and engineering entities.</p></div>
      <div class="engineering-targets" role="group" aria-label="Engineering record target">
        <button type="button" data-engineering-target="motif" aria-pressed="${target === 'motif'}">Motif</button>
        <button type="button" data-engineering-target="device" aria-pressed="${target === 'device'}" ${implementation ? '' : 'disabled'}>Device</button>
        <button type="button" data-engineering-target="implementation" aria-pressed="${target === 'implementation'}" ${implementation ? '' : 'disabled'}>Variant</button>
      </div>
    </div>
    <div class="engineering-filters">
      <label>Record type<select id="engineering-kind"><option value="all">All records</option>${['relationship', 'failure', 'constraint', 'coverage'].map((kind) => `<option value="${kind}" ${state.engineeringKind === kind ? 'selected' : ''}>${escapeHtml(displayLabel(kind))}</option>`).join('')}</select></label>
      <label>Entity scope<select id="engineering-scope"><option value="all">All scopes</option><option value="device_level" ${state.engineeringScope === 'device_level' ? 'selected' : ''}>Device-level only</option><option value="component_level" ${state.engineeringScope === 'component_level' ? 'selected' : ''}>Component / interface</option></select></label>
      <label>Coverage status<select id="engineering-coverage-status"><option value="all">Any status</option>${coverageStatuses.map((status) => `<option value="${escapeHtml(status)}" ${state.engineeringCoverageStatus === status ? 'selected' : ''}>${escapeHtml(displayLabel(status))}</option>`).join('')}</select></label>
      <button type="button" id="engineering-reset">Reset record filters</button>
    </div>
    <p class="engineering-count"><strong>${result.records.length}</strong> matching atomic records${countLabel ? ` · ${escapeHtml(countLabel)}` : ''}${implementation ? ` · selected variant ${escapeHtml(implementation.implementation_name || implementation.implementation_id)}` : ' · select an implementation below to enable device and variant targets'}</p>
    ${shown.length ? `<div class="knowledge-records">${shown.map(knowledgeRecordMarkup).join('')}</div>` : '<p class="implementation-empty">No indexed engineering records meet these target and filter settings.</p>'}
    ${result.records.length > state.engineeringRecordLimit ? `<button type="button" id="engineering-load-more" class="load-more">Show next ${Math.min(60, result.records.length - state.engineeringRecordLimit)} records</button>` : ''}
  </section>`
}

function implementationCardMarkup(implementation, observations) {
  const paper = (state.characteristicData.papers || []).find((item) => item.paper_id === implementation.paper_id)
  const rows = observations.filter((item) => item.implementation_id === implementation.implementation_id)
  const paperDoi = doiUrl(paper?.doi)
  return `<article class="implementation-card ${state.selectedImplementation === implementation.implementation_id ? 'selected' : ''}" data-implementation-card="${escapeHtml(implementation.implementation_id)}" tabindex="0">
    <div class="implementation-card-top"><span>${implementation.year || paper?.year || 'Year unknown'}</span><span>${escapeHtml(displayLabel(implementation.implementation_scope || implementation.scope || 'implementation'))}</span></div>
    <h3>${escapeHtml(implementation.implementation_name || implementation.component_name || implementation.implementation_id)}</h3>
    <p class="implementation-paper">${escapeHtml(paper?.title || paper?.document_title || implementation.paper_id)}${paperDoi ? ` · <a href="${escapeHtml(paperDoi)}" target="_blank" rel="noopener noreferrer">DOI</a>` : ''}</p>
    ${implementation.function ? `<p>${escapeHtml(implementation.function)}</p>` : ''}
    ${implementation.configuration_label ? `<p class="configuration-label">Configuration: ${escapeHtml(implementation.configuration_label)}</p>` : ''}
    ${implementation.shape?.length ? `<div class="facet-list compact">${implementation.shape.map((item) => `<span>${escapeHtml(typeof item === 'string' ? item : item.label || item.shape_class || 'shape')}</span>`).join('')}</div>` : ''}
    ${implementationMetadataMarkup('Materials', implementation.materials)}
    ${implementationMetadataMarkup('Components', implementation.components)}
    ${implementationMetadataMarkup('Interfaces', implementation.interfaces)}
    ${implementation.record_counts ? `<div class="record-counts"><span><b>${formatCount(implementation.record_counts.accepted)}</b> accepted</span>${state.characteristicData.public_release ? '' : `<span><b>${formatCount(implementation.record_counts.quarantined)}</b> quarantined</span>`}<span><b>${formatCount(implementation.record_counts.relationships)}</b> relations</span><span><b>${formatCount(implementation.record_counts.failures + implementation.record_counts.constraints)}</b> limits</span></div>` : ''}
    ${rows.length ? `<ul class="observation-list">${rows.slice(0, 10).map(observationMarkup).join('')}</ul>${rows.length > 10 ? `<p class="more-observations">+${rows.length - 10} additional matching observations</p>` : ''}` : '<p class="no-characteristics">No reported characteristic meets these filters.</p>'}
  </article>`
}

function implementationExplorerMarkup() {
  const heading = `<div class="section-heading"><div><p class="eyebrow">Dated implementation evidence</p><h2 id="implementation-title">Implementations and characteristics</h2></div></div>`
  if (!state.characteristicData) return `<section class="implementations" id="implementation-explorer" aria-labelledby="implementation-title">${heading}<p class="implementation-empty">The optional characteristics bundle is not available yet. The motif atlas remains fully usable.</p></section>`
  if (!state.selectedNode) return `<section class="implementations" id="implementation-explorer" aria-labelledby="implementation-title">${heading}<p class="implementation-empty">Select a motif in a timeline, card, or network to inspect its dated implementations.</p></section>`
  const { motif, allImplementations, allObservations, implementations, observations } = selectedImplementationData()
  if (!motif) return `<section class="implementations" id="implementation-explorer" aria-labelledby="implementation-title">${heading}<p class="implementation-empty">The selected motif is unavailable.</p></section>`
  if (!allImplementations.length) return `<section class="implementations" id="implementation-explorer" aria-labelledby="implementation-title">${heading}<div class="implementation-intro"><div><h3>${escapeHtml(motif.label)}</h3><p>No implementation records are available. This motif may be below the fixed five-paper extraction threshold or still pending in a partial run.</p></div></div></section>`
  const years = allImplementations.map((item) => Number(item.year)).filter(Number.isFinite)
  const minimumYear = years.length ? Math.min(...years) : ''
  const maximumYear = years.length ? Math.max(...years) : ''
  const options = characteristicOptions(allObservations, state.characteristicCategory)
  const scopeOptions = [...new Set(allObservations.map((item) => item.scope).filter(Boolean))].sort()
  const deviceLevelCount = allObservations.filter((item) => item.device_level).length
  if (state.characteristicMetric !== 'all' && !options.metrics.includes(state.characteristicMetric)) state.characteristicMetric = 'all'
  const warnings = Object.values(state.characteristicData.warnings || {}).reduce((sum, value) => sum + Number(value || 0), 0)
  return `<section class="implementations" id="implementation-explorer" aria-labelledby="implementation-title">${heading}
    <div class="implementation-intro"><div><h3>${escapeHtml(motif.label)}</h3><p>${allImplementations.length} dated implementations · ${allObservations.length} accepted characteristics · ${deviceLevelCount} device-level${state.characteristicData.status === 'partial' ? ' · partial extraction' : ''}</p></div>${warnings ? `<span class="partial-badge">${warnings} quarantined rows retained separately</span>` : ''}</div>
    <div class="characteristic-controls">
      <label>Category<select id="characteristic-category"><option value="all">All categories</option>${options.categories.map((item) => `<option value="${escapeHtml(item)}" ${state.characteristicCategory === item ? 'selected' : ''}>${escapeHtml(displayLabel(item))}</option>`).join('')}</select></label>
      <label>Property<select id="characteristic-metric"><option value="all">All properties</option>${options.metrics.map((item) => `<option value="${escapeHtml(item)}" ${state.characteristicMetric === item ? 'selected' : ''}>${escapeHtml(displayLabel(item))}</option>`).join('')}</select></label>
      <label>Scope<select id="characteristic-scope"><option value="all">All scopes</option><option value="device_level" ${state.characteristicScope === 'device_level' ? 'selected' : ''}>Device-level only</option>${scopeOptions.map((item) => `<option value="${escapeHtml(item)}" ${state.characteristicScope === item ? 'selected' : ''}>${escapeHtml(displayLabel(item))}</option>`).join('')}</select></label>
      <label>From year<input id="characteristic-year-min" type="number" ${minimumYear !== '' ? `min="${minimumYear}" max="${maximumYear}"` : ''} value="${escapeHtml(state.characteristicYearMin)}" placeholder="${minimumYear}"/></label>
      <label>Through year<input id="characteristic-year-max" type="number" ${minimumYear !== '' ? `min="${minimumYear}" max="${maximumYear}"` : ''} value="${escapeHtml(state.characteristicYearMax)}" placeholder="${maximumYear}"/></label>
      <button type="button" id="characteristic-reset">Reset</button>
    </div>
    <p class="implementation-count"><strong>${implementations.length}</strong> matching implementations · <strong>${observations.length}</strong> matching observations</p>
    <div class="characteristic-visuals">${characteristicPlotMarkup(observations)}${egoGraphMarkup(motif, implementations)}</div>
    ${engineeringKnowledgeMarkup(motif)}
    <div class="implementation-cards">${implementations.slice(0, state.implementationCardLimit).map((item) => implementationCardMarkup(item, observations)).join('')}</div>
    ${implementations.length > state.implementationCardLimit ? `<button type="button" id="implementation-load-more" class="load-more">Show next ${Math.min(120, implementations.length - state.implementationCardLimit)} implementations</button>` : ''}
    ${implementations.length ? '' : '<p class="implementation-empty">No implementations meet these filters.</p>'}
  </section>`
}

function visibleGraph() {
  let nodes = filteredNodes()
  // Searching for a child keeps its ancestors visible so the result has context.
  if (state.query.trim()) {
    const byId = new Map(state.data.nodes.map((node) => [node.id, node]))
    const ids = new Set(nodes.map((node) => node.id))
    for (const node of [...nodes]) {
      for (const parentId of node.parent_ids || []) {
        const parent = byId.get(parentId)
        if (parent) {
          ids.add(parent.id)
          for (const grandparent of parent.parent_ids || []) ids.add(grandparent)
        }
      }
      for (const familyId of node.family_ids || []) ids.add(familyId)
    }
    nodes = state.data.nodes.filter((node) => ids.has(node.id))
  }
  const nodeIds = new Set(nodes.map((node) => node.id))
  const edges = state.data.edges.filter((edge) => state.edgeGroups.has(edge.group) && nodeIds.has(edge.source) && nodeIds.has(edge.target))
  return { nodes, edges }
}

function controlsMarkup() {
  const families = state.data.nodes.filter((node) => node.level === 'L1')
  return `
    <section class="controls" aria-label="Explorer filters">
      <label class="search-wrap">
        <span>Search all motifs</span>
        <input id="search" type="search" value="${escapeHtml(state.query)}" placeholder="Label, description, alias, reviewed observation, or facet…" autocomplete="off" />
      </label>
      <fieldset>
        <legend>Resolution</legend>
        ${['L1', 'L2', 'L3'].map((level) => `<label><input type="checkbox" data-level="${level}" ${state.levels.has(level) ? 'checked' : ''}/> ${level}</label>`).join('')}
      </fieldset>
      <label class="family-select">Family
        <select id="family-filter">
          <option value="all">All families</option>
          ${families.map((item) => `<option value="${item.id}" ${state.family === item.id ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}
        </select>
      </label>
    </section>`
}

function headerMarkup() {
  const counts = state.data.counts.by_level
  return `
    <header class="hero">
      <div>
        <p class="eyebrow">General device building-block library</p>
        <h1>Device motif atlas</h1>
        <p class="lede">Explore functional motifs, device implementations, normalized engineering characteristics, and their relationships across the research corpus.</p>
      </div>
      <div class="summary" aria-label="Dataset summary">
        ${['L1', 'L2', 'L3'].map((level) => `<div><strong>${counts[level] || 0}</strong><span>${level} nodes</span></div>`).join('')}
      </div>
    </header>
    ${state.data.warning ? `<div class="data-warning" role="status"><strong>Seed preview.</strong> ${escapeHtml(state.data.warning)}</div>` : ''}
  `
}

function edgeFiltersMarkup() {
  return `<fieldset class="edge-filters"><legend>Relationships</legend>${EDGE_GROUPS.map(([id, label]) => `
    <label><input type="checkbox" data-edge-group="${id}" ${state.edgeGroups.has(id) ? 'checked' : ''}/><span class="edge-swatch ${id}"></span>${label}</label>
  `).join('')}</fieldset>`
}

function networkProjectionControlsMarkup() {
  const scopeMotifId = state.selectedNode || (state.family !== 'all' ? state.family : '')
  const selectedMotif = scopeMotifId && state.data.nodes.find((node) => node.id === scopeMotifId)
  return `<div class="projection-controls">
    <label>Network lens<select id="network-view">
      <option value="motif" ${state.networkView === 'motif' ? 'selected' : ''}>Motifs</option>
      <option value="device" ${state.networkView === 'device' ? 'selected' : ''}>Devices · shared motifs</option>
      <option value="paper" ${state.networkView === 'paper' ? 'selected' : ''}>Papers · shared motifs</option>
      <option value="mixed" ${state.networkView === 'mixed' ? 'selected' : ''}>Paper → device → motif</option>
      <option value="atomic" ${state.networkView === 'atomic' ? 'selected' : ''}>Full atomic graph · all entities</option>
    </select></label>
    ${state.networkView === 'motif' ? edgeFiltersMarkup() : `
      ${['mixed', 'atomic'].includes(state.networkView) ? '' : `<label>Minimum shared motifs<select id="network-min-shared">${[1, 2, 3, 4, 5].map((value) => `<option value="${value}" ${state.networkMinShared === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label>`}
      ${state.networkView === 'atomic' ? '<span class="network-scope"><strong>Unsampled:</strong> every extracted entity and structural edge</span>' : `<label>Node limit<select id="network-max-nodes">${[100, 250, 500].map((value) => `<option value="${value}" ${state.networkMaxNodes === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label>`}
      ${selectedMotif && state.networkView !== 'atomic' ? `<span class="network-scope">Scoped to <strong>${escapeHtml(selectedMotif.label)}</strong><button type="button" id="network-clear-scope">Clear</button></span>` : ''}
    `}
  </div>`
}

function currentProjectedGraph() {
  if (state.networkView === 'motif' || state.characteristicData?.schema_id !== 'rogers-engineering-frontend-bundle') {
    return { view: 'motif', ...visibleGraph(), candidateCount: filteredNodes().length, note: 'Canonical motif hierarchy and evidence-weighted motif relationships.' }
  }
  return projectedEntityNetwork(state.characteristicData, state.data.nodes, {
    view: state.networkView,
    motifId: state.selectedNode || (state.family !== 'all' ? state.family : ''),
    query: state.query,
    maxNodes: state.networkMaxNodes,
    minShared: state.networkMinShared,
    topK: state.networkTopK,
  })
}

function genericNetworkDetailMarkup(graph) {
  if (state.selectedNetworkEdge) {
    const edge = graph.edges.find((item) => item.id === state.selectedNetworkEdge)
    if (edge) {
      const source = graph.nodes.find((item) => item.id === edge.source)
      const target = graph.nodes.find((item) => item.id === edge.target)
      const shared = sharedMotifLabels(edge, state.data.nodes)
      return `<div class="detail-content">
        <p class="eyebrow">${escapeHtml(displayLabel(edge.type))}</p>
        <h3>${escapeHtml(source?.label || edge.source)} <span class="relation-arrow">${edge.directed ? '→' : '↔'}</span> ${escapeHtml(target?.label || edge.target)}</h3>
        <dl><div><dt>Weight</dt><dd>${formatCount(edge.weight)}</dd></div>${edge.similarity !== undefined ? `<div><dt>Jaccard overlap</dt><dd>${(100 * edge.similarity).toFixed(1)}%</dd></div>` : ''}</dl>
        ${shared.length ? `<div class="facet-list"><strong>Shared motifs</strong>${shared.map((label) => `<span>${escapeHtml(label)}</span>`).join('')}</div>` : '<p>Direct entity link from the extracted device graph.</p>'}
      </div>`
    }
  }
  if (state.selectedNetworkNode) {
    const node = networkEntityDetail(graph.nodes.find((item) => item.id === state.selectedNetworkNode), state.data.nodes)
    if (node) {
      const metadata = node.metadata || {}
      const doi = doiUrl(metadata.doi)
      return `<div class="detail-content">
        <p class="eyebrow">${escapeHtml(displayLabel(node.type))}${node.year ? ` · ${node.year}` : ''}</p>
        <h3>${escapeHtml(node.label)}</h3>
        <dl>
          ${node.paper_id ? `<div><dt>Paper</dt><dd>${escapeHtml(node.paper_id)}</dd></div>` : ''}
          ${node.device_ids?.length ? `<div><dt>Devices</dt><dd>${node.device_ids.length}</dd></div>` : ''}
          ${doi ? `<div><dt>DOI</dt><dd><a href="${escapeHtml(doi)}" target="_blank" rel="noopener noreferrer">${escapeHtml(metadata.doi)}</a></dd></div>` : ''}
          ${metadata.prototype_maturity ? `<div><dt>Maturity</dt><dd>${escapeHtml(displayLabel(metadata.prototype_maturity))}</dd></div>` : ''}
          ${metadata.contribution_role ? `<div><dt>Contribution</dt><dd>${escapeHtml(displayLabel(metadata.contribution_role))}</dd></div>` : ''}
          <div><dt>Direct motifs</dt><dd>${node.motif_labels.length}</dd></div>
        </dl>
        ${node.motif_labels.length ? `<div class="facet-list">${node.motif_labels.slice(0, 18).map((label) => `<span>${escapeHtml(label)}</span>`).join('')}${node.motif_labels.length > 18 ? `<span>+${node.motif_labels.length - 18}</span>` : ''}</div>` : ''}
      </div>`
    }
  }
  return `<div class="empty-detail"><span aria-hidden="true">◎</span><p>Select a ${state.networkView === 'mixed' ? 'paper, device, motif, or link' : `${state.networkView} or similarity link`} to inspect the evidence behind the projection.</p></div>`
}

function reviewedObservationMarkup(observation, matched) {
  return `<details class="reviewed-observation ${matched ? 'query-match' : ''}" ${matched ? 'open' : ''}>
    <summary><strong>${escapeHtml(observation.label)}</strong><span>${escapeHtml(observation.level)} · ${escapeHtml(observation.year || 'year pending')} · ${escapeHtml(observation.confidence || 'confidence pending')} confidence</span></summary>
    <p>${escapeHtml(observation.rationale || 'No review rationale available.')}</p>
    <dl><div><dt>Decision</dt><dd>${escapeHtml(displayLabel(observation.decision || 'pending'))}</dd></div><div><dt>Canonical status</dt><dd>${escapeHtml(observation.exclusion_reason || 'Not promoted to the recurrent registry')}</dd></div></dl>
  </details>`
}

function reviewedObservationsMarkup(node) {
  const observations = [...(node.observations || [])]
  if (!observations.length) return ''
  const matched = new Set(state.query.trim()
    ? observations.filter((item) => matchesObservationSearch(item, state.query)).map((item) => item.id)
    : [])
  observations.sort((a, b) => Number(matched.has(b.id)) - Number(matched.has(a.id))
    || Number(b.year || 0) - Number(a.year || 0) || a.label.localeCompare(b.label))
  return `<section class="reviewed-observations"><div><h4>Reviewed implementation observations</h4><span>${observations.length}</span></div>
    <p>Specific reviewed implementations remain visible without being promoted to recurrent canonical motifs.</p>
    ${observations.map((item) => reviewedObservationMarkup(item, matched.has(item.id))).join('')}
  </section>`
}

function detailMarkup() {
  if (state.selectedEdge) {
    const edge = state.data.edges.find((item) => item.id === state.selectedEdge)
    if (edge) {
      const source = state.data.nodes.find((item) => item.id === edge.source)
      const target = state.data.nodes.find((item) => item.id === edge.target)
      return `<div class="detail-content">
        <p class="eyebrow">${escapeHtml(edge.group)} relationship</p>
        <h3>${escapeHtml(source?.label || edge.source)} <span class="relation-arrow">${edge.directed ? '→' : '↔'}</span> ${escapeHtml(target?.label || edge.target)}</h3>
        <dl><div><dt>Exact type</dt><dd>${escapeHtml(edge.type.replaceAll('_', ' '))}</dd></div><div><dt>Weight</dt><dd>${formatCount(edge.weight)}</dd></div><div><dt>Papers</dt><dd>${formatCount(edge.paper_count)}</dd></div><div><dt>Components</dt><dd>${formatCount(edge.component_count)}</dd></div><div><dt>Years</dt><dd>${edge.first_year ? `${edge.first_year}–${edge.last_year}` : 'Pending'}</dd></div></dl>
      </div>`
    }
  }
  if (state.selectedNode) {
    const node = state.data.nodes.find((item) => item.id === state.selectedNode)
    if (node) return `<div class="detail-content">
      <p class="eyebrow">${escapeHtml(node.level)} · ${escapeHtml(familyLabel(familyFor(node)))}</p>
      <h3>${escapeHtml(node.label)}</h3>
      ${node.pending ? '<span class="badge pending">Pending corpus confirmation</span>' : '<span class="badge recurrent">Recurrent / controlled</span>'}
      <p>${escapeHtml(node.description || 'No short description available.')}</p>
      <dl><div><dt>Papers</dt><dd>${formatCount(node.paper_count)}</dd></div><div><dt>Components</dt><dd>${formatCount(node.component_count)}</dd></div><div><dt>Years</dt><dd>${yearRange(node)}</dd></div><div><dt>Parents</dt><dd>${node.parent_ids?.map(familyLabel).map(escapeHtml).join(', ') || '—'}</dd></div></dl>
      ${node.facets?.length ? `<div class="facet-list">${node.facets.map((facet) => `<span title="${escapeHtml(facet.description)}">${escapeHtml(facet.label)}</span>`).join('')}</div>` : ''}
      ${reviewedObservationsMarkup(node)}
      ${node.evidence_samples?.length ? `<div class="evidence-samples"><h4>Evidence examples</h4>${node.evidence_samples.slice(0, 3).map((item) => `<blockquote><p>“${escapeHtml(item.quote)}”</p><footer>${escapeHtml(item.document_title || item.paper_id)} · ${item.year || 'year unknown'} · p. ${item.page || '?'}</footer></blockquote>`).join('')}</div>` : ''}
    </div>`
  }
  return `<div class="empty-detail"><span aria-hidden="true">◎</span><p>Select a node to keep it and its neighbors highlighted. Select an edge for its weight and time span.</p></div>`
}

function searchMatchMarkup(node) {
  const matches = matchingSearchFields(node, state.query)
  const compact = matches.filter(({ kind }) => kind === 'alias' || kind === 'facet')
  const observations = new Set(matches.filter(({ kind }) => kind === 'observation').map(({ id }) => id))
  if (!compact.length && !observations.size) return ''
  const unique = [...new Map(compact.map((match) => [`${match.kind}:${match.value}`, match])).values()]
  return `<p class="search-match">${unique.map(({ kind, value }) => `<span><strong>Matched ${kind}:</strong> ${escapeHtml(value)}</span>`).join('')}
    ${observations.size ? `<span><strong>${observations.size} matching reviewed observation${observations.size === 1 ? '' : 's'}.</strong></span>` : ''}</p>`
}

function cardMarkup(node) {
  const parents = (node.parent_ids || []).map(familyLabel).join(', ')
  const statusBadge = node.pending
    ? '<span class="badge pending">Pending seed</span>'
    : node.level === 'L1'
      ? '<span class="badge recurrent">Controlled family</span>'
      : '<span class="badge recurrent">Recurrent</span>'
  return `<article class="motif-card ${state.selectedNode === node.id ? 'selected' : ''}" tabindex="0" role="button" data-node-card="${node.id}" aria-label="Select ${escapeHtml(node.label)} in network">
    <div class="card-top"><span class="level-pill" style="--family-color:${familyColor(familyFor(node))}">${node.level}</span>${statusBadge}</div>
    <h3>${escapeHtml(node.label)}</h3>
    <p class="parent-line">${escapeHtml(parents || familyLabel(familyFor(node)))}</p>
    <p class="card-description">${escapeHtml(node.description || 'No short description available.')}</p>
    ${searchMatchMarkup(node)}
    <div class="card-metrics"><span><strong>${formatCount(node.paper_count)}</strong> papers</span><span><strong>${formatCount(node.component_count)}</strong> components</span><span><strong>${yearRange(node)}</strong> years</span></div>
    ${node.facets?.length ? `<div class="facet-list compact">${node.facets.slice(0, 4).map((facet) => `<span>${escapeHtml(facet.label)}</span>`).join('')}${node.facets.length > 4 ? `<span>+${node.facets.length - 4}</span>` : ''}</div>` : ''}
  </article>`
}

function renderShell() {
  clearTimeout(searchRenderTimer)
  searchRenderTimer = null
  destroyNetworkRuntime()
  const nodes = filteredNodes()
  app.innerHTML = `
    ${headerMarkup()}
    <main>
      ${controlsMarkup()}
      ${timelinesMarkup()}
      <section class="network-section" id="network-section" aria-labelledby="network-title">
        <div class="section-heading network-heading"><div><p class="eyebrow">Alternate network projections</p><h2 id="network-title">Motifs, devices, and papers</h2></div>${networkProjectionControlsMarkup()}</div>
        <div class="network-layout"><div id="network" class="network" aria-label="Interactive ${escapeHtml(state.networkView)} network"></div><aside id="detail" class="detail-panel" tabindex="0" aria-label="Selected network entity details" aria-live="polite">${state.networkView === 'motif' ? detailMarkup() : genericNetworkDetailMarkup(currentProjectedGraph())}</aside></div>
        <p class="network-help">Switch network lenses above. Click a node or edge to inspect it; drag to orbit or pan, scroll to zoom, and use the node limit or shared-motif threshold to control density.</p>
      </section>
      ${implementationExplorerMarkup()}
      <section class="library" aria-labelledby="library-title">
        <div class="section-heading"><div><p class="eyebrow">Motif library</p><h2 id="library-title">All matching motifs</h2></div><p id="result-count"><strong>${nodes.length}</strong> of ${state.data.nodes.length} nodes</p></div>
        <div id="cards" class="card-grid">${nodes.map(cardMarkup).join('')}</div>
        ${nodes.length ? '' : '<p class="no-results">No motifs match these filters.</p>'}
      </section>
    </main>
    <footer>Dataset mode: <strong>${escapeHtml(state.data.mode.replaceAll('_', ' '))}</strong> · generated ${new Date(state.data.generated_at).toLocaleString()}</footer>`
  bindEvents()
  renderNetwork()
}

function bindCharacteristicEvents() {
  const category = document.querySelector('#characteristic-category')
  if (!category) return
  category.addEventListener('change', (event) => {
    state.characteristicCategory = event.target.value
    state.characteristicMetric = 'all'
    state.implementationCardLimit = 120
    renderImplementationExplorer()
  })
  document.querySelector('#characteristic-metric')?.addEventListener('change', (event) => {
    state.characteristicMetric = event.target.value
    state.implementationCardLimit = 120
    renderImplementationExplorer()
  })
  document.querySelector('#characteristic-scope')?.addEventListener('change', (event) => {
    state.characteristicScope = event.target.value
    state.implementationCardLimit = 120
    renderImplementationExplorer()
  })
  document.querySelector('#characteristic-year-min')?.addEventListener('change', (event) => {
    state.characteristicYearMin = event.target.value
    state.implementationCardLimit = 120
    renderImplementationExplorer()
  })
  document.querySelector('#characteristic-year-max')?.addEventListener('change', (event) => {
    state.characteristicYearMax = event.target.value
    state.implementationCardLimit = 120
    renderImplementationExplorer()
  })
  document.querySelector('#characteristic-reset')?.addEventListener('click', () => {
    state.characteristicCategory = 'all'
    state.characteristicMetric = 'all'
    state.characteristicScope = 'all'
    state.characteristicYearMin = ''
    state.characteristicYearMax = ''
    state.implementationCardLimit = 120
    renderImplementationExplorer()
  })
  document.querySelector('#implementation-load-more')?.addEventListener('click', () => {
    state.implementationCardLimit += 120
    renderImplementationExplorer()
  })
  document.querySelectorAll('[data-engineering-target]').forEach((button) => button.addEventListener('click', () => {
    state.engineeringTarget = button.dataset.engineeringTarget
    state.engineeringRecordLimit = 60
    renderImplementationExplorer()
  }))
  document.querySelector('#engineering-kind')?.addEventListener('change', (event) => {
    state.engineeringKind = event.target.value
    state.engineeringRecordLimit = 60
    renderImplementationExplorer()
  })
  document.querySelector('#engineering-scope')?.addEventListener('change', (event) => {
    state.engineeringScope = event.target.value
    state.engineeringRecordLimit = 60
    renderImplementationExplorer()
  })
  document.querySelector('#engineering-coverage-status')?.addEventListener('change', (event) => {
    state.engineeringCoverageStatus = event.target.value
    state.engineeringRecordLimit = 60
    renderImplementationExplorer()
  })
  document.querySelector('#engineering-reset')?.addEventListener('click', () => {
    state.engineeringKind = 'all'
    state.engineeringScope = 'all'
    state.engineeringCoverageStatus = 'all'
    state.engineeringRecordLimit = 60
    renderImplementationExplorer()
  })
  document.querySelector('#engineering-load-more')?.addEventListener('click', () => {
    state.engineeringRecordLimit += 60
    renderImplementationExplorer()
  })
  document.querySelectorAll('[data-implementation], [data-implementation-card]').forEach((element) => {
    const activate = () => selectImplementation(element.dataset.implementation || element.dataset.implementationCard, element.hasAttribute('data-implementation'))
    element.addEventListener('click', activate)
    element.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate() }
    })
  })
}

function renderImplementationExplorer() {
  const section = document.querySelector('#implementation-explorer')
  if (!section) return
  section.outerHTML = implementationExplorerMarkup()
  bindCharacteristicEvents()
}

function selectImplementation(id, scrollToCard = false) {
  state.selectedImplementation = id
  state.engineeringTarget = 'implementation'
  state.engineeringRecordLimit = 60
  const index = selectedImplementationData().implementations.findIndex((item) => item.implementation_id === id)
  if (index >= state.implementationCardLimit) {
    state.implementationCardLimit = Math.ceil((index + 1) / 120) * 120
  }
  renderImplementationExplorer()
  if (scrollToCard) {
    const card = [...document.querySelectorAll('[data-implementation-card]')].find((item) => item.dataset.implementationCard === id)
    card?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
}

function bindEvents() {
  document.querySelector('#search').addEventListener('input', (event) => {
    state.query = event.target.value
    clearTimeout(searchRenderTimer)
    searchRenderTimer = setTimeout(() => {
      renderShell()
      const search = document.querySelector('#search')
      search.focus()
      search.setSelectionRange(state.query.length, state.query.length)
    }, 160)
  })
  document.querySelectorAll('[data-level]').forEach((input) => input.addEventListener('change', () => {
    input.checked ? state.levels.add(input.dataset.level) : state.levels.delete(input.dataset.level)
    renderShell()
  }))
  document.querySelector('#family-filter').addEventListener('change', (event) => {
    state.family = event.target.value
    renderShell()
  })
  document.querySelector('#network-view')?.addEventListener('change', (event) => {
    state.networkView = event.target.value
    state.selectedNetworkNode = null
    state.selectedNetworkEdge = null
    renderShell()
  })
  document.querySelector('#network-min-shared')?.addEventListener('change', (event) => {
    state.networkMinShared = Number(event.target.value)
    state.selectedNetworkEdge = null
    renderNetwork()
  })
  document.querySelector('#network-max-nodes')?.addEventListener('change', (event) => {
    state.networkMaxNodes = Number(event.target.value)
    state.selectedNetworkNode = null
    state.selectedNetworkEdge = null
    renderNetwork()
  })
  document.querySelector('#network-clear-scope')?.addEventListener('click', () => {
    state.selectedNode = null
    state.family = 'all'
    state.selectedImplementation = null
    state.selectedNetworkNode = null
    state.selectedNetworkEdge = null
    renderShell()
  })
  document.querySelectorAll('[data-edge-group]').forEach((input) => input.addEventListener('change', () => {
    input.checked ? state.edgeGroups.add(input.dataset.edgeGroup) : state.edgeGroups.delete(input.dataset.edgeGroup)
    renderNetwork()
  }))
  document.querySelectorAll('[data-node-card]').forEach((card) => {
    const activate = () => selectNode(card.dataset.nodeCard, true)
    card.addEventListener('click', activate)
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate() }
    })
  })
  document.querySelectorAll('[data-timeline-node]').forEach((element) => {
    const activate = () => selectNode(element.dataset.timelineNode, true)
    element.addEventListener('click', activate)
    element.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate() }
    })
  })
  bindCharacteristicEvents()
}

function selectNode(id, scrollToNetwork = false, syncNetwork = true) {
  if (state.selectedNode !== id) {
    state.selectedImplementation = null
    state.implementationCardLimit = 120
    state.engineeringTarget = 'motif'
    state.engineeringRecordLimit = 60
  }
  state.selectedNode = id
  state.selectedEdge = null
  if (state.networkView !== 'motif') {
    state.selectedNetworkNode = null
    state.selectedNetworkEdge = null
    renderShell()
    if (scrollToNetwork) requestAnimationFrame(() => document.querySelector('#network-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    return
  }
  if (syncNetwork) syncHeliosSelection('node', id)
  updateSelectionStyles()
  document.querySelector('#detail').innerHTML = detailMarkup()
  renderImplementationExplorer()
  document.querySelectorAll('[data-node-card]').forEach((card) => card.classList.toggle('selected', card.dataset.nodeCard === id))
  if (scrollToNetwork) document.querySelector('#network-section').scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function selectEdge(id, syncNetwork = true) {
  state.selectedEdge = id
  state.selectedNode = null
  state.selectedImplementation = null
  state.engineeringTarget = 'motif'
  if (syncNetwork) syncHeliosSelection('edge', id)
  updateSelectionStyles()
  document.querySelector('#detail').innerHTML = detailMarkup()
  renderImplementationExplorer()
}

function updateSelectionStyles() {
  const selected = state.selectedNode
  document.querySelectorAll('[data-timeline-node]').forEach((element) => {
    element.classList.toggle('selected', Boolean(selected) && element.dataset.timelineNode === selected)
    element.classList.toggle('dimmed', Boolean(selected) && element.dataset.timelineNode !== selected)
  })
}

function destroyNetworkRuntime() {
  if (!networkRuntime) return
  const { helios, network } = networkRuntime
  networkRuntime = null
  try {
    if (helios) helios.destroy()
    else network?.dispose?.()
  } catch (error) {
    console.warn('Could not fully dispose the previous network view.', error)
  }
}

function syncHeliosSelection(kind, dataId) {
  const runtime = networkRuntime
  if (!runtime?.helios) return
  const selection = runtime.helios.behavior?.selection
  if (!selection) return
  if (kind === 'node') {
    const index = runtime.nodeIndexById.get(dataId)
    if (index === undefined) return
    selection.selectNodes([index], { mode: 'replace', silent: true })
    selection.selectEdges([], { mode: 'replace', silent: true })
  } else {
    const index = runtime.edgeIndexById.get(dataId)
    if (index === undefined) return
    selection.selectEdges([index], { mode: 'replace', silent: true })
    selection.selectNodes([], { mode: 'replace', silent: true })
  }
}

function rgbaHex(color, alpha = 'ff') {
  return `${color}${alpha}`
}

function networkLoadingMarkup() {
  return `<div class="network-loading" role="status">
    <span class="network-spinner" aria-hidden="true"></span>
    <strong>Preparing interactive network</strong>
  </div>`
}

function networkStageMarkup(graph) {
  const generic = state.networkView !== 'motif'
  return `
    <div class="network-stage" id="helios-stage"></div>
    <div class="network-topbar">
      <div class="network-actions" aria-label="Network view controls">
        <button type="button" data-network-action="fit" title="Fit the visible network">Fit</button>
        <button type="button" data-network-action="layout" aria-pressed="false" title="Pause the live force layout">Pause layout</button>
        <button type="button" data-network-action="labels" aria-pressed="${state.showNetworkLabels}" title="Toggle ranked node labels">${state.showNetworkLabels ? 'Hide labels' : 'Show labels'}</button>
        <button type="button" data-network-action="mode" aria-pressed="${state.networkMode === '3d'}" title="Switch between 2D and 3D">${state.networkMode.toUpperCase()}</button>
      </div>
    </div>
    <div class="network-key" aria-label="Node encoding">
      <span><i class="key-size"></i> size = evidence + connectivity</span>
      <span><i class="key-color"></i> color = ${generic ? (['mixed', 'atomic'].includes(state.networkView) ? 'entity type' : state.networkView === 'paper' ? 'publication period' : 'prototype maturity') : 'L1 family'}</span>
      ${graph?.note ? `<span class="network-projection-note">${escapeHtml(graph.note)} Showing ${graph.nodes.length}${graph.candidateCount > graph.nodes.length ? ` of ${graph.candidateCount}` : ''} nodes.</span>` : ''}
    </div>
    <div class="network-tooltip" role="status" aria-live="polite"></div>`
}

function tooltipPosition(host, tooltip, detail) {
  const bounds = host.getBoundingClientRect()
  const x = Math.max(12, Math.min(bounds.width - 250, Number(detail.clientX || 0) - bounds.left + 14))
  const y = Math.max(58, Math.min(bounds.height - 105, Number(detail.clientY || 0) - bounds.top + 14))
  tooltip.style.transform = `translate(${x}px, ${y}px)`
}

function selectNetworkEntity(id, graph, syncNetwork = true) {
  state.selectedNetworkNode = id
  state.selectedNetworkEdge = null
  if (syncNetwork) syncHeliosSelection('node', id)
  document.querySelector('#detail').innerHTML = genericNetworkDetailMarkup(graph)
}

function selectNetworkProjectionEdge(id, graph, syncNetwork = true) {
  state.selectedNetworkEdge = id
  state.selectedNetworkNode = null
  if (syncNetwork) syncHeliosSelection('edge', id)
  document.querySelector('#detail').innerHTML = genericNetworkDetailMarkup(graph)
}

function bindHeliosEvents(helios, host, nodes, edges, nodeIdByIndex, edgeIdByIndex) {
  const graph = { nodes, edges }
  const motifView = state.networkView === 'motif'
  const tooltip = host.querySelector('.network-tooltip')
  helios.on(EVENTS.NODE_CLICK, (event) => {
    const id = nodeIdByIndex.get(Number(event.detail?.index))
    if (id) {
      if (motifView) selectNode(id, false, false)
      else selectNetworkEntity(id, graph, false)
    }
  })
  helios.on(EVENTS.EDGE_CLICK, (event) => {
    const id = edgeIdByIndex.get(Number(event.detail?.index))
    if (id) {
      if (motifView) selectEdge(id, false)
      else selectNetworkProjectionEdge(id, graph, false)
    }
  })
  helios.on(EVENTS.GRAPH_CLICK, (event) => {
    if (event.detail?.kind) return
    if (motifView) {
      state.selectedNode = null
      state.selectedEdge = null
      state.selectedImplementation = null
      state.engineeringTarget = 'motif'
      state.engineeringRecordLimit = 60
      document.querySelector('#detail').innerHTML = detailMarkup()
      updateSelectionStyles()
      renderImplementationExplorer()
    } else {
      state.selectedNetworkNode = null
      state.selectedNetworkEdge = null
      document.querySelector('#detail').innerHTML = genericNetworkDetailMarkup(graph)
    }
  })
  helios.on(EVENTS.NODE_HOVER, (event) => {
    const detail = event.detail || {}
    if (detail.state === 'out') {
      tooltip.classList.remove('visible')
      return
    }
    const id = nodeIdByIndex.get(Number(detail.index))
    const node = nodes.find((item) => item.id === id)
    if (!node) return
    tooltip.innerHTML = motifView
      ? `<strong>${escapeHtml(node.label)}</strong><span>${escapeHtml(node.level)} · ${formatCount(node.paper_count)} papers · ${escapeHtml(familyLabel(familyFor(node)))}</span>`
      : `<strong>${escapeHtml(node.label)}</strong><span>${escapeHtml(displayLabel(node.type))}${node.year ? ` · ${node.year}` : ''} · ${formatCount(node.motif_ids?.length || 0)} direct motifs</span>`
    tooltipPosition(host, tooltip, detail)
    tooltip.classList.add('visible')
  })
  helios.on(EVENTS.EDGE_HOVER, (event) => {
    const detail = event.detail || {}
    if (detail.state === 'out') {
      tooltip.classList.remove('visible')
      return
    }
    const id = edgeIdByIndex.get(Number(detail.index))
    const edge = edges.find((item) => item.id === id)
    if (!edge) return
    const source = nodes.find((item) => item.id === edge.source)
    const target = nodes.find((item) => item.id === edge.target)
    tooltip.innerHTML = `<strong>${escapeHtml(displayLabel(edge.type))}</strong><span>${escapeHtml(source?.label || edge.source)} ${edge.directed ? '→' : '↔'} ${escapeHtml(target?.label || edge.target)} · weight ${formatCount(edge.weight)}</span>`
    tooltipPosition(host, tooltip, detail)
    tooltip.classList.add('visible')
  })
}

function bindNetworkActions(helios, host) {
  const fit = host.querySelector('[data-network-action="fit"]')
  const layout = host.querySelector('[data-network-action="layout"]')
  const labels = host.querySelector('[data-network-action="labels"]')
  const mode = host.querySelector('[data-network-action="mode"]')

  const updateLayoutControl = () => {
    const runState = helios.behavior.layout.runState()
    const running = runState === 'running'
    layout.textContent = running ? 'Pause layout' : runState === 'idle' ? 'Reheat layout' : 'Run layout'
    layout.setAttribute('aria-pressed', String(!running))
    layout.title = running ? 'Pause the live force layout' : 'Run and reheat the force layout'
  }

  fit.addEventListener('click', () => helios.frameNetwork({ animate: true, durationMs: 450, paddingRatio: 0.04 }))
  layout.addEventListener('click', () => {
    const running = helios.behavior.layout.runState() === 'running'
    if (running) helios.behavior.layout.stop('atlas-control')
    else {
      helios.behavior.layout.reheat('atlas-control')
      helios.behavior.layout.start('atlas-control')
    }
    updateLayoutControl()
  })
  helios.on(EVENTS.LAYOUT_START, updateLayoutControl)
  helios.on(EVENTS.LAYOUT_STOP, updateLayoutControl)
  updateLayoutControl()
  labels.addEventListener('click', () => {
    state.showNetworkLabels = !state.showNetworkLabels
    helios.behavior.labels.enabled(state.showNetworkLabels)
    labels.textContent = state.showNetworkLabels ? 'Hide labels' : 'Show labels'
    labels.setAttribute('aria-pressed', String(state.showNetworkLabels))
  })
  mode.addEventListener('click', async () => {
    state.networkMode = state.networkMode === '2d' ? '3d' : '2d'
    mode.disabled = true
    await helios.setMode(state.networkMode)
    helios.behavior.layout.reheat('mode-change')
    helios.frameNetwork({ animate: true, durationMs: 500 })
    mode.textContent = state.networkMode.toUpperCase()
    mode.setAttribute('aria-pressed', String(state.networkMode === '3d'))
    mode.disabled = false
  })
}

async function renderNetwork() {
  const host = document.querySelector('#network')
  if (!host) return
  const graph = currentProjectedGraph()
  const { nodes, edges } = graph
  const motifView = state.networkView === 'motif'
  if (!nodes.length) { host.innerHTML = '<p class="network-empty">No nodes match the filters.</p>'; return }

  const renderVersion = ++networkRenderVersion
  destroyNetworkRuntime()
  host.innerHTML = networkLoadingMarkup()

  let network
  try {
    network = await HeliosNetwork.create({ directed: false })
  } catch (error) {
    host.innerHTML = `<p class="network-empty"><strong>Helios could not initialize.</strong><br>${escapeHtml(error.message)}</p>`
    return
  }
  if (renderVersion !== networkRenderVersion || !host.isConnected) {
    network.dispose()
    return
  }

  const nodeHandles = network.addNodes(nodes.length)
  const nodeIndexById = new Map(nodes.map((node, index) => [node.id, Number(nodeHandles[index])]))
  const nodeIdByIndex = new Map(nodes.map((node, index) => [Number(nodeHandles[index]), node.id]))
  const edgeRows = edges.map((edge) => [nodeIndexById.get(edge.source), nodeIndexById.get(edge.target)])
  const edgeHandles = network.addEdges(edgeRows)
  const edgeIndexById = new Map(edges.map((edge, index) => [edge.id, Number(edgeHandles[index])]))
  const edgeIdByIndex = new Map(edges.map((edge, index) => [Number(edgeHandles[index]), edge.id]))

  const degree = new Map(nodes.map((node) => [node.id, 0]))
  edges.forEach((edge) => { degree.set(edge.source, degree.get(edge.source) + 1); degree.set(edge.target, degree.get(edge.target) + 1) })

  const families = state.data.nodes.filter((node) => node.level === 'L1')
  const entityCategory = (node) => {
    if (motifView) return familyFor(node)
    if (['mixed', 'atomic'].includes(state.networkView)) return node.type
    if (state.networkView === 'paper') {
      const year = Number(node.year || 0)
      return year ? `${Math.floor(year / 5) * 5}–${Math.floor(year / 5) * 5 + 4}` : 'year unknown'
    }
    return node.category || 'maturity unknown'
  }
  const categories = motifView
    ? families.map((node) => ({ id: node.id, label: node.label }))
    : [...new Set(nodes.map(entityCategory))].sort().map((id) => ({ id, label: displayLabel(id) }))
  const categoryIndexes = new Map(categories.map((item, index) => [item.id, index]))
  const levelIndexes = new Map([['L1', 0], ['L2', 1], ['L3', 2]])
  const nodeScores = nodes.map((node) => {
    const evidence = Math.log1p(Number(motifView ? node.paper_count || 0 : node.score || 0))
    const connectivity = Math.log1p(Number(degree.get(node.id) || 0))
    const levelBoost = motifView ? (node.level === 'L1' ? 2.6 : node.level === 'L2' ? 0.8 : 0) : 0
    return evidence + 0.7 * connectivity + levelBoost
  })
  const edgeScores = edges.map((edge) => Math.log1p(Number(edge.weight || 1)))
  const edgeCategories = motifView
    ? EDGE_GROUPS.map(([id, label]) => ({ id, label }))
    : [...new Set(edges.map((edge) => edge.group || edge.type))].sort().map((id) => ({ id, label: displayLabel(id) }))
  const edgeGroupIndexes = new Map(edgeCategories.map((item, index) => [item.id, index]))

  network
    .nodeAttribute('label', (_current, _id, ordinal) => nodes[ordinal].label)
    .nodeAttribute('family_category', (_current, _id, ordinal) => categoryIndexes.get(entityCategory(nodes[ordinal])) ?? 0, { type: AttributeType.Category })
    .nodeAttribute('level_index', (_current, _id, ordinal) => levelIndexes.get(nodes[ordinal].level) ?? 1, { type: AttributeType.Integer })
    .nodeAttribute('visual_score', (_current, _id, ordinal) => nodeScores[ordinal], { type: AttributeType.Float })
    .nodeAttribute('paper_count', (_current, _id, ordinal) => Number(nodes[ordinal].paper_count || 0), { type: AttributeType.Integer })
    .edgeAttribute('relationship_category', (_current, _id, ordinal) => edgeGroupIndexes.get(edges[ordinal].group || edges[ordinal].type) ?? 0, { type: AttributeType.Category })
    .edgeAttribute('visual_score', (_current, _id, ordinal) => edgeScores[ordinal], { type: AttributeType.Float })

  network.setNodeAttributeCategoryDictionary(
    'family_category',
    categories.map((category, id) => ({ id, label: category.label })),
    { remapExisting: false },
  )
  network.setEdgeAttributeCategoryDictionary(
    'relationship_category',
    edgeCategories.map((category, id) => ({ id, label: category.label })),
    { remapExisting: false },
  )

  host.innerHTML = networkStageMarkup(graph)
  const stage = host.querySelector('#helios-stage')
  const helios = new Helios(network, {
    container: stage,
    mode: state.networkMode,
    storage: false,
    session: false,
    fileDrop: false,
    ui: false,
    quickControls: false,
    autoCleanup: false,
    disposeNetworkOnDestroy: true,
    density: false,
    transparencyModeEdges: 'weighted',
    highlightConnectedEdges: true,
    hoverAffectsOtherElements: true,
    interactionRenderOrder: true,
    legends: {
      maxChars: 34,
      maxRows: 2,
      placements: {
        edgeColor: 'bottom-left',
      },
      titles: {
        nodeColor: motifView ? 'L1 family' : ['mixed', 'atomic'].includes(state.networkView) ? 'Entity type' : state.networkView === 'paper' ? 'Publication period' : 'Prototype maturity',
        edgeColor: 'Relationship',
      },
    },
    behaviors: {
      labels: {
        enabled: state.showNetworkLabels,
        source: 'label',
        selectionMode: 'ranked',
        maxVisible: 42,
        minScreenRadiusPx: 3.2,
        maxChars: 34,
        fontSizeScale: 0.92,
        outlineWidth: 3,
        fill: '#23332d',
        outlineColor: '#fffefa',
      },
      hover: {
        hoverLabel: true,
        nodeHover: true,
        edgeHover: true,
        hoverConnectedEdges: true,
        highlightConnectedEdges: true,
      },
      selection: {
        nodeClick: true,
        edgeClick: true,
        selectedConnectedEdges: true,
        otherSelectedNodeTone: { mode: 'desaturate', amount: 0.72 },
        otherSelectedEdgeTone: { mode: 'desaturate', amount: 0.8 },
      },
      appearance: {
        background: '#f7f9f7',
        edgeTransparencyMode: 'weighted',
        nodeSizeScale: 1,
        edgeWidthScale: 1,
        shadedEnabled: true,
        shadedNodes: true,
        shadedEdges: false,
      },
    },
  })

  networkRuntime = { helios, network, nodeIndexById, edgeIndexById }
  try {
    await helios.ready
  } catch (error) {
    if (renderVersion === networkRenderVersion) {
      destroyNetworkRuntime()
      host.innerHTML = `<p class="network-empty"><strong>Helios could not render this graph.</strong><br>${escapeHtml(error.message)}</p>`
    }
    return
  }
  if (renderVersion !== networkRenderVersion || !host.isConnected) {
    if (networkRuntime?.helios === helios) destroyNetworkRuntime()
    else helios.destroy()
    return
  }

  const familyDomain = categories.map((_, index) => index)
  const familyRange = motifView
    ? families.map((family) => rgbaHex(familyColor(family.id)))
    : categories.map((_, index) => rgbaHex(CATEGORY10[index % CATEGORY10.length]))
  const edgeRange = ['#94a3b8c7', '#0f766ed9', '#7c3aedcf', '#c2410cd9']
  const maxNodeScore = Math.max(1, ...nodeScores)
  const maxEdgeScore = Math.max(1, ...edgeScores)

  const mappers = helios.behavior.mappers
  mappers.setChannelConfig('node', 'color', { type: 'categorical', attributes: 'family_category', domain: familyDomain, range: familyRange, defaultValue: '#7f8b85ff' })
  mappers.setChannelConfig('node', 'size', { type: 'linear', attributes: 'visual_score', domain: [0, maxNodeScore], range: [3.6, 13.5] })
  mappers.setChannelConfig('node', 'opacity', { type: 'constant', value: 0.96 })
  mappers.setChannelConfig('edge', 'color', { type: 'categorical', attributes: 'relationship_category', domain: edgeCategories.map((_, index) => index), range: edgeCategories.map((_, index) => edgeRange[index % edgeRange.length]), defaultValue: '#94a3b8b3' })
  mappers.setChannelConfig('edge', 'width', { type: 'linear', attributes: 'visual_score', domain: [0, maxEdgeScore], range: [0.45, 2.7] })
  mappers.setChannelConfig('edge', 'opacity', { type: 'constant', value: 0.38 })

  helios.nodeHoverStyle({ sizeMul: 1.7, opacityMul: 1, outlineMul: 2.4, forceMaxAlpha: true })
  helios.edgeHoverStyle({ widthMul: 2.5, opacityMul: 1.8, forceMaxAlpha: true })
  bindHeliosEvents(helios, host, nodes, edges, nodeIdByIndex, edgeIdByIndex)
  bindNetworkActions(helios, host)
  if (motifView && state.selectedNode) syncHeliosSelection('node', state.selectedNode)
  if (motifView && state.selectedEdge) syncHeliosSelection('edge', state.selectedEdge)
  if (!motifView && state.selectedNetworkNode) syncHeliosSelection('node', state.selectedNetworkNode)
  if (!motifView && state.selectedNetworkEdge) syncHeliosSelection('edge', state.selectedNetworkEdge)
  await new Promise((resolve) => setTimeout(resolve, 900))
  if (renderVersion !== networkRenderVersion || !host.isConnected) return
  helios.frameNetwork({ animate: false, paddingRatio: 0.04 })
}

async function load() {
  try {
    const response = await fetch('./data/hierarchical_motifs.json')
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    state.data = await response.json()
    const motifById = new Map(state.data.nodes.map((node) => [node.id, node]))
    state.data.nodes.forEach((node) => { node.observations = [] })
    for (const observation of state.data.observations || []) {
      for (const anchorId of observation.anchor_ids || []) {
        motifById.get(anchorId)?.observations.push(observation)
      }
    }
    try {
      try {
        const { bundle } = await fetchEngineeringBundle(fetch)
        state.characteristicData = engineeringBundleToCharacteristics(bundle)
      } catch {
        const characteristicResponse = await fetch('./data/implementation_characteristics.json')
        if (characteristicResponse.ok) state.characteristicData = await characteristicResponse.json()
      }
    } catch (error) {
      console.info('Optional implementation characteristics are not available.', error)
    }
    renderShell()
  } catch (error) {
    app.innerHTML = `<div class="fatal"><h1>Could not load motif data</h1><p>${escapeHtml(error.message)}</p><p>Generate <code>public/data/hierarchical_motifs.json</code> before serving the app.</p></div>`
  }
}

load()
