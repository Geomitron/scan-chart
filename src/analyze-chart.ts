import { chartIssueMessages, ChartStats, chartStats, findChartIssues, sameAsExpert } from './chart/chart-analysis'
import { canonicalChartFromParse } from './chart/identity/canonical-source'
import { GameplayChart, gameplayChartSource } from './gameplay-chart'
import type { Issue } from './issues'
import { chartSpellingIssues } from './spelling-issues'

export type { ChartStats } from './chart/chart-analysis'

/**
 * A gameplay chart's issues and statistics. The issues include the chart file's nonstandard spellings: compatibility
 * issues always, and style notes when `styleNotes` asks for them.
 */
export function analyzeChart(chart: GameplayChart, options: { readonly styleNotes?: boolean } = {}): { readonly issues: readonly Issue[]; readonly stats: ChartStats } {
	const source = gameplayChartSource(chart)
	if (source === undefined) throw new TypeError('analyzeChart takes a chart that resolveChart returned')
	const { parsed, settings, format } = source
	const canonical = canonicalChartFromParse(format, parsed)
	const issues = findChartIssues(parsed, sameAsExpert(canonical.kind === 'accepted' ? canonical.chart : null))
		.map(({ code, instrument, difficulty, tick, msTime }): Issue => ({ scope: 'chart', code, instrument, difficulty, tick, msTime, message: chartIssueMessages[code] }))
	return { issues: [...issues, ...chartSpellingIssues(source.source, options.styleNotes ?? false)], stats: chartStats(parsed, settings, format) }
}
