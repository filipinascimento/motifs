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
    ...(node.facets || []).map((facet) => ({ kind: 'facet', value: facet.label || '' })),
  ]
}

function matchesFields(fields, query = '') {
  const tokens = searchTokens(query)
  if (!tokens.length) return true
  const haystack = normalizeSearchText(fields.map(({ value }) => value).join(' '))
  return tokens.every((token) => haystack.includes(token))
}

export function matchesPrimarySearch(node, query = '') {
  return matchesFields(searchableFields(node).filter(({ kind }) => kind !== 'facet'), query)
}

export function matchesSearch(node, query = '') {
  return matchesFields(searchableFields(node), query)
}

export function searchRelevance(node, query = '') {
  const normalizedQuery = normalizeSearchText(query)
  const tokens = searchTokens(query)
  if (!tokens.length) return 0
  const weights = { label: 100, alias: 80, description: 50, facet: 20 }
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
