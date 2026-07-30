function asArray(value) {
  return Array.isArray(value) ? value : []
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function recordCount(index = {}) {
  return Object.values(index.records || {}).reduce((sum, values) => sum + asArray(values).length, 0)
}

function searchableText(...values) {
  return values.flat(Infinity).filter(Boolean).join(' ').toLocaleLowerCase()
}

function boundedNodes(nodes, maxNodes) {
  return [...nodes]
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0)
      || Number(b.year || 0) - Number(a.year || 0)
      || a.label.localeCompare(b.label))
    .slice(0, maxNodes)
}

function sharedSet(left, right) {
  const rightSet = new Set(right)
  return left.filter((value) => rightSet.has(value))
}

/**
 * Build a sparse, symmetric similarity projection. Candidate pairs are found
 * through an inverted motif index and then limited to each node's strongest
 * neighbors. This avoids the dense all-pairs graph that common motifs create.
 */
export function similarityEdges(nodes, { minShared = 2, topK = 8 } = {}) {
  const byMotif = new Map()
  for (const node of nodes) {
    for (const motifId of node.motif_ids || []) {
      const ids = byMotif.get(motifId) || []
      ids.push(node.id)
      byMotif.set(motifId, ids)
    }
  }
  const pairCounts = new Map()
  for (const [motifId, ids] of byMotif) {
    // A ubiquitous organizing motif does not produce an informative
    // projection by itself, but can still strengthen a pair supported by
    // additional shared motifs.
    for (let left = 0; left < ids.length; left += 1) {
      for (let right = left + 1; right < ids.length; right += 1) {
        const pair = ids[left] < ids[right] ? [ids[left], ids[right]] : [ids[right], ids[left]]
        const key = `${pair[0]}\u0000${pair[1]}`
        const item = pairCounts.get(key) || { source: pair[0], target: pair[1], motif_ids: [] }
        item.motif_ids.push(motifId)
        pairCounts.set(key, item)
      }
    }
  }
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const eligible = [...pairCounts.values()]
    .filter((edge) => edge.motif_ids.length >= minShared)
    .map((edge) => {
      const left = nodeById.get(edge.source)
      const right = nodeById.get(edge.target)
      const union = new Set([...(left?.motif_ids || []), ...(right?.motif_ids || [])]).size || 1
      return { ...edge, weight: edge.motif_ids.length, similarity: edge.motif_ids.length / union }
    })
  const neighbors = new Map(nodes.map((node) => [node.id, []]))
  for (const edge of eligible) {
    neighbors.get(edge.source)?.push(edge)
    neighbors.get(edge.target)?.push(edge)
  }
  const retained = new Set()
  for (const edges of neighbors.values()) {
    edges.sort((a, b) => b.weight - a.weight || b.similarity - a.similarity
      || a.source.localeCompare(b.source) || a.target.localeCompare(b.target))
      .slice(0, topK)
      .forEach((edge) => retained.add(`${edge.source}\u0000${edge.target}`))
  }
  return eligible
    .filter((edge) => retained.has(`${edge.source}\u0000${edge.target}`))
    .sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target))
    .map((edge) => ({
      id: `shared_motifs::${edge.source}::${edge.target}`,
      source: edge.source,
      target: edge.target,
      type: 'shared_motifs',
      group: 'shared_motifs',
      directed: false,
      weight: edge.weight,
      similarity: edge.similarity,
      shared_motif_ids: edge.motif_ids.sort(),
    }))
}

function deviceNodes(characteristics, atlasNodes, options) {
  const motifById = new Map(asArray(atlasNodes).map((node) => [node.id, node]))
  const query = String(options.query || '').trim().toLocaleLowerCase()
  return Object.values(characteristics?.indexes?.devices || {}).map((device) => {
    const directMotifs = asArray(device.direct_motif_ids).filter((id) => motifById.get(id)?.level !== 'L1')
    const scopeMotifs = asArray(device.motif_ids).length ? asArray(device.motif_ids) : directMotifs
    const motifLabels = directMotifs.map((id) => motifById.get(id)?.label || id)
    return {
      id: device.device_id,
      label: device.name || device.device_id,
      type: 'device',
      category: device.prototype_maturity || 'device',
      year: device.year,
      paper_id: device.paper_id,
      motif_ids: directMotifs,
      scope_motif_ids: scopeMotifs,
      motif_labels: motifLabels,
      score: directMotifs.length * 3 + recordCount(device),
      metadata: device,
      search: searchableText(device.name, device.device_id, device.prototype_maturity, device.contribution_role, motifLabels),
    }
  }).filter((node) => (!options.motifId || node.scope_motif_ids.includes(options.motifId)) && (!query || node.search.includes(query)))
}

function paperNodes(characteristics, atlasNodes, options) {
  const motifById = new Map(asArray(atlasNodes).map((node) => [node.id, node]))
  const devices = characteristics?.indexes?.devices || {}
  const query = String(options.query || '').trim().toLocaleLowerCase()
  return Object.values(characteristics?.indexes?.papers || {}).map((paper) => {
    const directMotifs = unique(asArray(paper.device_ids).flatMap((id) => asArray(devices[id]?.direct_motif_ids)))
      .filter((id) => motifById.get(id)?.level !== 'L1')
    const scopeMotifs = unique(asArray(paper.device_ids).flatMap((id) => asArray(devices[id]?.motif_ids).length ? asArray(devices[id]?.motif_ids) : asArray(devices[id]?.direct_motif_ids)))
    const motifLabels = directMotifs.map((id) => motifById.get(id)?.label || id)
    return {
      id: paper.paper_id,
      label: paper.title || paper.paper_id,
      type: 'paper',
      category: String(paper.year || 'year unknown'),
      year: paper.year,
      device_ids: asArray(paper.device_ids),
      motif_ids: directMotifs,
      scope_motif_ids: scopeMotifs,
      motif_labels: motifLabels,
      score: directMotifs.length * 2 + asArray(paper.device_ids).length * 3 + recordCount(paper),
      metadata: paper,
      search: searchableText(paper.title, paper.paper_id, paper.year, motifLabels),
    }
  }).filter((node) => (!options.motifId || node.scope_motif_ids.includes(options.motifId)) && (!query || node.search.includes(query)))
}

export function projectedEntityNetwork(characteristics, atlasNodes = [], options = {}) {
  const view = options.view || 'device'
  const maxNodes = Math.max(20, Number(options.maxNodes || 250))
  const minShared = Math.max(1, Number(options.minShared || 2))
  const topK = Math.max(1, Number(options.topK || 8))
  if (view === 'atomic') {
    const indexes = characteristics?.indexes || {}
    const indexByType = {
      paper: indexes.papers || {},
      device: indexes.devices || {},
      device_variant: indexes.variants || {},
      component: indexes.components || {},
      interface: indexes.interfaces || {},
      motif: indexes.motifs || {},
    }
    const nodes = asArray(characteristics?.graph?.nodes).map((node) => {
      const metadata = indexByType[node.type]?.[node.id] || {}
      const motifIds = node.type === 'motif' ? [node.id]
        : asArray(metadata.direct_motif_ids || metadata.motif_ids)
      return {
        id: node.id,
        label: node.label || node.id,
        type: node.type,
        category: node.type,
        year: metadata.year || '',
        paper_id: metadata.paper_id || (node.type === 'paper' ? node.id : ''),
        motif_ids: motifIds,
        score: 1 + recordCount(metadata),
        metadata,
      }
    })
    const edges = asArray(characteristics?.graph?.edges).map((edge) => ({
      id: edge.edge_id,
      source: edge.source_id,
      target: edge.target_id,
      type: edge.relation,
      group: edge.relation,
      directed: true,
      weight: 1,
    }))
    return {
      view,
      nodes,
      edges,
      candidateCount: nodes.length,
      note: 'Complete atomic graph: papers → devices → variants → components → motifs, including component interfaces and motif hierarchy.',
    }
  }
  if (view === 'device' || view === 'paper') {
    const candidates = view === 'device'
      ? deviceNodes(characteristics, atlasNodes, options)
      : paperNodes(characteristics, atlasNodes, options)
    const nodes = boundedNodes(candidates, maxNodes)
    return {
      view,
      nodes,
      edges: similarityEdges(nodes, { minShared, topK }),
      candidateCount: candidates.length,
      note: `${view === 'device' ? 'Devices' : 'Papers'} are linked only when they share at least ${minShared} directly assigned L2/L3 motifs.`,
    }
  }

  const allDevices = boundedNodes(deviceNodes(characteristics, atlasNodes, options), Math.max(10, Math.floor(maxNodes * .46)))
  const paperIds = new Set(allDevices.map((node) => node.paper_id))
  const allPapers = paperNodes(characteristics, atlasNodes, { ...options, motifId: '' })
    .filter((node) => paperIds.has(node.id))
  const motifIds = new Set(allDevices.flatMap((node) => node.motif_ids))
  const motifById = new Map(asArray(atlasNodes).map((node) => [node.id, node]))
  const allMotifNodes = [...motifIds].map((id) => {
    const motif = motifById.get(id) || { id, label: id }
    const deviceCount = allDevices.filter((device) => device.motif_ids.includes(id)).length
    return {
      id,
      label: motif.label || id,
      type: 'motif',
      category: motif.level || 'motif',
      motif_ids: [id],
      score: deviceCount * 4,
      metadata: motif,
    }
  })
  const motifSlots = Math.max(10, maxNodes - allPapers.length - allDevices.length)
  const motifNodes = boundedNodes(allMotifNodes, motifSlots)
  const nodes = [...allPapers, ...allDevices, ...motifNodes]
  const nodeIds = new Set(nodes.map((node) => node.id))
  const edges = []
  for (const device of allDevices) {
    if (nodeIds.has(device.paper_id)) {
      edges.push({ id: `reports::${device.paper_id}::${device.id}`, source: device.paper_id, target: device.id, type: 'reports', group: 'reports', directed: true, weight: 1 })
    }
    for (const motifId of device.motif_ids) {
      if (nodeIds.has(motifId)) edges.push({ id: `uses_motif::${device.id}::${motifId}`, source: device.id, target: motifId, type: 'uses_motif', group: 'uses_motif', directed: true, weight: 1 })
    }
  }
  return {
    view: 'mixed', nodes, edges,
    candidateCount: allPapers.length + allDevices.length + allMotifNodes.length,
    note: 'Direct paper → device → motif links; variant and component nodes are collapsed for readability.',
  }
}

export function networkEntityDetail(node, atlasNodes = []) {
  if (!node) return null
  const motifById = new Map(asArray(atlasNodes).map((item) => [item.id, item]))
  return {
    ...node,
    motif_labels: asArray(node.motif_ids).map((id) => motifById.get(id)?.label || id),
  }
}

export function sharedMotifLabels(edge, atlasNodes = []) {
  const motifById = new Map(asArray(atlasNodes).map((item) => [item.id, item]))
  return asArray(edge?.shared_motif_ids).map((id) => motifById.get(id)?.label || id)
}
