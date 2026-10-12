import { chartIssueMessages, ChartStats, chartStats, findChartIssues, sameAsExpert } from './chart/chart-analysis'
import { canonicalChartFromParse } from './chart/identity/canonical-source'
import { GameplayChart, gameplayChartSource } from './gameplay-chart'
import type { Issue } from './issues'

export type { ChartStats } from './chart/chart-analysis'

/** A gameplay chart's issues and statistics. */
export function analyzeChart(chart: GameplayChart): { readonly issues: readonly Issue[]; readonly stats: ChartStats } {
	const source = gameplayChartSource(chart)
	if (source === undefined) throw new TypeError('analyzeChart takes a chart that resolveChart returned')
	const { parsed, settings, format } = source
	const canonical = canonicalChartFromParse(format, parsed)
	const issues = findChartIssues(parsed, sameAsExpert(canonical.kind === 'accepted' ? canonical.chart : null))
		.map(({ code, instrument, difficulty, tick, msTime }): Issue => ({ scope: 'chart', code, instrument, difficulty, tick, msTime, message: chartIssueMessages[code] }))
	return { issues, stats: chartStats(parsed, settings, format) }
}
