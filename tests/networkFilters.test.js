import test from 'node:test'
import assert from 'node:assert/strict'

import { applyNetworkTopologyFilter, MIN_NETWORK_COMPONENT_SIZE } from '../src/networkFilters.js'

test('Helios removes singletons and components below four nodes after active rules', () => {
  const calls = []
  const existingRules = [{ id: 'edge-rule', scope: 'edge', type: 'query', query: 'category == 1' }]
  const filters = {
    rules: existingRules,
    setScope(scope) { calls.push(['scope', scope]); return this },
    setMinComponentSize(size) { calls.push(['minComponentSize', size]); return this },
    getPublicState() { return { rules: this.rules } },
  }
  const state = applyNetworkTopologyFilter({ behavior: { filters } })

  assert.equal(MIN_NETWORK_COMPONENT_SIZE, 4)
  assert.deepEqual(calls, [['scope', 'render+layout'], ['minComponentSize', 4]])
  assert.equal(state.rules, existingRules)
})

test('Helios topology filtering fails loudly if filter support disappears', () => {
  assert.throws(() => applyNetworkTopologyFilter({ behavior: {} }), /filters behavior is unavailable/)
})
