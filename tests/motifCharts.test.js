import test from 'node:test'
import assert from 'node:assert/strict'
import { adoptionTimelineChartMarkup, detailAdoptionChartMarkup, motifSparklineMarkup } from '../src/motifCharts.js'

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

test('adoption visuals exclude 2026 without changing source data', () => {
  const corpus = { 2024: 100, 2025: 20, 2026: 10 }
  const node = {
    id: 'M1',
    label: 'Motif',
    annual_paper_counts: { 2024: 10, 2025: 4, 2026: 10 },
  }
  const sparkline = motifSparklineMarkup(node, corpus)
  assert.match(sparkline, /Relative annual paper share from 2024 to 2025/u)
  assert.match(sparkline, /d="M1\.0,14\.5 L73\.0,3\.0/u)
  assert.doesNotMatch(sparkline, /2026/u)

  const timeline = adoptionTimelineChartMarkup({
    title: 'Adoption',
    nodes: [node],
    years: [2024, 2025, 2026],
    corpusPapersByYear: corpus,
    measure: 'share',
  })
  assert.match(timeline, />2025<\/text>/u)
  assert.doesNotMatch(timeline, />2026<\/text>/u)

  const detail = detailAdoptionChartMarkup(node, corpus, 'share')
  assert.match(detail, />2025<\/text>/u)
  assert.doesNotMatch(detail, />2026<\/text>/u)
  assert.equal(node.annual_paper_counts[2026], 10)
})
