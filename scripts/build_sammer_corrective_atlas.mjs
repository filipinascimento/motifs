#!/usr/bin/env node

import fs from 'node:fs'

const [input, output] = process.argv.slice(2)
if (!input || !output) {
  console.error('Usage: node scripts/build_sammer_corrective_atlas.mjs INPUT_JSON OUTPUT_JSON')
  process.exit(2)
}

const atlas = JSON.parse(fs.readFileSync(input, 'utf8'))
const edges = (atlas.edges || []).filter((edge) => edge.group !== 'used_with' || Number(edge.weight || 0) >= 2)
const byEdgeGroup = edges.reduce((counts, edge) => {
  const group = edge.group || edge.type || 'link'
  counts[group] = (counts[group] || 0) + 1
  return counts
}, {})

atlas.release_id = 'rogers_protocol_repair_v1-sammer-corrective'
atlas.release = {
  status: 'restored_reviewed_baseline',
  hierarchy_policy: 'Preserve the established nine L1 families and recurrent L2/L3 atlas while the August hierarchy rebuild is held back for review.',
  sammer_corrections: [
    'Keep L1, L2, and L3 visible as distinct hierarchy levels.',
    'Exclude one-paper used-with edges from the default public graph.',
    'Keep single-paper observations separate from the recurrent motif registry.',
  ],
}
atlas.edges = edges
atlas.counts = {
  ...(atlas.counts || {}),
  nodes: (atlas.nodes || []).length,
  edges: edges.length,
  by_edge_group: byEdgeGroup,
}
atlas.source = {
  ...(atlas.source || {}),
  note: 'Restored from the reviewed nine-family Rogers baseline; the unreviewed August hierarchy replacement is not published.',
}

fs.writeFileSync(output, `${JSON.stringify(atlas, null, 2)}\n`)
console.log(`Wrote ${output}: ${atlas.counts.nodes} nodes, ${atlas.counts.edges} edges`)
