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

const fluxMatches = data.nodes.filter((node) => matchesSearch(node, 'flux'))
assert(
  fluxMatches.some((node) => node.id === 'L2-defined-volume-sampling-chamber'),
  'Expected the molecular-flux chamber parent motif to match flux',
)
assert(
  fluxMatches.some((node) => node.id === 'L2-thermal-sensing'),
  'Expected the heat-flux parent motif to match flux',
)
assert(
  data.nodes.filter((node) => matchesSearch(node, 'molecular flux')).some((node) => node.id === 'L2-defined-volume-sampling-chamber'),
  'Expected molecular flux to find the defined-volume sampling chamber',
)
assert(
  data.nodes.filter((node) => matchesSearch(node, 'heat flux')).some((node) => node.id === 'L2-thermal-sensing'),
  'Expected heat flux to find thermal sensing',
)
assert(
  !data.nodes.filter((node) => matchesSearch(node, 'heat flux')).some((node) => node.id === 'L2-replica-molding-and-soft-lithography'),
  'Multiword terms must not be assembled from unrelated observation labels on one parent',
)
assert(data.observations.length === 1973, `Expected all 1973 reviewed observations, found ${data.observations.length}`)
assert(data.observations.every((observation) => observation.anchor_ids.length), 'Every reviewed observation must have a visible motif anchor')

const wirelessMatches = data.nodes.filter((node) => matchesSearch(node, 'wireless power'))
assert(
  wirelessMatches.some((node) => node.id === 'L2-wireless-power-transfer'),
  'Expected wireless power transfer to match',
)

const wirelessPrimary = data.nodes
  .filter((node) => matchesPrimarySearch(node, 'wireless power'))
  .sort((a, b) => searchRelevance(b, 'wireless power') - searchRelevance(a, 'wireless power'))
assert(wirelessPrimary.length > 0, 'Expected at least one primary wireless power match')
assert(
  wirelessPrimary[0].id === 'L2-wireless-power-transfer',
  `Expected exact label match first, found ${wirelessPrimary[0]?.id}`,
)

console.log(`Search checks passed: flux=${fluxMatches.length}, observations=${data.observations.length}, wireless power primary=${wirelessPrimary.length}`)
