import test from 'node:test'
import assert from 'node:assert/strict'
import { adoptionTimelineChartMarkup } from '../src/motifCharts.js'

test('adoption timelines provide forgiving curve hit targets', () => {
  const years = [2020, 2021, 2022]
  const nodes = [
    { id: 'M1', label: 'First motif', annual_paper_counts: { 2020: 1, 2021: 2, 2022: 3 } },
    { id: 'M2', label: 'Second motif', annual_paper_counts: { 2020: 2, 2021: 1, 2022: 2 } },
  ]
  const markup = adoptionTimelineChartMarkup({
    title: 'Relative adoption',
    nodes,
    years,
    corpusPapersByYear: { 2020: 10, 2021: 10, 2022: 10 },
    measure: 'share',
  })
  assert.equal((markup.match(/class="adoption-hit-target"/gu) || []).length, 2)
  assert.equal((markup.match(/class="adoption-line /gu) || []).length, 2)
  assert.match(markup, /data-adoption-id="M1"/u)
  assert.match(markup, /%/u)
})
