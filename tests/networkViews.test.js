import test from 'node:test'
import assert from 'node:assert/strict'

import { networkNodeSizeScore, projectedEntityNetwork, shouldMapCategoricalEdgeColors, similarityEdges } from '../src/networkViews.js'

const motifs = [
  { id: 'L1-A', label: 'Family A', level: 'L1' },
  { id: 'L2-X', label: 'Sensor array', level: 'L2' },
  { id: 'L2-Y', label: 'Wireless readout', level: 'L2' },
  { id: 'L3-Z', label: 'Soft encapsulation', level: 'L3' },
]

const characteristics = {
  graph: {
    nodes: [
      { id: 'P1', type: 'paper', label: 'Paper one' },
      { id: 'D1', type: 'device', label: 'Device one' },
      { id: 'L2-X', type: 'motif', label: 'Sensor array' },
    ],
    edges: [
      { edge_id: 'reports::P1::D1', source_id: 'P1', target_id: 'D1', relation: 'reports' },
      { edge_id: 'implements::D1::L2-X', source_id: 'D1', target_id: 'L2-X', relation: 'implements_motif' },
    ],
  },
  indexes: {
    papers: {
      P1: { paper_id: 'P1', title: 'Paper one', year: 2020, device_ids: ['D1'], records: {} },
      P2: { paper_id: 'P2', title: 'Paper two', year: 2022, device_ids: ['D2'], records: {} },
      P3: { paper_id: 'P3', title: 'Paper three', year: 2024, device_ids: ['D3'], records: {} },
    },
    devices: {
      D1: { device_id: 'D1', name: 'Device one', paper_id: 'P1', year: 2020, direct_motif_ids: ['L1-A', 'L2-X', 'L2-Y'], motif_ids: ['L1-A', 'L2-X', 'L2-Y'], records: {} },
      D2: { device_id: 'D2', name: 'Device two', paper_id: 'P2', year: 2022, direct_motif_ids: ['L2-X', 'L2-Y', 'L3-Z'], motif_ids: ['L1-A', 'L2-X', 'L2-Y', 'L3-Z'], records: {} },
      D3: { device_id: 'D3', name: 'Device three', paper_id: 'P3', year: 2024, direct_motif_ids: ['L2-X'], motif_ids: ['L1-A', 'L2-X'], records: {} },
    },
  },
}

test('similarity projection retains shared motif evidence and bounds neighbors', () => {
  const nodes = [
    { id: 'A', motif_ids: ['x', 'y'] },
    { id: 'B', motif_ids: ['x', 'y', 'z'] },
    { id: 'C', motif_ids: ['x'] },
  ]
  const edges = similarityEdges(nodes, { minShared: 2, topK: 1 })
  assert.equal(edges.length, 1)
  assert.deepEqual(edges[0].shared_motif_ids, ['x', 'y'])
  assert.equal(edges[0].weight, 2)
})

test('paper and device node radii use compressed visible degree', () => {
  assert.equal(networkNodeSizeScore('devices', {}, 0), 0)
  assert.equal(networkNodeSizeScore('devices', {}, 4), 2)
  assert.equal(networkNodeSizeScore('papers', {}, 25), 5)
  assert.ok(networkNodeSizeScore('motifs', { paper_count: 20 }, 4) > Math.sqrt(4))
})

test('only motif networks map categorical edge colors', () => {
  assert.equal(shouldMapCategoricalEdgeColors('motifs'), true)
  assert.equal(shouldMapCategoricalEdgeColors('devices'), false)
  assert.equal(shouldMapCategoricalEdgeColors('papers'), false)
})

test('device view excludes L1 organizing families from similarity', () => {
  const graph = projectedEntityNetwork(characteristics, motifs, { view: 'device', minShared: 2, maxNodes: 50 })
  assert.deepEqual(graph.nodes.find((node) => node.id === 'D1').motif_ids, ['L2-X', 'L2-Y'])
  assert.equal(graph.edges.length, 1)
  assert.deepEqual(graph.edges[0].shared_motif_ids, ['L2-X', 'L2-Y'])
})

test('paper view links papers through motifs used by their devices', () => {
  const graph = projectedEntityNetwork(characteristics, motifs, { view: 'paper', minShared: 2, maxNodes: 50 })
  assert.equal(graph.nodes.length, 3)
  assert.equal(graph.edges.length, 1)
  assert.match(graph.note, /Papers are linked/)
})

test('selected device is promoted into a bounded network', () => {
  const devices = {}
  const papers = {}
  for (let index = 1; index <= 25; index += 1) {
    const deviceId = `DX${index}`
    const paperId = `PX${index}`
    devices[deviceId] = {
      device_id: deviceId,
      name: `Device ${index}`,
      paper_id: paperId,
      year: 2000 + index,
      direct_motif_ids: ['L2-X'],
      motif_ids: ['L2-X'],
      records: index === 1 ? {} : { accepted_measurement_ids: Array(index).fill('value') },
    }
    papers[paperId] = { paper_id: paperId, title: `Paper ${index}`, year: 2000 + index, device_ids: [deviceId], records: {} }
  }
  const graph = projectedEntityNetwork({ indexes: { devices, papers } }, motifs, {
    view: 'device', maxNodes: 20, minShared: 1, selectedId: 'DX1',
  })
  assert.equal(graph.nodes.length, 20)
  assert.equal(graph.nodes[0].id, 'DX1')
  assert.ok(graph.nodes.some((node) => node.id === 'DX1'))
  const unlimited = projectedEntityNetwork({ indexes: { devices, papers } }, motifs, {
    view: 'device', maxNodes: Number.POSITIVE_INFINITY, minShared: 1,
  })
  assert.equal(unlimited.nodes.length, 25)
})

test('mixed view emits only direct paper-device and device-motif links', () => {
  const graph = projectedEntityNetwork(characteristics, motifs, { view: 'mixed', maxNodes: 50 })
  assert.ok(graph.nodes.some((node) => node.type === 'paper'))
  assert.ok(graph.nodes.some((node) => node.type === 'device'))
  assert.ok(graph.nodes.some((node) => node.type === 'motif'))
  assert.deepEqual(new Set(graph.edges.map((edge) => edge.type)), new Set(['reports', 'uses_motif']))
  assert.ok(graph.edges.every((edge) => edge.directed))
})

test('selected motif scopes device candidates without inventing links', () => {
  const graph = projectedEntityNetwork(characteristics, motifs, { view: 'device', motifId: 'L3-Z', minShared: 1, maxNodes: 50 })
  assert.deepEqual(graph.nodes.map((node) => node.id), ['D2'])
  assert.equal(graph.edges.length, 0)
})

test('family motif scope uses rollup membership but similarity stays L2/L3', () => {
  const graph = projectedEntityNetwork(characteristics, motifs, { view: 'device', motifId: 'L1-A', minShared: 2, maxNodes: 50 })
  assert.equal(graph.nodes.length, 3)
  assert.ok(graph.nodes.every((node) => !node.motif_ids.includes('L1-A')))
})

test('atomic view preserves every supplied graph node and edge', () => {
  const graph = projectedEntityNetwork(characteristics, motifs, { view: 'atomic', maxNodes: 1 })
  assert.equal(graph.nodes.length, characteristics.graph.nodes.length)
  assert.equal(graph.edges.length, characteristics.graph.edges.length)
  assert.deepEqual(new Set(graph.nodes.map((node) => node.type)), new Set(['paper', 'device', 'motif']))
  assert.match(graph.note, /Complete atomic graph/)
})
