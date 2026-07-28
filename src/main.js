import './style.css'
import HeliosNetwork, { AttributeType } from 'helios-network'
import { EVENTS, Helios } from 'helios-web'

const CATEGORY10 = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf']
const EDGE_GROUPS = [
  ['parent_of', 'Hierarchy'],
  ['used_with', 'Used with'],
  ['similarity', 'Similarity'],
  ['lifecycle', 'Lifecycle'],
]

const state = {
  data: null,
  query: '',
  levels: new Set(['L1', 'L2', 'L3']),
  family: 'all',
  edgeGroups: new Set(EDGE_GROUPS.map(([id]) => id)),
  selectedNode: null,
  selectedEdge: null,
  networkMode: '2d',
  showNetworkLabels: true,
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

function searchable(node) {
  return [
    node.label,
    node.description,
    ...(node.aliases || []),
    ...(node.facets || []).flatMap((facet) => [facet.label, facet.description, facet.category]),
  ].join(' ').toLocaleLowerCase()
}

function filteredNodes() {
  const query = state.query.trim().toLocaleLowerCase()
  return state.data.nodes.filter((node) => {
    if (!state.levels.has(node.level)) return false
    if (state.family !== 'all' && familyFor(node) !== state.family && node.id !== state.family) return false
    return !query || searchable(node).includes(query)
  })
}

function timelineGroups() {
  const denominators = state.data.corpus_papers_by_year || {}
  const years = Object.keys(denominators).map(Number).sort((a, b) => a - b)
  if (!years.length) return { years, overall: [], emerging: [], recentStart: null }
  const policy = state.data.timeline_policy || {}
  const topN = Number(policy.top_n || 10)
  const recentStart = years.at(-1) - Number(policy.recent_year_window || 5) + 1
  const candidates = filteredNodes().filter((node) => !node.pending)
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
    <div class="section-heading"><div><p class="eyebrow">Usage through time</p><h2 id="timeline-title">Motif timelines</h2></div><p>Timelines follow the active level, family, and search filters. Emerging = outside the filtered top 10, &lt;1% of pre-${recentStart} papers, ranked over ${recentStart}–${years.at(-1)}.</p></div>
    <div class="timeline-measure"><h3>Absolute usage <span>papers per year</span></h3><div class="timeline-grid">${timelineChartMarkup('absolute-overall', 'Top 10 in current view', overall, years, false)}${timelineChartMarkup('absolute-emerging', 'Emerging in current view', emerging, years, false)}</div></div>
    <div class="timeline-measure"><h3>Relative usage <span>share of Rogers papers that year</span></h3><div class="timeline-grid">${timelineChartMarkup('relative-overall', 'Top 10 in current view', overall, years, true)}${timelineChartMarkup('relative-emerging', 'Emerging in current view', emerging, years, true)}</div></div>
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
        <input id="search" type="search" value="${escapeHtml(state.query)}" placeholder="Label, description, alias, or facet…" autocomplete="off" />
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
        <h1>Rogers motif atlas</h1>
        <p class="lede">Explore the hierarchy from functional families to recurrent motifs and implementation variants, with evidence-weighted relationships.</p>
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
      ${node.evidence_samples?.length ? `<div class="evidence-samples"><h4>Evidence examples</h4>${node.evidence_samples.slice(0, 3).map((item) => `<blockquote><p>“${escapeHtml(item.quote)}”</p><footer>${escapeHtml(item.document_title || item.paper_id)} · ${item.year || 'year unknown'} · p. ${item.page || '?'}</footer></blockquote>`).join('')}</div>` : ''}
    </div>`
  }
  return `<div class="empty-detail"><span aria-hidden="true">◎</span><p>Select a node to keep it and its neighbors highlighted. Select an edge for its weight and time span.</p></div>`
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
        <div class="section-heading"><div><p class="eyebrow">Multiresolution map</p><h2 id="network-title">How motifs connect</h2></div>${edgeFiltersMarkup()}</div>
        <div class="network-layout"><div id="network" class="network" aria-label="Interactive motif network"></div><aside id="detail" class="detail-panel" tabindex="0" aria-label="Selected motif details" aria-live="polite">${detailMarkup()}</aside></div>
        <p class="network-help">Click a node or edge to inspect it. Drag to orbit or pan; scroll to zoom. Double-click a node to focus it. Shift-click adds to the selection.</p>
      </section>
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
}

function selectNode(id, scrollToNetwork = false, syncNetwork = true) {
  state.selectedNode = id
  state.selectedEdge = null
  if (syncNetwork) syncHeliosSelection('node', id)
  updateSelectionStyles()
  document.querySelector('#detail').innerHTML = detailMarkup()
  document.querySelectorAll('[data-node-card]').forEach((card) => card.classList.toggle('selected', card.dataset.nodeCard === id))
  if (scrollToNetwork) document.querySelector('#network-section').scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function selectEdge(id, syncNetwork = true) {
  state.selectedEdge = id
  state.selectedNode = null
  if (syncNetwork) syncHeliosSelection('edge', id)
  updateSelectionStyles()
  document.querySelector('#detail').innerHTML = detailMarkup()
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

function networkStageMarkup() {
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
      <span><i class="key-color"></i> color = L1 family</span>
    </div>
    <div class="network-tooltip" role="status" aria-live="polite"></div>`
}

function tooltipPosition(host, tooltip, detail) {
  const bounds = host.getBoundingClientRect()
  const x = Math.max(12, Math.min(bounds.width - 250, Number(detail.clientX || 0) - bounds.left + 14))
  const y = Math.max(58, Math.min(bounds.height - 105, Number(detail.clientY || 0) - bounds.top + 14))
  tooltip.style.transform = `translate(${x}px, ${y}px)`
}

function bindHeliosEvents(helios, host, nodes, edges, nodeIdByIndex, edgeIdByIndex) {
  const tooltip = host.querySelector('.network-tooltip')
  helios.on(EVENTS.NODE_CLICK, (event) => {
    const id = nodeIdByIndex.get(Number(event.detail?.index))
    if (id) selectNode(id, false, false)
  })
  helios.on(EVENTS.EDGE_CLICK, (event) => {
    const id = edgeIdByIndex.get(Number(event.detail?.index))
    if (id) selectEdge(id, false)
  })
  helios.on(EVENTS.GRAPH_CLICK, (event) => {
    if (event.detail?.kind) return
    state.selectedNode = null
    state.selectedEdge = null
    document.querySelector('#detail').innerHTML = detailMarkup()
    updateSelectionStyles()
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
    tooltip.innerHTML = `<strong>${escapeHtml(node.label)}</strong><span>${escapeHtml(node.level)} · ${formatCount(node.paper_count)} papers · ${escapeHtml(familyLabel(familyFor(node)))}</span>`
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
    const source = state.data.nodes.find((item) => item.id === edge.source)
    const target = state.data.nodes.find((item) => item.id === edge.target)
    tooltip.innerHTML = `<strong>${escapeHtml(edge.type.replaceAll('_', ' '))}</strong><span>${escapeHtml(source?.label || edge.source)} ↔ ${escapeHtml(target?.label || edge.target)} · weight ${formatCount(edge.weight)}</span>`
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
  const { nodes, edges } = visibleGraph()
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
  const familyIndexes = new Map(families.map((node, index) => [node.id, index]))
  const levelIndexes = new Map([['L1', 0], ['L2', 1], ['L3', 2]])
  const nodeScores = nodes.map((node) => {
    const evidence = Math.log1p(Number(node.paper_count || 0))
    const connectivity = Math.log1p(Number(degree.get(node.id) || 0))
    const levelBoost = node.level === 'L1' ? 2.6 : node.level === 'L2' ? 0.8 : 0
    return evidence + 0.7 * connectivity + levelBoost
  })
  const edgeScores = edges.map((edge) => Math.log1p(Number(edge.weight || 1)))
  const edgeGroupIndexes = new Map(EDGE_GROUPS.map(([id], index) => [id, index]))

  network
    .nodeAttribute('label', (_current, _id, ordinal) => nodes[ordinal].label)
    .nodeAttribute('family_category', (_current, _id, ordinal) => familyIndexes.get(familyFor(nodes[ordinal])) ?? 0, { type: AttributeType.Category })
    .nodeAttribute('level_index', (_current, _id, ordinal) => levelIndexes.get(nodes[ordinal].level) ?? 1, { type: AttributeType.Integer })
    .nodeAttribute('visual_score', (_current, _id, ordinal) => nodeScores[ordinal], { type: AttributeType.Float })
    .nodeAttribute('paper_count', (_current, _id, ordinal) => Number(nodes[ordinal].paper_count || 0), { type: AttributeType.Integer })
    .edgeAttribute('relationship_category', (_current, _id, ordinal) => edgeGroupIndexes.get(edges[ordinal].group) ?? 0, { type: AttributeType.Category })
    .edgeAttribute('visual_score', (_current, _id, ordinal) => edgeScores[ordinal], { type: AttributeType.Float })

  network.setNodeAttributeCategoryDictionary(
    'family_category',
    families.map((family, id) => ({ id, label: family.label })),
    { remapExisting: false },
  )
  network.setEdgeAttributeCategoryDictionary(
    'relationship_category',
    EDGE_GROUPS.map(([, label], id) => ({ id, label })),
    { remapExisting: false },
  )

  host.innerHTML = networkStageMarkup()
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
        nodeColor: 'L1 family',
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

  const familyDomain = families.map((_, index) => index)
  const familyRange = families.map((family) => rgbaHex(familyColor(family.id)))
  const edgeRange = ['#94a3b8c7', '#0f766ed9', '#7c3aedcf', '#c2410cd9']
  const maxNodeScore = Math.max(1, ...nodeScores)
  const maxEdgeScore = Math.max(1, ...edgeScores)

  const mappers = helios.behavior.mappers
  mappers.setChannelConfig('node', 'color', { type: 'categorical', attributes: 'family_category', domain: familyDomain, range: familyRange, defaultValue: '#7f8b85ff' })
  mappers.setChannelConfig('node', 'size', { type: 'linear', attributes: 'visual_score', domain: [0, maxNodeScore], range: [3.6, 13.5] })
  mappers.setChannelConfig('node', 'opacity', { type: 'constant', value: 0.96 })
  mappers.setChannelConfig('edge', 'color', { type: 'categorical', attributes: 'relationship_category', domain: [0, 1, 2, 3], range: edgeRange, defaultValue: '#94a3b8b3' })
  mappers.setChannelConfig('edge', 'width', { type: 'linear', attributes: 'visual_score', domain: [0, maxEdgeScore], range: [0.45, 2.7] })
  mappers.setChannelConfig('edge', 'opacity', { type: 'constant', value: 0.38 })

  helios.nodeHoverStyle({ sizeMul: 1.7, opacityMul: 1, outlineMul: 2.4, forceMaxAlpha: true })
  helios.edgeHoverStyle({ widthMul: 2.5, opacityMul: 1.8, forceMaxAlpha: true })
  bindHeliosEvents(helios, host, nodes, edges, nodeIdByIndex, edgeIdByIndex)
  bindNetworkActions(helios, host)
  if (state.selectedNode) syncHeliosSelection('node', state.selectedNode)
  if (state.selectedEdge) syncHeliosSelection('edge', state.selectedEdge)
  await new Promise((resolve) => setTimeout(resolve, 900))
  if (renderVersion !== networkRenderVersion || !host.isConnected) return
  helios.frameNetwork({ animate: false, paddingRatio: 0.04 })
}

async function load() {
  try {
    const response = await fetch('./data/hierarchical_motifs.json')
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    state.data = await response.json()
    renderShell()
  } catch (error) {
    app.innerHTML = `<div class="fatal"><h1>Could not load motif data</h1><p>${escapeHtml(error.message)}</p><p>Generate <code>public/data/hierarchical_motifs.json</code> before serving the app.</p></div>`
  }
}

load()
