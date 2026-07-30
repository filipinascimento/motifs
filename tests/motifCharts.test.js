import test from 'node:test'
import assert from 'node:assert/strict'
import { adoptionTimelineChartMarkup, characteristicScatterMarkup, detailAdoptionChartMarkup, motifSparklineMarkup } from '../src/motifCharts.js'

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

test('characteristic plots use logarithmic ticks while retaining a reported zero', () => {
  const markup = characteristicScatterMarkup({
    displayMetric: 'thickness',
    unit: 'cm',
    observations: [
      { year: 2020, bounds: { minimum: 0, maximum: 0, point: 0 } },
      { year: 2021, bounds: { minimum: 1e-8, maximum: 1e-8, point: 1e-8 } },
      { year: 2022, bounds: { minimum: 1e-4, maximum: 1e-4, point: 1e-4 } },
      { year: 2023, bounds: { minimum: 1, maximum: 1, point: 1 } },
    ],
  }, [2020, 2021, 2022, 2023])

  assert.match(markup, /logarithmic scale with reported zero baseline/u)
  assert.match(markup, /log scale · reported zero retained/u)
  assert.match(markup, />0<\/text>/u)
  assert.match(markup, />10⁻⁸<\/text>/u)
  assert.match(markup, />10⁻⁴<\/text>/u)
  assert.doesNotMatch(markup, />-\d/u)
  assert.match(markup, /class="chart-axis-domain"/u)
  assert.match(markup, /class="chart-axis-tick"/u)
})

test('logarithmic characteristic axes use a niced D3 domain without raw endpoint grid lines', () => {
  const markup = characteristicScatterMarkup({
    displayMetric: 'thickness',
    unit: 'cm',
    observations: [
      { year: 2020, bounds: { minimum: 5e-7, maximum: 5e-7, point: 5e-7 } },
      { year: 2021, bounds: { minimum: 13, maximum: 13, point: 13 } },
    ],
  }, [2020, 2021])

  assert.match(markup, />10²<\/text>/u)
  assert.match(markup, />10⁻⁶<\/text>/u)
  assert.doesNotMatch(markup, />13<\/text>/u)
})

test('characteristic plots retain a linear axis for narrow ranges', () => {
  const markup = characteristicScatterMarkup({
    displayMetric: 'voltage',
    unit: 'V',
    observations: [
      { year: 2020, bounds: { minimum: 1, maximum: 1, point: 1 } },
      { year: 2021, bounds: { minimum: 2, maximum: 2, point: 2 } },
    ],
  }, [2020, 2021])

  assert.doesNotMatch(markup, /log scale/u)
  assert.doesNotMatch(markup, /logarithmic scale/u)
})
