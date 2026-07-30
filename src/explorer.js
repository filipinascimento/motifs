import './explorer.css'
import HeliosNetwork, { AttributeType } from 'helios-network'
import { EVENTS, Helios } from 'helios-web'
import { fetchEngineeringBundle, engineeringBundleToCharacteristics } from './engineering.js'
import { implementationsForMotif, normalizedObservationDisplay, rawObservationDisplay } from './characteristics.js'
import { projectedEntityNetwork, sharedMotifLabels } from './networkViews.js'
import { switchNetworkMode } from './networkInteraction.js'
import { adoptionTimelineChartMarkup, CATEGORY10, characteristicScatterMarkup, detailAdoptionChartMarkup, motifSparklineMarkup } from './motifCharts.js'
import { adoptionYears, motifCharacteristicTrends, motifTimelineGroups } from './motifTrends.js'
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
} from './explorerData.js'

const EDGE_COLORS = {
  lifecycle: '#1f77b4',
  parent_of: '#ff7f0e',
  similarity: '#2ca02c',
  used_with: '#9467bd',
  shared_motifs: '#17becf',
}
const VIEWS = {
  motifs: { label: 'Motifs', singular: 'motif', placeholder: 'Search motif name, function, or alias…' },
  devices: { label: 'Devices', singular: 'device', placeholder: 'Search device, application, material, or motif…' },
  papers: { label: 'Papers', singular: 'paper', placeholder: 'Search title, DOI, device, or motif…' },
}

const state = {
  atlas: null,
  engineering: null,
  devices: [],
  papers: [],
  view: 'motifs',
  query: '',
  motifLevel: 'all',
  motifFamily: 'all',
  resultLimit: 40,
  minShared: 2,
  networkMode: '3d',
  showLabels: false,
  nodeSizeScale: .7,
  edgeOpacity: .65,
  motifCenterView: 'network',
  adoptionMeasure: 'share',
  characteristicSelections: {},
  characteristicScopeSelections: {},
  appliedFilters: { motifs: null, devices: null, papers: null },
  edgeTypes: { motifs: null, devices: null, papers: null },
  selected: { motifs: null, devices: null, papers: null },
  selectedEdge: null,
}

const app = document.querySelector('#app')
let networkRuntime = null
let renderVersion = 0
let searchTimer = null

document.addEventListener('keydown', (event) => {
  if (event.key !== '/' || ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return
  event.preventDefault()
  document.querySelector('#entity-search')?.focus()
})

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char])
}

function displayLabel(value = '') {
  return String(value || '').replaceAll('_', ' ')
}

function formatCount(value) {
  return Number(value || 0).toLocaleString()
}

function doiUrl(value = '') {
  const doi = String(value).trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, '')
  return /^10\.\d{4,9}\//u.test(doi) ? `https://doi.org/${encodeURI(doi)}` : ''
}

function familyLabel(id) {
  return state.atlas.nodes.find((node) => node.id === id)?.label || 'Unassigned'
}

function motifLabel(id) {
  return state.atlas.nodes.find((node) => node.id === id)?.label || id
}

function activeItems() {
  if (state.view === 'motifs') {
    return motifResults(state.atlas.nodes, {
      query: state.query,
      level: state.motifLevel,
      family: state.motifFamily,
    })
  }
  if (state.view === 'devices') return deviceResults(state.devices, state.query)
  return paperResults(state.papers, state.query)
}

function activeItem(id = state.selected[state.view]) {
  if (!id) return null
  if (state.view === 'motifs') return state.atlas.nodes.find((node) => node.id === id) || null
  if (state.view === 'devices') return state.devices.find((device) => device.id === id) || null
  return state.papers.find((paper) => paper.id === id) || null
}

function updateUrl() {
  const url = new URL(window.location.href)
  url.searchParams.set('view', state.view)
  if (state.query) url.searchParams.set('q', state.query)
  else url.searchParams.delete('q')
  const selected = state.selected[state.view]
  if (selected) url.searchParams.set('id', selected)
  else url.searchParams.delete('id')
  window.history.replaceState({}, '', url)
}

function initialStateFromUrl() {
  const url = new URL(window.location.href)
  const view = url.searchParams.get('view')
  if (VIEWS[view]) state.view = view
  state.query = url.searchParams.get('q') || ''
  const selected = url.searchParams.get('id')
  if (selected) state.selected[state.view] = selected
}

function headerMarkup() {
  return `<header class="app-header">
    <a class="brand" href="./" aria-label="Device motif atlas home"><span class="brand-mark">M</span><span>Device motif atlas</span></a>
    <nav class="view-tabs" aria-label="Explore by entity">
      ${Object.entries(VIEWS).map(([id, view]) => `<button type="button" data-view="${id}" aria-current="${state.view === id ? 'page' : 'false'}">${view.label}</button>`).join('')}
    </nav>
    <div class="corpus-count">${formatCount(state.engineering.papers.length)} papers · ${formatCount(state.devices.length)} devices · ${formatCount(state.atlas.nodes.length)} motifs</div>
  </header>`
}

function filterSnapshot() {
  const snapshot = { query: state.query.trim() }
  if (state.view === 'motifs') {
    snapshot.level = state.motifLevel
    snapshot.family = state.motifFamily
  }
  return snapshot
}

function normalizedFilterSnapshot(snapshot = filterSnapshot()) {
  const isDefault = !snapshot.query
    && (state.view !== 'motifs' || ((snapshot.level || 'all') === 'all' && (snapshot.family || 'all') === 'all'))
  return isDefault ? null : snapshot
}

function filterIsPending() {
  return JSON.stringify(normalizedFilterSnapshot()) !== JSON.stringify(state.appliedFilters[state.view])
}

function toolbarMarkup(graph = baseGraph()) {
  const families = state.atlas.nodes.filter((node) => node.level === 'L1')
  const edgeTypes = availableEdgeTypes(graph)
  const selectedTypes = state.edgeTypes[state.view]
  const selectedCount = selectedTypes === null
    ? edgeTypes.length
    : edgeTypes.filter((type) => selectedTypes.includes(type)).length
  return `<section class="toolbar">
    <label class="global-search"><span class="sr-only">Search ${VIEWS[state.view].label}</span><input id="entity-search" type="search" value="${escapeHtml(state.query)}" placeholder="${escapeHtml(VIEWS[state.view].placeholder)}" autocomplete="off"/><kbd>/</kbd></label>
    ${state.view === 'motifs' ? `<label>Level<select id="motif-level"><option value="all">All levels</option>${['L1', 'L2', 'L3'].map((level) => `<option value="${level}" ${state.motifLevel === level ? 'selected' : ''}>${level}</option>`).join('')}</select></label>
      <label>Family<select id="motif-family"><option value="all">All families</option>${families.map((family) => `<option value="${family.id}" ${state.motifFamily === family.id ? 'selected' : ''}>${escapeHtml(family.label)}</option>`).join('')}</select></label>` : `<label>Similarity<select id="minimum-shared">${[1, 2, 3, 4, 5].map((value) => `<option value="${value}" ${state.minShared === value ? 'selected' : ''}>${value}+ shared motifs</option>`).join('')}</select></label>
      `}
    <div class="filter-actions"><button type="button" id="apply-network-filter" ${filterIsPending() ? '' : 'disabled'}>Apply to network (${formatCount(activeItems().length)})</button>${state.appliedFilters[state.view] ? '<button type="button" id="clear-network-filter">Clear network filter</button>' : ''}</div>
    ${state.view === 'motifs' ? `<div class="center-view-switch" aria-label="Motif visualization"><button type="button" data-center-view="network" class="${state.motifCenterView === 'network' ? 'active' : ''}">Network</button><button type="button" data-center-view="adoption" class="${state.motifCenterView === 'adoption' ? 'active' : ''}">Adoption</button></div>` : ''}
    ${state.view !== 'motifs' || state.motifCenterView === 'network' ? `<div class="network-toolbar">
      <details class="edge-filter"><summary>Edges ${selectedCount}/${edgeTypes.length}</summary><div class="edge-filter-menu"><div class="edge-filter-heading"><strong>Edge types</strong><span><button type="button" data-edge-filter-action="all">All</button><button type="button" data-edge-filter-action="none">None</button></span></div>${edgeTypes.map((type) => `<label><input type="checkbox" data-edge-type="${escapeHtml(type)}" ${selectedTypes === null || selectedTypes.includes(type) ? 'checked' : ''}/><i style="--edge-color:${EDGE_COLORS[type] || CATEGORY10[edgeTypes.indexOf(type) % CATEGORY10.length]}"></i>${escapeHtml(displayLabel(type))}</label>`).join('')}</div></details>
    </div>` : ''}
  </section>`
}

function resultCardMarkup(item) {
  const selected = state.selected[state.view] === item.id
  if (state.view === 'motifs') {
    return `<button type="button" class="result-card motif-result-card ${selected ? 'selected' : ''}" data-result-id="${item.id}"><span class="result-card-copy"><span class="result-kicker">${escapeHtml(item.level)} · ${escapeHtml(familyLabel(familyForMotif(item)))}</span><strong>${escapeHtml(item.label)}</strong><span class="result-meta">${formatCount(item.paper_count)} papers · ${item.first_year || '—'}–${item.last_year || '—'}</span></span>${motifSparklineMarkup(item, state.atlas.corpus_papers_by_year || {})}</button>`
  }
  if (state.view === 'devices') {
    return `<button type="button" class="result-card ${selected ? 'selected' : ''}" data-result-id="${item.id}"><span class="result-kicker">${item.year || 'Year unknown'}${item.maturity ? ` · ${escapeHtml(displayLabel(item.maturity))}` : ''}</span><strong>${escapeHtml(item.label)}</strong><span>${item.motif_ids.length} motifs · ${escapeHtml(item.paper_title)}</span></button>`
  }
  return `<button type="button" class="result-card ${selected ? 'selected' : ''}" data-result-id="${item.id}"><span class="result-kicker">${item.year || 'Year unknown'} · ${item.device_ids.length} device${item.device_ids.length === 1 ? '' : 's'}</span><strong>${escapeHtml(item.label)}</strong><span>${item.motif_ids.length} motifs${item.doi ? ` · ${escapeHtml(item.doi)}` : ''}</span></button>`
}

function resultsMarkup(items) {
  const shown = items.slice(0, state.resultLimit)
  return `<aside class="results-panel" aria-label="${VIEWS[state.view].label} results">
    <div class="panel-heading"><div><span>${VIEWS[state.view].label}</span><strong>${formatCount(items.length)}</strong></div></div>
    <div class="result-list">${shown.map(resultCardMarkup).join('')}${shown.length ? '' : '<p class="empty-state">No matches.</p>'}</div>
    ${items.length > shown.length ? `<button type="button" class="load-more" id="load-more">Show ${Math.min(40, items.length - shown.length)} more</button>` : ''}
  </aside>`
}

function networkTitle() {
  if (state.view === 'motifs') return 'Motif network'
  if (state.view === 'devices') return 'Devices sharing motifs'
  return 'Papers sharing motifs'
}

function networkPanelMarkup() {
  return `<section class="network-panel" aria-label="${networkTitle()}">
    <div id="network" class="network-host"><div class="network-loading">Loading network…</div></div>
    <div class="network-tuning">
      <div class="network-actions network-footer-actions" aria-label="Network view controls"><button type="button" data-network-action="fit">Fit</button><button type="button" data-network-action="labels">${state.showLabels ? 'Hide labels' : 'Show labels'}</button><button type="button" data-network-action="mode">${state.networkMode.toUpperCase()}</button></div>
      <label><span>Node size</span><input id="node-size-scale" type="range" min="0.5" max="2" step="0.1" value="${state.nodeSizeScale}"/><output>${state.nodeSizeScale.toFixed(1)}×</output></label>
      <label><span>Edge opacity</span><input id="edge-opacity" type="range" min="0.05" max="1" step="0.05" value="${state.edgeOpacity}"/><output>${Math.round(state.edgeOpacity * 100)}%</output></label>
    </div>
  </section>`
}

function adoptionPanelMarkup() {
  const candidates = activeItems()
  const corpus = state.atlas.corpus_papers_by_year || {}
  const groups = motifTimelineGroups(candidates, corpus, state.atlas.timeline_policy)
  const measureLabel = state.adoptionMeasure === 'share' ? 'Share of corpus papers each year' : 'Papers per year'
  return `<section class="adoption-panel" aria-label="Motif adoption timelines">
    <div class="adoption-panel-header"><div><h2>Motif adoption</h2><span>${escapeHtml(measureLabel)}</span></div><div class="measure-switch" aria-label="Timeline measure"><button type="button" data-adoption-measure="papers" class="${state.adoptionMeasure === 'papers' ? 'active' : ''}">Absolute</button><button type="button" data-adoption-measure="share" class="${state.adoptionMeasure === 'share' ? 'active' : ''}">Relative</button></div></div>
    <div class="adoption-panel-body">
      ${adoptionTimelineChartMarkup({ title: 'Top 10 overall', nodes: groups.overall, years: groups.years, corpusPapersByYear: corpus, measure: state.adoptionMeasure, selectedId: state.selected.motifs })}
      ${adoptionTimelineChartMarkup({ title: `Emerging since ${groups.recentStart || '—'}`, nodes: groups.emerging, years: groups.years, corpusPapersByYear: corpus, measure: state.adoptionMeasure, selectedId: state.selected.motifs })}
      <p class="adoption-definition">Emerging motifs exclude the overall top 10 and appeared in less than 1% of papers before ${groups.recentStart || 'the recent period'}.</p>
    </div>
  </section>`
}

function centerPanelMarkup() {
  return state.view === 'motifs' && state.motifCenterView === 'adoption'
    ? adoptionPanelMarkup()
    : networkPanelMarkup()
}

function statGrid(items) {
  return `<div class="stat-grid">${items.filter(([, value]) => value !== '' && value !== null && value !== undefined).map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('')}</div>`
}

function motifChips(ids, limit = 14) {
  const unique = [...new Set(ids)].slice(0, limit)
  return `<div class="chip-list">${unique.map((id) => `<button type="button" data-open-view="motifs" data-open-id="${id}">${escapeHtml(motifLabel(id))}</button>`).join('')}${ids.length > limit ? `<span>+${ids.length - limit}</span>` : ''}</div>`
}

function motifAdoptionDetailMarkup(node) {
  return `<section class="detail-section motif-adoption-detail"><div class="detail-section-heading"><h3>Adoption over time</h3><div class="mini-switch" aria-label="Adoption measure"><button type="button" data-adoption-measure="papers" class="${state.adoptionMeasure === 'papers' ? 'active' : ''}">Papers</button><button type="button" data-adoption-measure="share" class="${state.adoptionMeasure === 'share' ? 'active' : ''}">Share</button></div></div>${detailAdoptionChartMarkup(node, state.atlas.corpus_papers_by_year || {}, state.adoptionMeasure)}</section>`
}

function motifCharacteristicDetailMarkup(node) {
  const trends = motifCharacteristicTrends(node.id, state.engineering, state.atlas.nodes)
  if (!trends.series.length) return ''
  const requested = state.characteristicSelections[node.id]
  const selected = trends.series.find((series) => series.key === requested) || trends.series[0]
  state.characteristicSelections[node.id] = selected.key
  const eligibleScopes = selected.scopes.filter((scope) => scope.observationCount > 10)
  const scopeKey = `${node.id}|${selected.key}`
  const requestedScope = state.characteristicScopeSelections[scopeKey]
  const scopePriority = ['whole_device', 'component', 'fabrication_process', 'simulation', 'experimental_setup', 'unspecified']
  const defaultScope = scopePriority.map((scope) => eligibleScopes.find((item) => item.scope === scope)).find(Boolean) || eligibleScopes[0]
  const selectedScope = requestedScope === 'all'
    ? null
    : eligibleScopes.find((scope) => scope.scope === requestedScope) || defaultScope
  const plotted = selectedScope ? {
    ...selected,
    observations: selectedScope.observations,
    observationCount: selectedScope.observationCount,
    deviceCount: selectedScope.deviceCount,
  } : selected
  if (requestedScope === undefined && selectedScope) state.characteristicScopeSelections[scopeKey] = selectedScope.scope
  return `<section class="detail-section characteristic-trends"><div class="detail-section-heading"><h3>Reported values over time</h3><span>${formatCount(trends.deviceCount)} motif devices</span></div>
    <div class="characteristic-controls"><label class="characteristic-picker"><span>Characteristic</span><select id="motif-characteristic">${trends.series.map((series) => `<option value="${escapeHtml(series.key)}" ${series.key === selected.key ? 'selected' : ''}>${escapeHtml(displayLabel(series.displayMetric))} (${escapeHtml(series.unit)}) · ${formatCount(series.observationCount)}</option>`).join('')}</select></label>
    ${eligibleScopes.length ? `<label class="characteristic-picker"><span>Comparable scope</span><select id="motif-characteristic-scope">${eligibleScopes.map((scope) => `<option value="${escapeHtml(scope.scope)}" ${scope.scope === selectedScope?.scope ? 'selected' : ''}>${escapeHtml(displayLabel(scope.scope))} · ${formatCount(scope.observationCount)}</option>`).join('')}<option value="all" ${selectedScope ? '' : 'selected'}>All scopes (mixed) · ${formatCount(selected.observationCount)}</option></select></label>` : ''}</div>
    <div class="characteristic-chart-heading"><strong>${escapeHtml(displayLabel(selected.displayMetric))}${selectedScope ? ` · ${escapeHtml(displayLabel(selectedScope.scope))}` : ''}</strong><span>${formatCount(plotted.observationCount)} observations · ${formatCount(plotted.deviceCount)} devices · ${escapeHtml(plotted.unit)}</span></div>
    ${characteristicScatterMarkup(plotted, adoptionYears(state.atlas.corpus_papers_by_year))}
    <p class="characteristic-caution">Each point is a reported implementation value. Different devices and measurement targets are not a single longitudinal trajectory.</p>
  </section>`
}

function motifDetailMarkup(node) {
  const implementations = implementationsForMotif(node.id, state.engineering, state.atlas.nodes)
  const recentDevices = [...new Map(implementations.slice().reverse().map((item) => [item.device_id, state.devices.find((device) => device.id === item.device_id)])).values()].filter(Boolean).slice(0, 6)
  const related = state.atlas.edges
    .filter((edge) => edge.source === node.id || edge.target === node.id)
    .filter((edge) => edge.group !== 'parent_of')
    .sort((a, b) => Number(b.weight || 0) - Number(a.weight || 0))
    .slice(0, 8)
    .map((edge) => edge.source === node.id ? edge.target : edge.source)
  return `<article class="entity-detail"><div class="detail-kicker">${escapeHtml(node.level)} · ${escapeHtml(familyLabel(familyForMotif(node)))}</div><h2>${escapeHtml(node.label)}</h2><p class="detail-summary">${escapeHtml(node.description || '')}</p>
    ${statGrid([['Papers', formatCount(node.paper_count)], ['Components', formatCount(node.component_count)], ['Years', node.first_year ? `${node.first_year}–${node.last_year}` : '—'], ['Implementations', formatCount(implementations.length)]])}
    ${motifAdoptionDetailMarkup(node)}
    ${motifCharacteristicDetailMarkup(node)}
    ${related.length ? `<section class="detail-section"><h3>Related motifs</h3>${motifChips(related, 8)}</section>` : ''}
    ${recentDevices.length ? `<section class="detail-section"><h3>Recent devices</h3><div class="compact-list">${recentDevices.map((device) => `<button type="button" data-open-view="devices" data-open-id="${device.id}"><strong>${escapeHtml(device.label)}</strong><span>${device.year} · ${escapeHtml(device.paper_title)}</span></button>`).join('')}</div></section>` : ''}
  </article>`
}

function measurementValue(row) {
  return normalizedObservationDisplay(row) || rawObservationDisplay(row).text
}

function measurementTable(rows) {
  const useful = rows.filter((row) => measurementValue(row)).slice(0, 18)
  if (!useful.length) return ''
  return `<section class="detail-section"><h3>Reported characteristics</h3><div class="data-table">${useful.map((row) => `<div><div><strong>${escapeHtml(displayLabel(row.characteristic_name || row.metric || 'Characteristic'))}</strong><span>${escapeHtml(displayLabel(row.scope || ''))}</span></div><b>${escapeHtml(measurementValue(row))}</b></div>`).join('')}</div>${rows.length > useful.length ? `<p class="subtle">Showing ${useful.length} of ${rows.length} accepted values.</p>` : ''}</section>`
}

function deviceDetailMarkup(device) {
  const values = measurementsForDevice(state.engineering, device.id)
  const components = componentsForDevice(state.engineering, device.id)
  const doi = doiUrl(device.doi)
  return `<article class="entity-detail"><div class="detail-kicker">Device · ${device.year || 'year unknown'}${device.maturity ? ` · ${escapeHtml(displayLabel(device.maturity))}` : ''}</div><h2>${escapeHtml(device.label)}</h2><p class="detail-summary">${escapeHtml(device.function || device.application || '')}</p>
    ${statGrid([['Variants', formatCount(device.variant_ids.length)], ['Components', formatCount(device.component_ids.length)], ['Interfaces', formatCount(device.interface_ids.length)], ['Values', formatCount(values.length)]])}
    <section class="detail-section"><h3>Paper</h3><button type="button" class="paper-link" data-open-view="papers" data-open-id="${device.paper_id}">${escapeHtml(device.paper_title)}</button>${doi ? `<a class="external-link" href="${escapeHtml(doi)}" target="_blank" rel="noopener noreferrer">Open DOI ↗</a>` : ''}</section>
    ${device.application || device.environment ? `<section class="detail-section detail-facts">${device.application ? `<div><span>Application</span><p>${escapeHtml(device.application)}</p></div>` : ''}${device.environment ? `<div><span>Environment</span><p>${escapeHtml(device.environment)}</p></div>` : ''}</section>` : ''}
    ${device.motif_ids.length ? `<section class="detail-section"><h3>Functional motifs</h3>${motifChips(device.motif_ids)}</section>` : ''}
    ${measurementTable(values)}
    ${components.length ? `<section class="detail-section"><h3>Components</h3><ul class="plain-list">${components.slice(0, 12).map((row) => `<li>${escapeHtml(row.name || row.component_name || 'Component')}</li>`).join('')}</ul>${components.length > 12 ? `<p class="subtle">${components.length - 12} more components</p>` : ''}</section>` : ''}
  </article>`
}

function paperDetailMarkup(paper) {
  const devices = paper.device_ids.map((id) => state.devices.find((device) => device.id === id)).filter(Boolean)
  const doi = doiUrl(paper.doi)
  const measurementCount = paper.record_counts.accepted_measurement_ids || 0
  return `<article class="entity-detail"><div class="detail-kicker">Paper · ${paper.year || 'year unknown'}</div><h2>${escapeHtml(paper.label)}</h2>${paper.citation && paper.citation !== paper.label ? `<p class="detail-summary">${escapeHtml(paper.citation)}</p>` : ''}
    ${statGrid([['Devices', formatCount(devices.length)], ['Motifs', formatCount(paper.motif_ids.length)], ['Values', formatCount(measurementCount)]])}
    ${doi ? `<a class="primary-link" href="${escapeHtml(doi)}" target="_blank" rel="noopener noreferrer">Open paper via DOI ↗</a>` : ''}
    ${devices.length ? `<section class="detail-section"><h3>Devices in this paper</h3><div class="compact-list">${devices.map((device) => `<button type="button" data-open-view="devices" data-open-id="${device.id}"><strong>${escapeHtml(device.label)}</strong><span>${device.motif_ids.length} motifs · ${device.variant_ids.length} variants</span></button>`).join('')}</div></section>` : ''}
    ${paper.motif_ids.length ? `<section class="detail-section"><h3>Functional motifs</h3>${motifChips(paper.motif_ids)}</section>` : ''}
  </article>`
}

function edgeDetailMarkup(edge, graph) {
  const source = graph.nodes.find((node) => node.id === edge.source)
  const target = graph.nodes.find((node) => node.id === edge.target)
  const shared = sharedMotifLabels(edge, state.atlas.nodes)
  return `<article class="entity-detail"><div class="detail-kicker">${escapeHtml(displayLabel(edge.type || edge.group))}</div><h2>${escapeHtml(source?.label || edge.source)} <span class="arrow">${edge.directed ? '→' : '↔'}</span> ${escapeHtml(target?.label || edge.target)}</h2>${edge.weight ? statGrid([['Strength', formatCount(edge.weight)]]) : ''}${shared.length ? `<section class="detail-section"><h3>Shared motifs</h3>${motifChips(edge.shared_motif_ids)}</section>` : ''}</article>`
}

function detailMarkup(graph = currentGraph()) {
  if (state.selectedEdge) {
    const edge = graph.edges.find((item) => item.id === state.selectedEdge)
    if (edge) return edgeDetailMarkup(edge, graph)
  }
  const item = activeItem()
  if (!item) return `<div class="detail-empty"><div>${state.view === 'motifs' ? 'M' : state.view === 'devices' ? 'D' : 'P'}</div><h2>Select a ${VIEWS[state.view].singular}</h2></div>`
  if (state.view === 'motifs') return motifDetailMarkup(item)
  if (state.view === 'devices') return deviceDetailMarkup(item)
  return paperDetailMarkup(item)
}

function detailPanelMarkup(graph) {
  return `<aside id="detail-panel" class="detail-panel" aria-live="polite">${detailMarkup(graph)}</aside>`
}

function baseGraph() {
  const applied = state.appliedFilters[state.view]
  if (state.view === 'motifs') {
    let nodes = motifResults(state.atlas.nodes, { query: applied?.query || '', level: applied?.level || 'all', family: applied?.family || 'all' })
    if (!applied) nodes = state.atlas.nodes
    const selected = state.selected.motifs
    const selectedNode = selected ? state.atlas.nodes.find((node) => node.id === selected) : null
    if (selectedNode && !nodes.some((node) => node.id === selected)) nodes = [selectedNode, ...nodes]
    const ids = new Set(nodes.map((node) => node.id))
    return {
      view: 'motifs', nodes,
      edges: state.atlas.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
    }
  }
  return projectedEntityNetwork(state.engineering, state.atlas.nodes, {
    view: state.view === 'devices' ? 'device' : 'paper',
    query: applied?.query || '',
    maxNodes: Number.POSITIVE_INFINITY,
    minShared: state.minShared,
    topK: 8,
    selectedId: state.selected[state.view],
  })
}

function availableEdgeTypes(graph = baseGraph()) {
  return [...new Set(graph.edges.map(edgeCategory))].sort()
}

function currentGraph() {
  const graph = baseGraph()
  return { ...graph, edges: filterEdgesByCategory(graph.edges, state.edgeTypes[state.view]) }
}

function renderApp() {
  destroyNetwork()
  state.resultLimit = Math.max(40, state.resultLimit)
  const items = activeItems()
  const base = baseGraph()
  const graph = { ...base, edges: filterEdgesByCategory(base.edges, state.edgeTypes[state.view]) }
  app.innerHTML = `${headerMarkup()}${toolbarMarkup(base)}<main class="workspace">${resultsMarkup(items)}${centerPanelMarkup()}${detailPanelMarkup(graph)}</main>`
  bindUiEvents()
  if (state.view !== 'motifs' || state.motifCenterView === 'network') {
    const expectedVersion = renderVersion + 1
    void renderNetwork(graph).catch((error) => {
      if (renderVersion !== expectedVersion) return
      const host = document.querySelector('#network')
      if (host) host.innerHTML = `<div class="network-loading">Could not render network: ${escapeHtml(error.message)}</div>`
    })
  }
  updateUrl()
}

function bindResultEvents() {
  document.querySelectorAll('[data-result-id]').forEach((button) => button.addEventListener('click', () => selectItem(button.dataset.resultId, true)))
  document.querySelector('#load-more')?.addEventListener('click', () => { state.resultLimit += 40; updateLiveFiltering() })
}

function updateFilterActions() {
  const apply = document.querySelector('#apply-network-filter')
  if (!apply) return
  apply.disabled = !filterIsPending()
  apply.textContent = `Apply to network (${formatCount(activeItems().length)})`
}

function updateLiveFiltering() {
  const panel = document.querySelector('.results-panel')
  if (panel) panel.outerHTML = resultsMarkup(activeItems())
  const adoptionPanel = document.querySelector('.adoption-panel')
  if (adoptionPanel) adoptionPanel.outerHTML = adoptionPanelMarkup()
  bindResultEvents()
  bindTrendEvents(document.querySelector('.adoption-panel'))
  updateFilterActions()
  applyLiveHighlights()
  updateUrl()
}

function bindUiEvents() {
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => {
    state.view = button.dataset.view
    state.query = ''
    state.resultLimit = 40
    state.selectedEdge = null
    renderApp()
  }))
  const search = document.querySelector('#entity-search')
  search?.addEventListener('input', (event) => {
    state.query = event.target.value
    state.resultLimit = 40
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      updateLiveFiltering()
    }, 120)
  })
  document.querySelector('#motif-level')?.addEventListener('change', (event) => { state.motifLevel = event.target.value; state.resultLimit = 40; updateLiveFiltering() })
  document.querySelector('#motif-family')?.addEventListener('change', (event) => { state.motifFamily = event.target.value; state.resultLimit = 40; updateLiveFiltering() })
  document.querySelector('#minimum-shared')?.addEventListener('change', (event) => { state.minShared = Number(event.target.value); renderApp() })
  document.querySelectorAll('[data-center-view]').forEach((button) => button.addEventListener('click', () => {
    state.motifCenterView = button.dataset.centerView
    renderApp()
  }))
  document.querySelector('#apply-network-filter')?.addEventListener('click', () => {
    state.appliedFilters[state.view] = normalizedFilterSnapshot()
    state.selectedEdge = null
    renderApp()
  })
  document.querySelector('#clear-network-filter')?.addEventListener('click', () => {
    state.appliedFilters[state.view] = null
    state.selectedEdge = null
    renderApp()
  })
  document.querySelectorAll('[data-edge-type]').forEach((input) => input.addEventListener('change', () => {
    const available = [...document.querySelectorAll('[data-edge-type]')].map((item) => item.dataset.edgeType)
    const selected = new Set(state.edgeTypes[state.view] === null ? available : state.edgeTypes[state.view])
    if (input.checked) selected.add(input.dataset.edgeType)
    else selected.delete(input.dataset.edgeType)
    state.edgeTypes[state.view] = [...selected]
    state.selectedEdge = null
    renderApp()
  }))
  document.querySelectorAll('[data-edge-filter-action]').forEach((button) => button.addEventListener('click', () => {
    state.edgeTypes[state.view] = button.dataset.edgeFilterAction === 'all' ? null : []
    state.selectedEdge = null
    renderApp()
  }))
  document.querySelector('#node-size-scale')?.addEventListener('input', (event) => {
    state.nodeSizeScale = Number(event.target.value)
    if (networkRuntime?.ready) networkRuntime.helios.nodeSizeScale(state.nodeSizeScale)
    event.currentTarget.nextElementSibling.textContent = `${state.nodeSizeScale.toFixed(1)}×`
  })
  document.querySelector('#edge-opacity')?.addEventListener('input', (event) => {
    state.edgeOpacity = Number(event.target.value)
    if (networkRuntime?.ready) networkRuntime.helios.edgeOpacityScale(state.edgeOpacity)
    event.currentTarget.nextElementSibling.textContent = `${Math.round(state.edgeOpacity * 100)}%`
  })
  bindResultEvents()
  bindDetailLinks()
  bindTrendEvents()
}

function bindDetailLinks() {
  document.querySelectorAll('[data-open-view]').forEach((button) => button.addEventListener('click', () => {
    state.view = button.dataset.openView
    state.query = ''
    state.selected[state.view] = button.dataset.openId
    state.selectedEdge = null
    state.resultLimit = 40
    renderApp()
  }))
}

function refreshDetail() {
  const detail = document.querySelector('#detail-panel')
  if (detail) detail.innerHTML = detailMarkup(networkRuntime?.graph || currentGraph())
  bindDetailLinks()
  bindTrendEvents(detail)
}

function bindTrendEvents(root = document) {
  if (!root) return
  root.querySelectorAll('[data-adoption-id]').forEach((element) => element.addEventListener('click', (event) => {
    event.stopPropagation()
    selectItem(element.dataset.adoptionId, false)
  }))
  root.querySelectorAll('.adoption-chart').forEach((chart) => chart.addEventListener('click', (event) => {
    if (event.target.closest?.('[data-adoption-id]')) return
    clearSelection(false)
  }))
  root.querySelectorAll('[data-adoption-measure]').forEach((button) => button.addEventListener('click', () => {
    if (state.adoptionMeasure === button.dataset.adoptionMeasure) return
    state.adoptionMeasure = button.dataset.adoptionMeasure
    if (state.view === 'motifs' && state.motifCenterView === 'adoption') renderApp()
    else refreshDetail()
  }))
  root.querySelector('#motif-characteristic')?.addEventListener('change', (event) => {
    const motifId = state.selected.motifs
    if (!motifId) return
    state.characteristicSelections[motifId] = event.target.value
    refreshDetail()
  })
  root.querySelector('#motif-characteristic-scope')?.addEventListener('change', (event) => {
    const motifId = state.selected.motifs
    const seriesKey = state.characteristicSelections[motifId]
    if (!motifId || !seriesKey) return
    state.characteristicScopeSelections[`${motifId}|${seriesKey}`] = event.target.value
    refreshDetail()
  })
}

function selectItem(id, syncNetwork = false) {
  state.selected[state.view] = id
  state.selectedEdge = null
  document.querySelectorAll('[data-result-id]').forEach((button) => button.classList.toggle('selected', button.dataset.resultId === id))
  document.querySelectorAll('[data-adoption-id]').forEach((element) => element.classList.toggle('selected', element.dataset.adoptionId === id))
  refreshDetail()
  if (syncNetwork) syncNetworkSelection('node', id)
  updateUrl()
}

function clearSelection(syncNetwork = false) {
  state.selected[state.view] = null
  state.selectedEdge = null
  document.querySelectorAll('[data-result-id]').forEach((button) => button.classList.remove('selected'))
  document.querySelectorAll('[data-adoption-id]').forEach((element) => element.classList.remove('selected'))
  refreshDetail()
  if (syncNetwork) clearNetworkSelection()
  updateUrl()
}

function selectEdge(id, graph, syncNetwork = false) {
  state.selectedEdge = id
  const detail = document.querySelector('#detail-panel')
  if (detail) detail.innerHTML = detailMarkup(graph)
  bindDetailLinks()
  if (syncNetwork) syncNetworkSelection('edge', id)
}

function destroyNetwork() {
  renderVersion += 1
  if (!networkRuntime) return
  try { networkRuntime.helios?.destroy?.() } catch { networkRuntime.network?.dispose?.() }
  networkRuntime = null
}

function syncNetworkSelection(kind, id) {
  const runtime = networkRuntime
  if (!runtime?.helios || !runtime.ready) return
  const selection = runtime.helios.behavior?.selection
  if (!selection) return
  const index = kind === 'node' ? runtime.nodeIndex.get(id) : runtime.edgeIndex.get(id)
  if (index === undefined) return
  if (kind === 'node') {
    selection.selectNodes([index], { mode: 'replace', silent: true })
    selection.selectEdges([], { mode: 'replace', silent: true })
  } else {
    selection.selectEdges([index], { mode: 'replace', silent: true })
    selection.selectNodes([], { mode: 'replace', silent: true })
  }
}

function clearNetworkSelection() {
  const selection = networkRuntime?.helios?.behavior?.selection
  if (!selection || !networkRuntime?.ready) return
  selection.selectNodes([], { mode: 'replace', silent: true })
  selection.selectEdges([], { mode: 'replace', silent: true })
}

function applyLiveHighlights() {
  const runtime = networkRuntime
  if (!runtime?.helios || !runtime.ready) return
  const matchingIds = filterIsPending() ? new Set(activeItems().map((item) => item.id)) : new Set()
  const next = new Set([...matchingIds].map((id) => runtime.nodeIndex.get(id)).filter((id) => id !== undefined))
  const previous = runtime.highlightedNodes || new Set()
  const remove = [...previous].filter((id) => !next.has(id))
  const add = [...next].filter((id) => !previous.has(id))
  if (remove.length) runtime.helios.nodeState(remove, 'HIGHLIGHTED', { mode: 'remove' })
  if (add.length) runtime.helios.nodeState(add, 'HIGHLIGHTED', { mode: 'add' })
  runtime.highlightedNodes = next
}

function categoryForNode(node) {
  if (state.view === 'motifs') return familyForMotif(node)
  if (state.view === 'devices') return node.category || 'unknown'
  const year = Number(node.year || 0)
  return year ? `${Math.floor(year / 5) * 5}–${Math.floor(year / 5) * 5 + 4}` : 'unknown'
}

async function renderNetwork(graph = currentGraph()) {
  const host = document.querySelector('#network')
  if (!host) return
  const version = ++renderVersion
  const { nodes, edges } = graph
  if (!nodes.length) { host.innerHTML = '<div class="network-loading">No matching network nodes.</div>'; return }
  let network
  try { network = await HeliosNetwork.create({ directed: false }) } catch (error) {
    host.innerHTML = `<div class="network-loading">Could not initialize network: ${escapeHtml(error.message)}</div>`
    return
  }
  if (version !== renderVersion) { network.dispose(); return }
  const nodeHandles = network.addNodes(nodes.length)
  const nodeIndex = new Map(nodes.map((node, index) => [node.id, Number(nodeHandles[index])]))
  const nodeId = new Map(nodes.map((node, index) => [Number(nodeHandles[index]), node.id]))
  const validEdges = edges.filter((edge) => nodeIndex.has(edge.source) && nodeIndex.has(edge.target))
  const edgeHandles = validEdges.length ? network.addEdges(validEdges.map((edge) => [nodeIndex.get(edge.source), nodeIndex.get(edge.target)])) : []
  const edgeIndex = new Map(validEdges.map((edge, index) => [edge.id, Number(edgeHandles[index])]))
  const edgeId = new Map(validEdges.map((edge, index) => [Number(edgeHandles[index]), edge.id]))
  const degree = new Map(nodes.map((node) => [node.id, 0]))
  validEdges.forEach((edge) => { degree.set(edge.source, degree.get(edge.source) + 1); degree.set(edge.target, degree.get(edge.target) + 1) })
  const categories = [...new Set(nodes.map(categoryForNode))].sort()
  const categoryIndex = new Map(categories.map((category, index) => [category, index]))
  const edgeTypes = [...new Set(validEdges.map(edgeCategory))].sort()
  const edgeTypeIndex = new Map(edgeTypes.map((type, index) => [type, index]))
  const scores = nodes.map((node) => Math.log1p(Number(node.paper_count || node.score || 1)) + .5 * Math.log1p(degree.get(node.id) || 0))
  network
    .nodeAttribute('label', (_current, _id, ordinal) => nodes[ordinal].label)
    .nodeAttribute('category', (_current, _id, ordinal) => categoryIndex.get(categoryForNode(nodes[ordinal])) || 0, { type: AttributeType.Category })
    .nodeAttribute('score', (_current, _id, ordinal) => scores[ordinal], { type: AttributeType.Float })
  if (validEdges.length) network.edgeAttribute('category', (_current, _id, ordinal) => edgeTypeIndex.get(edgeCategory(validEdges[ordinal])) || 0, { type: AttributeType.Category })
  network.setNodeAttributeCategoryDictionary('category', categories.map((category, id) => ({ id, label: displayLabel(category) })), { remapExisting: false })
  if (validEdges.length) network.setEdgeAttributeCategoryDictionary('category', edgeTypes.map((type, id) => ({ id, label: displayLabel(type) })), { remapExisting: false })
  host.innerHTML = '<div id="network-stage" class="network-stage"></div>'
  const helios = new Helios(network, {
    container: host.querySelector('#network-stage'),
    mode: state.networkMode,
    storage: false,
    session: false,
    fileDrop: false,
    ui: false,
    quickControls: false,
    autoCleanup: false,
    disposeNetworkOnDestroy: true,
  })
  networkRuntime = { helios, network, graph: { ...graph, edges: validEdges }, nodeIndex, edgeIndex, highlightedNodes: new Set(), ready: false }
  try { await helios.ready } catch (error) {
    if (version === renderVersion) host.innerHTML = `<div class="network-loading">Could not render network: ${escapeHtml(error.message)}</div>`
    return
  }
  if (version !== renderVersion) { helios.destroy(); return }
  networkRuntime.ready = true
  const mapper = helios.behavior.mappers
  mapper.setChannelConfig('node', 'color', { type: 'categorical', attributes: 'category', domain: categories.map((_, index) => index), range: categories.map((_, index) => `${CATEGORY10[index % CATEGORY10.length]}ff`) })
  mapper.setChannelConfig('node', 'size', { type: 'linear', attributes: 'score', domain: [0, Math.max(...scores, 1)], range: [4, 12] })
  mapper.setChannelConfig('node', 'outline', { type: 'constant', value: .15 })
  if (edgeTypes.length) mapper.setChannelConfig('edge', 'color', { type: 'categorical', attributes: 'category', domain: edgeTypes.map((_, index) => index), range: edgeTypes.map((type, index) => `${EDGE_COLORS[type] || CATEGORY10[index % CATEGORY10.length]}c8`) })
  helios.nodeOutlineWidthScale(5)
  helios.nodeOutlineWidthBase(.15)
  helios.nodeOutlineColor('#ffffff80')
  helios.nodeSizeScale(state.nodeSizeScale)
  helios.edgeOpacityScale(state.edgeOpacity)
  helios.nodeStateStyle('HIGHLIGHTED', { sizeMul: 1.35, outlineMul: 2.2, forceMaxAlpha: true })
  helios.behavior.labels.enabled(state.showLabels)
  helios.on(EVENTS.NODE_CLICK, (event) => {
    const id = nodeId.get(Number(event.detail?.index))
    if (id) selectItem(id, false)
  })
  helios.on(EVENTS.EDGE_CLICK, (event) => {
    const id = edgeId.get(Number(event.detail?.index))
    if (id) selectEdge(id, networkRuntime.graph, false)
  })
  helios.on(EVENTS.GRAPH_CLICK, (event) => {
    if (!event.detail?.kind) clearSelection(true)
  })
  bindNetworkActions(helios)
  const selected = state.selected[state.view]
  if (selected) syncNetworkSelection('node', selected)
  applyLiveHighlights()
  await new Promise((resolve) => setTimeout(resolve, 500))
  if (version === renderVersion) helios.frameNetwork({ animate: false, paddingRatio: .05 })
}

function bindNetworkActions(helios) {
  document.querySelector('[data-network-action="fit"]')?.addEventListener('click', () => helios.frameNetwork({ animate: true, durationMs: 350, paddingRatio: .05 }))
  document.querySelector('[data-network-action="labels"]')?.addEventListener('click', (event) => {
    state.showLabels = !state.showLabels
    helios.behavior.labels.enabled(state.showLabels)
    event.currentTarget.textContent = state.showLabels ? 'Hide labels' : 'Show labels'
  })
  document.querySelector('[data-network-action="mode"]')?.addEventListener('click', (event) => {
    const button = event.currentTarget
    void switchNetworkMode({
      helios,
      button,
      currentMode: state.networkMode,
      onModeChange: (mode) => { state.networkMode = mode },
      isCurrent: () => networkRuntime?.helios === helios,
      onError: (error) => { button.title = `Could not switch mode: ${error.message}` },
    })
  })
}

async function load() {
  app.innerHTML = '<div class="app-loading"><strong>Device motif atlas</strong><span>Loading public research data…</span></div>'
  try {
    const [atlasResponse, engineeringResult] = await Promise.all([
      fetch('./data/hierarchical_motifs.json'),
      fetchEngineeringBundle(fetch),
    ])
    if (!atlasResponse.ok) throw new Error(`Motif atlas: ${atlasResponse.status}`)
    state.atlas = await atlasResponse.json()
    state.engineering = engineeringBundleToCharacteristics(engineeringResult.bundle)
    state.devices = deviceCatalog(state.engineering, state.atlas.nodes)
    state.papers = paperCatalog(state.engineering, state.atlas.nodes, state.devices)
    initialStateFromUrl()
    renderApp()
  } catch (error) {
    app.innerHTML = `<div class="app-loading error"><strong>Could not load the atlas</strong><span>${escapeHtml(error.message)}</span></div>`
  }
}

load()
