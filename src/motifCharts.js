import { motifAdoptionSeries } from './motifTrends.js'
import { scaleLinear, scaleLog } from 'd3-scale'

export const CATEGORY10 = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf']

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char])
}

function formatAxis(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  const absolute = Math.abs(number)
  if (absolute >= 10000 || (absolute > 0 && absolute < .01)) return number.toExponential(1)
  return Number(number.toPrecision(3)).toLocaleString()
}

const SUPERSCRIPT_DIGITS = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' }

function formatLogAxis(value) {
  const number = Number(value)
  if (number === 0) return '0'
  if (!Number.isFinite(number) || number < 0) return formatAxis(number)
  const exponent = Math.log10(number)
  const integerExponent = Math.round(exponent)
  if (Math.abs(exponent - integerExponent) > 1e-10) return formatAxis(number)
  const superscript = String(integerExponent).split('').map((digit) => SUPERSCRIPT_DIGITS[digit] || digit).join('')
  return `10${superscript}`
}

function pathFromPoints(points) {
  return points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
}

function adoptionPlotYear(year) {
  return Number(year) !== 2026
}

export function motifSparklineMarkup(node, corpusPapersByYear) {
  const series = motifAdoptionSeries(node, corpusPapersByYear).filter((item) => adoptionPlotYear(item.year))
  if (!series.length) return ''
  const years = series.map((item) => item.year)
  const width = 74
  const height = 28
  const shares = series.map((item) => item.share)
  const maximum = Math.max(Number.EPSILON, ...shares)
  const x = (index) => 1 + index * (width - 2) / Math.max(1, years.length - 1)
  const y = (value) => height - 2 - value * (height - 5) / maximum
  const points = shares.map((value, index) => [x(index), y(value)])
  const area = `${pathFromPoints(points)} L${width - 1},${height - 1} L1,${height - 1} Z`
  return `<svg class="motif-sparkline" viewBox="0 0 ${width} ${height}" aria-label="Relative annual paper share from ${years[0]} to ${years.at(-1)}" role="img"><title>Relative paper share by year</title><path class="spark-area" d="${area}"/><path class="spark-line" d="${pathFromPoints(points)}"/></svg>`
}

export function adoptionTimelineChartMarkup({
  title,
  nodes,
  years,
  corpusPapersByYear,
  measure = 'papers',
  selectedId = null,
}) {
  const plotYears = years.filter(adoptionPlotYear)
  if (!nodes.length || !plotYears.length) return `<article class="adoption-chart-card"><h3>${escapeHtml(title)}</h3><p class="timeline-empty">No motifs meet this definition.</p></article>`
  const width = 760
  const height = 250
  const margin = { left: 48, right: 14, top: 12, bottom: 31 }
  const plotWidth = width - margin.left - margin.right
  const plotHeight = height - margin.top - margin.bottom
  const series = nodes.map((node) => ({
    node,
    values: plotYears.map((year) => {
      const papers = Number(node.annual_paper_counts?.[year] || 0)
      const corpusPapers = Number(corpusPapersByYear[year] || 0)
      return measure === 'share' ? (corpusPapers ? 100 * papers / corpusPapers : 0) : papers
    }),
  }))
  const maximum = Math.max(1, ...series.flatMap((item) => item.values))
  const x = (year) => margin.left + (year - plotYears[0]) * plotWidth / Math.max(1, plotYears.at(-1) - plotYears[0])
  const y = (value) => margin.top + plotHeight - value * plotHeight / maximum
  const yTicks = [0, .25, .5, .75, 1].map((fraction) => ({ value: maximum * fraction, y: y(maximum * fraction) }))
  const xTicks = plotYears.filter((year, index) => index === 0 || index === plotYears.length - 1 || year % 5 === 0)
  return `<article class="adoption-chart-card"><h3>${escapeHtml(title)}</h3>
    <svg class="adoption-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}">
      ${yTicks.map((tick) => `<line class="chart-grid" x1="${margin.left}" x2="${width - margin.right}" y1="${tick.y}" y2="${tick.y}"/><text class="chart-axis" x="${margin.left - 8}" y="${tick.y + 4}" text-anchor="end">${measure === 'share' ? `${formatAxis(tick.value)}%` : formatAxis(tick.value)}</text>`).join('')}
      ${xTicks.map((year) => `<text class="chart-axis" x="${x(year)}" y="${height - 9}" text-anchor="middle">${year}</text>`).join('')}
      ${series.map(({ node, values }, index) => {
        const points = plotYears.map((year, yearIndex) => [x(year), y(values[yearIndex])])
        const path = pathFromPoints(points)
        return `<path class="adoption-hit-target" data-adoption-id="${escapeHtml(node.id)}" d="${path}" aria-hidden="true"/><path class="adoption-line ${selectedId === node.id ? 'selected' : ''}" data-adoption-id="${escapeHtml(node.id)}" d="${path}" style="--series-color:${CATEGORY10[index % CATEGORY10.length]}"><title>${escapeHtml(node.label)}</title></path>`
      }).join('')}
    </svg>
    <div class="adoption-legend">${nodes.map((node, index) => `<button type="button" class="${selectedId === node.id ? 'selected' : ''}" data-adoption-id="${escapeHtml(node.id)}" style="--series-color:${CATEGORY10[index % CATEGORY10.length]}"><i></i><span>${escapeHtml(node.label)}</span></button>`).join('')}</div>
  </article>`
}

export function detailAdoptionChartMarkup(node, corpusPapersByYear, measure = 'papers') {
  const series = motifAdoptionSeries(node, corpusPapersByYear).filter((item) => adoptionPlotYear(item.year))
  if (!series.length) return ''
  const width = 340
  const height = 145
  const margin = { left: 38, right: 8, top: 10, bottom: 27 }
  const plotWidth = width - margin.left - margin.right
  const plotHeight = height - margin.top - margin.bottom
  const values = series.map((item) => measure === 'share' ? item.share * 100 : item.papers)
  const maximum = Math.max(1, ...values)
  const x = (year) => margin.left + (year - series[0].year) * plotWidth / Math.max(1, series.at(-1).year - series[0].year)
  const y = (value) => margin.top + plotHeight - value * plotHeight / maximum
  const points = series.map((item, index) => [x(item.year), y(values[index])])
  const area = `${pathFromPoints(points)} L${x(series.at(-1).year)},${margin.top + plotHeight} L${x(series[0].year)},${margin.top + plotHeight} Z`
  return `<svg class="detail-adoption-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(node.label)} annual ${measure === 'share' ? 'share of papers' : 'paper count'}">
    <line class="chart-grid" x1="${margin.left}" x2="${width - margin.right}" y1="${margin.top}" y2="${margin.top}"/>
    <line class="chart-grid" x1="${margin.left}" x2="${width - margin.right}" y1="${margin.top + plotHeight}" y2="${margin.top + plotHeight}"/>
    <text class="chart-axis" x="${margin.left - 6}" y="${margin.top + 4}" text-anchor="end">${measure === 'share' ? `${formatAxis(maximum)}%` : formatAxis(maximum)}</text>
    <text class="chart-axis" x="${margin.left}" y="${height - 8}" text-anchor="middle">${series[0].year}</text>
    <text class="chart-axis" x="${width - margin.right}" y="${height - 8}" text-anchor="end">${series.at(-1).year}</text>
    <path class="detail-adoption-area" d="${area}"/><path class="detail-adoption-line" d="${pathFromPoints(points)}"/>
  </svg>`
}

export function characteristicScatterMarkup(series, years = []) {
  if (!series?.observations?.length) return ''
  const width = 340
  const height = 210
  const margin = { left: 48, right: 10, top: 12, bottom: 31 }
  const plotWidth = width - margin.left - margin.right
  const plotHeight = height - margin.top - margin.bottom
  const observedYears = series.observations.map((item) => Number(item.year))
  const firstYear = years[0] ?? Math.min(...observedYears)
  const lastYear = years.at(-1) ?? Math.max(...observedYears)
  const allValues = series.observations.flatMap((item) => [item.bounds.minimum, item.bounds.maximum]).filter(Number.isFinite)
  const minimum = Math.min(...allValues)
  const maximum = Math.max(...allValues)
  const nonNegative = minimum >= 0
  const positiveValues = allValues.filter((value) => value > 0)
  const minimumPositive = Math.min(...positiveValues)
  const hasZero = nonNegative && allValues.some((value) => value === 0)
  const logScale = nonNegative && positiveValues.length > 0 && maximum / minimumPositive >= 1000
  const x = (year) => margin.left + (year - firstYear) * plotWidth / Math.max(1, lastYear - firstYear)
  const xTicks = [firstYear, Math.round((firstYear + lastYear) / 2), lastYear]
  let y
  let yTicks
  if (logScale) {
    const zeroBaseline = margin.top + plotHeight
    const positiveBaseline = zeroBaseline - (hasZero ? 18 : 0)
    const logarithmic = scaleLog()
      .domain([minimumPositive, maximum])
      .nice()
      .range([positiveBaseline, margin.top])
    const logarithmicTicks = logarithmic.ticks(5)
    y = (value) => value === 0 && hasZero ? zeroBaseline : logarithmic(Math.max(value, minimumPositive))
    yTicks = hasZero ? [0, ...logarithmicTicks] : logarithmicTicks
  } else {
    let domainMinimum = minimum
    let domainMaximum = maximum
    if (domainMinimum === domainMaximum) {
      const padding = Math.abs(domainMinimum || 1) * .1
      domainMinimum -= padding
      domainMaximum += padding
    } else {
      const padding = (domainMaximum - domainMinimum) * .08
      domainMinimum -= padding
      domainMaximum += padding
    }
    if (nonNegative) domainMinimum = Math.max(0, domainMinimum)
    const linear = scaleLinear()
      .domain([domainMinimum, domainMaximum])
      .nice(3)
      .range([margin.top + plotHeight, margin.top])
    y = linear
    yTicks = linear.ticks(3)
  }
  const scaleDescription = logScale ? `, logarithmic scale${hasZero ? ' with reported zero baseline' : ''}` : ''
  return `<svg class="characteristic-scatter" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(series.displayMetric)} over time in ${escapeHtml(series.unit)}${scaleDescription}">
    ${yTicks.map((value) => `<line class="chart-grid" x1="${margin.left}" x2="${width - margin.right}" y1="${y(value)}" y2="${y(value)}"/><line class="chart-axis-tick" x1="${margin.left - 4}" x2="${margin.left}" y1="${y(value)}" y2="${y(value)}"/><text class="chart-axis" x="${margin.left - 7}" y="${y(value) + 4}" text-anchor="end">${escapeHtml(logScale ? formatLogAxis(value) : formatAxis(value))}</text>`).join('')}
    <line class="chart-axis-domain" x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${margin.top + plotHeight}"/><line class="chart-axis-domain" x1="${margin.left}" x2="${width - margin.right}" y1="${margin.top + plotHeight}" y2="${margin.top + plotHeight}"/>
    ${xTicks.map((year) => `<line class="chart-axis-tick" x1="${x(year)}" x2="${x(year)}" y1="${margin.top + plotHeight}" y2="${margin.top + plotHeight + 4}"/><text class="chart-axis" x="${x(year)}" y="${height - 9}" text-anchor="middle">${year}</text>`).join('')}
    ${series.observations.map((item) => {
      const cx = x(Number(item.year))
      const cy = y(item.bounds.point)
      const whisker = item.bounds.minimum !== item.bounds.maximum
        ? `<line class="scatter-range" x1="${cx}" x2="${cx}" y1="${y(item.bounds.minimum)}" y2="${y(item.bounds.maximum)}"/>`
        : ''
      return `${whisker}<circle class="scatter-point" cx="${cx}" cy="${cy}" r="3.5"><title>${item.year}: ${formatAxis(item.bounds.point)} ${escapeHtml(series.unit)}</title></circle>`
    }).join('')}
    ${logScale ? `<text class="chart-note" x="${width - margin.right}" y="${margin.top + 8}" text-anchor="end">log scale${hasZero ? ' · reported zero retained' : ''}</text>` : ''}
  </svg>`
}
