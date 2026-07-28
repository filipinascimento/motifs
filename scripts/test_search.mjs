#!/usr/bin/env node

import fs from 'node:fs'
import { matchesPrimarySearch, matchesSearch, matchingSearchFields, searchRelevance } from '../src/search.js'

const data = JSON.parse(fs.readFileSync('public/data/hierarchical_motifs.json', 'utf8'))

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const hiddenFacetDescription = {
  label: 'Unrelated motif',
  description: 'No matching term here.',
  aliases: [],
  facets: [{ label: 'thermal', description: 'Heaters and heat-flux modules.' }],
}

assert(!matchesSearch(hiddenFacetDescription, 'flux'), 'Hidden facet descriptions must not match')
assert(matchesSearch(hiddenFacetDescription, 'thermal'), 'Visible facet labels must match')
assert(matchesSearch({ ...hiddenFacetDescription, aliases: ['flux sensor'] }, 'flux'), 'Aliases must match')
assert(
  matchingSearchFields({ ...hiddenFacetDescription, aliases: ['flux sensor'] }, 'flux')
    .some(({ kind }) => kind === 'alias'),
  'Alias matches must be explainable in the UI',
)

const fluxMatches = data.nodes.filter((node) => matchesSearch(node, 'flux'))
assert(fluxMatches.length === 0, `Expected no visible-field matches for flux, found ${fluxMatches.length}`)

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

console.log(`Search checks passed: flux=${fluxMatches.length}, wireless power primary=${wirelessPrimary.length}`)
