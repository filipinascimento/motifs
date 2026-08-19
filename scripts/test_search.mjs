#!/usr/bin/env node

import fs from 'node:fs'
import { matchesPrimarySearch, matchesSearch, matchingSearchFields, searchRelevance } from '../src/search.js'

const data = JSON.parse(fs.readFileSync('public/data/hierarchical_motifs.json', 'utf8'))
const nodesById = new Map(data.nodes.map((node) => [node.id, node]))
data.nodes.forEach((node) => { node.observations = [] })
for (const observation of data.observations || []) {
  for (const anchorId of observation.anchor_ids || []) nodesById.get(anchorId)?.observations.push(observation)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const hiddenFacetDescription = {
  label: 'Unrelated motif',
  description: 'No matching term here.',
  aliases: [],
  facets: [{ label: 'thermal', description: 'Heaters and heat-flux modules.' }],
  observations: [{ id: 'OBS-hidden', label: 'unrelated implementation', rationale: 'Mentions flux only in hidden review prose.' }],
}

assert(!matchesSearch(hiddenFacetDescription, 'flux'), 'Hidden facet descriptions must not match')
assert(matchesSearch(hiddenFacetDescription, 'thermal'), 'Visible facet labels must match')
assert(matchesSearch({ ...hiddenFacetDescription, aliases: ['flux sensor'] }, 'flux'), 'Aliases must match')
assert(
  matchesSearch({ ...hiddenFacetDescription, observations: [{ id: 'OBS-flux', label: 'heat-flux estimator' }] }, 'flux'),
  'Visible reviewed-observation labels must match',
)
assert(
  matchingSearchFields({ ...hiddenFacetDescription, aliases: ['flux sensor'] }, 'flux')
    .some(({ kind }) => kind === 'alias'),
  'Alias matches must be explainable in the UI',
)

const microfluidicMatches = data.nodes.filter((node) => matchesSearch(node, 'microfluidic'))
assert(
  microfluidicMatches.some((node) => node.id === 'L2-epidermal-microfluidic-analysis-93b4a8cfe77298'),
  'Expected a recurrent microfluidic motif to match',
)
assert(
  microfluidicMatches.some((node) => node.observations?.length),
  'Search must route visibly separated single-source observations to an anchored motif',
)
assert(
  data.observations.length === data.public_release?.reviewed_observation_count,
  'Reviewed observation count must agree with the public-release manifest',
)
assert(data.observations.every((observation) => observation.anchor_ids.length), 'Every reviewed observation must have a visible motif anchor')
assert(data.release_id === 'rogers_core_v2.1.2-hierarchy-rebuilt-rich-engineering', 'Expected the reviewed hierarchy-v2 release')
assert(data.counts?.by_level?.L1 === 11, 'Expected 11 L1 controlled families')
assert(data.counts?.by_level?.L2 === 221, 'Expected 221 recurrent L2 motifs')
assert(data.counts?.by_level?.L3 === 369, 'Expected 369 recurrent L3 variants')
assert(data.counts.by_level.L3 > data.counts.by_level.L2, 'L3 must be finer-grained than L2')
assert(
  !data.nodes.some((node) => node.level === 'L2' && node.status === 'single_source_observation'),
  'L2 must never contain single-source observations',
)
assert(
  data.nodes.filter((node) => node.status === 'single_source_observation').every((node) => node.level === 'L3'),
  'Single-source observations must remain separated at L3',
)
assert(
  data.edges.filter((edge) => edge.group === 'used_with').every((edge) => Number(edge.weight) >= 2),
  'The default co-use graph must exclude weight-1 edges',
)

const wirelessQuery = 'wireless electromagnetic power transfer'
const wirelessMatches = data.nodes.filter((node) => matchesSearch(node, wirelessQuery))
assert(
  wirelessMatches.some((node) => node.id === 'L2-resonant-near-field-wireless-power-transfer-99fa99ef0b74a1'),
  'Expected wireless power transfer to match',
)

const wirelessPrimary = data.nodes
  .filter((node) => matchesPrimarySearch(node, wirelessQuery))
  .sort((a, b) => searchRelevance(b, wirelessQuery) - searchRelevance(a, wirelessQuery))
assert(wirelessPrimary.length > 0, 'Expected at least one primary wireless power match')
assert(
  wirelessPrimary[0].id === 'L2-resonant-near-field-wireless-power-transfer-99fa99ef0b74a1',
  `Expected exact label match first, found ${wirelessPrimary[0]?.id}`,
)

console.log(`Search and release checks passed: microfluidic=${microfluidicMatches.length}, L1=${data.counts.by_level.L1}, L2=${data.counts.by_level.L2}, L3=${data.counts.by_level.L3}`)
