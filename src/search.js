export function normalizeSearchText(value = '') {
  return String(value)
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim()
}

export function searchTokens(query = '') {
  return normalizeSearchText(query).split(/\s+/u).filter(Boolean)
}

export function searchableFields(node) {
  return [
    { kind: 'label', value: node.label || '' },
    { kind: 'description', value: node.description || '' },
    ...(node.aliases || []).map((value) => ({ kind: 'alias', value })),
    ...(node.observations || []).map((observation) => ({ kind: 'observation', value: observation.label || '', id: observation.id })),
    ...(node.facets || []).map((facet) => ({ kind: 'facet', value: facet.label || '' })),
  ]
}

function matchesFields(fields, query = '') {
  const tokens = searchTokens(query)
  if (!tokens.length) return true
  return fields.some(({ value }) => {
    const haystack = normalizeSearchText(value)
    return tokens.every((token) => haystack.includes(token))
  })
}

export function matchesPrimarySearch(node, query = '') {
  return matchesFields(searchableFields(node).filter(({ kind }) => kind !== 'facet'), query)
}

export function matchesSearch(node, query = '') {
  return matchesFields(searchableFields(node), query)
}

export function matchesObservationSearch(observation, query = '') {
  return matchesFields([{ kind: 'observation', value: observation.label || '' }], query)
}

export function searchRelevance(node, query = '') {
  const normalizedQuery = normalizeSearchText(query)
  const tokens = searchTokens(query)
  if (!tokens.length) return 0
  const weights = { label: 100, alias: 80, observation: 70, description: 50, facet: 20 }
  return searchableFields(node).reduce((score, { kind, value }) => {
    const normalized = normalizeSearchText(value)
    const weight = weights[kind] || 0
    if (normalized === normalizedQuery) return score + weight * 4
    if (normalized.includes(normalizedQuery)) return score + weight * 2
    const hits = tokens.filter((token) => normalized.includes(token)).length
    return score + weight * hits / tokens.length
  }, 0)
}

export function matchingSearchFields(node, query = '') {
  const tokens = searchTokens(query)
  if (!tokens.length) return []
  return searchableFields(node).filter(({ value }) => {
    const normalized = normalizeSearchText(value)
    return tokens.some((token) => normalized.includes(token))
  })
}
