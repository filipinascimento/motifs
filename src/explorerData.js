function asArray(value) {
  return Array.isArray(value) ? value : []
}

export function normalizeText(value = '') {
  return String(value)
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim()
}

export function extractedTermPreview(values = [], limit = 8) {
  const seen = new Set()
  const uniqueValues = []
  for (const value of asArray(values)) {
    const text = String(value || '').trim()
    const key = normalizeText(text)
    if (!key || seen.has(key)) continue
    seen.add(key)
    uniqueValues.push(text)
  }
  const visible = uniqueValues.slice(0, Math.max(0, Number(limit) || 0))
  return { visible, total: uniqueValues.length, hidden: uniqueValues.length - visible.length }
}

function includesQuery(values, query) {
  const tokens = normalizeText(query).split(/\s+/u).filter(Boolean)
  if (!tokens.length) return true
  const fields = values.map(normalizeText)
  return tokens.every((token) => fields.some((field) => field.includes(token)))
}

function fieldsForScope(fieldMap, scope = 'all') {
  if (!scope || scope === 'all') return Object.values(fieldMap).flat()
  return asArray(fieldMap[scope])
}

export function readablePaperTitle(paper = {}, index = {}) {
  const title = String(paper.title || index.title || '').trim()
  const citation = String(paper.citation || index.citation || '').trim()
  const looksLikeFileStem = title && !/\s/u.test(title) && /^[\p{Letter}\p{Number}_.-]+$/u.test(title)
  if (!title || (looksLikeFileStem && citation.length > title.length + 12)) {
    return citation.replace(/\s*\([^()]*(?:19|20)\d{2}\)\s*$/u, '').trim() || title
  }
  return title
}

export function familyForMotif(node) {
  return node?.level === 'L1' ? node.id : node?.family_ids?.[0] || 'unassigned'
}

export function edgeCategory(edge = {}) {
  return edge.group || edge.type || 'link'
}

export function filterEdgesByCategory(edges = [], selectedCategories = null) {
  if (selectedCategories === null || selectedCategories === undefined) return asArray(edges)
  const selected = new Set(asArray(selectedCategories))
  return asArray(edges).filter((edge) => selected.has(edgeCategory(edge)))
}

export function motifResults(nodes = [], filters = {}) {
  return asArray(nodes)
    .filter((node) => !filters.level || filters.level === 'all' || node.level === filters.level)
    .filter((node) => !filters.family || filters.family === 'all' || familyForMotif(node) === filters.family || node.id === filters.family)
    .filter((node) => {
      const registry = filters.registry || 'all'
      if (registry === 'all') return true
      if (registry === 'recurrent') {
        return ['controlled_family', 'recurrent', 'canonical_recurrent'].includes(node.status)
          || node.canonical === true
      }
      if (filters.registry === 'observation') return node.status === 'single_source_observation'
      return false
    })
    .filter((node) => includesQuery(fieldsForScope({
      name: [node.label],
      description: [node.description],
      aliases: [node.id, ...asArray(node.aliases)],
      facets: asArray(node.facets).flatMap((facet) => [facet.label, facet.category]),
    }, filters.searchField), filters.query))
    .sort((a, b) => Number(b.paper_count || 0) - Number(a.paper_count || 0) || a.label.localeCompare(b.label))
}

export function deviceCatalog(characteristics, atlasNodes = []) {
  const motifById = new Map(asArray(atlasNodes).map((node) => [node.id, node]))
  const deviceEntityById = new Map(asArray(characteristics?.entities?.devices).map((row) => [row.device_id, row]))
  const paperById = new Map(asArray(characteristics?.papers).map((row) => [row.paper_id, row]))
  return Object.values(characteristics?.indexes?.devices || {}).map((index) => {
    const entity = deviceEntityById.get(index.device_id) || {}
    const paper = paperById.get(index.paper_id) || {}
    const directMotifs = asArray(index.direct_motif_ids).filter((id) => motifById.get(id)?.level !== 'L1')
    return {
      id: index.device_id,
      label: index.name || entity.author_provided_name || entity.descriptive_name || index.device_id,
      year: index.year || paper.publication_year || paper.year || '',
      paper_id: index.paper_id,
      paper_title: readablePaperTitle(paper) || paper.document_title || index.paper_id,
      doi: paper.doi || entity.doi || '',
      maturity: index.prototype_maturity || entity.prototype_maturity || '',
      contribution_role: index.contribution_role || entity.contribution_role || '',
      function: entity.intended_function || entity.function || '',
      application: entity.application || '',
      environment: entity.operating_environment || '',
      motif_ids: directMotifs,
      motif_labels: directMotifs.map((id) => motifById.get(id)?.label || id),
      variant_ids: asArray(index.variant_ids),
      component_ids: asArray(index.component_ids),
      interface_ids: asArray(index.interface_ids),
      record_counts: Object.fromEntries(Object.entries(index.records || {}).map(([key, values]) => [key, asArray(values).length])),
      index,
      entity,
    }
  })
}

export function deviceResults(devices = [], query = '', searchField = 'all') {
  return asArray(devices)
    .filter((device) => includesQuery(fieldsForScope({
      name: [device.label],
      title: [device.paper_title],
      description: [device.function, device.application, device.environment, device.maturity],
      motifs: device.motif_labels,
      identifiers: [device.id, device.doi, device.paper_id],
    }, searchField), query))
    .sort((a, b) => Number(b.year || 0) - Number(a.year || 0) || a.label.localeCompare(b.label))
}

export function paperCatalog(characteristics, atlasNodes = [], devices = []) {
  const motifById = new Map(asArray(atlasNodes).map((node) => [node.id, node]))
  const deviceById = new Map(asArray(devices).map((device) => [device.id, device]))
  const paperEntityById = new Map(asArray(characteristics?.papers).map((row) => [row.paper_id, row]))
  return Object.values(characteristics?.indexes?.papers || {}).map((index) => {
    const paper = paperEntityById.get(index.paper_id) || {}
    const linkedDevices = asArray(index.device_ids).map((id) => deviceById.get(id)).filter(Boolean)
    const motifIds = [...new Set(linkedDevices.flatMap((device) => device.motif_ids))]
    return {
      id: index.paper_id,
      label: readablePaperTitle(paper, index) || paper.document_title || index.paper_id,
      year: index.year || paper.publication_year || paper.year || '',
      doi: paper.doi || index.doi || '',
      citation: paper.citation || index.citation || '',
      device_ids: linkedDevices.map((device) => device.id),
      device_labels: linkedDevices.map((device) => device.label),
      motif_ids: motifIds,
      motif_labels: motifIds.map((id) => motifById.get(id)?.label || id),
      record_counts: Object.fromEntries(Object.entries(index.records || {}).map(([key, values]) => [key, asArray(values).length])),
      index,
      entity: paper,
    }
  })
}

export function paperResults(papers = [], query = '', searchField = 'all') {
  return asArray(papers)
    .filter((paper) => includesQuery(fieldsForScope({
      title: [paper.label, paper.citation],
      devices: paper.device_labels,
      motifs: paper.motif_labels,
      identifiers: [paper.id, paper.doi, paper.year],
    }, searchField), query))
    .sort((a, b) => Number(b.year || 0) - Number(a.year || 0) || a.label.localeCompare(b.label))
}

export function measurementsForDevice(characteristics, deviceId) {
  return asArray(characteristics?.observations)
    .filter((row) => row.device_id === deviceId)
    .sort((a, b) => Number(b.year || 0) - Number(a.year || 0)
      || String(a.characteristic_name || a.metric || '').localeCompare(String(b.characteristic_name || b.metric || '')))
}

export function componentsForDevice(characteristics, deviceId) {
  const variantIds = new Set(asArray(characteristics?.implementations)
    .filter((row) => row.device_id === deviceId)
    .map((row) => row.implementation_id))
  return asArray(characteristics?.entities?.components)
    .filter((row) => variantIds.has(row.device_variant_id))
    .sort((a, b) => String(a.name || a.component_name || '').localeCompare(String(b.name || b.component_name || '')))
}
