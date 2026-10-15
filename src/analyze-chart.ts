import { chartIssueMessages, chartRecommendationMessages, ChartStats, chartStats, findChartIssues, sameAsExpert } from './chart/chart-analysis'
import { canonicalChartFromParse } from './chart/identity/canonical-source'
import { GameplayChart, gameplayChartSource } from './gameplay-chart'
import { Issue, issueSeverities } from './issues'
import { chartSpellingIssues } from './spelling-issues'

export type { ChartStats } from './chart/chart-analysis'

/**
 * A gameplay chart's issues and statistics. The issues include the chart file's nonstandard spellings: compatibility
 * issues always, and style notes when `styleNotes` asks for them. A check with a charting recommendation also reports,
 * at the `recommendation` severity, what misses the recommendation but passes the check.
 */
export function analyzeChart(chart: GameplayChart, options: { readonly styleNotes?: boolean } = {}): { readonly issues: readonly Issue[]; readonly stats: ChartStats } {
	const source = gameplayChartSource(chart)
	if (source === undefined) throw new TypeError('analyzeChart takes a chart that resolveChart returned')
	const { parsed, settings, format } = source
	const canonical = canonicalChartFromParse(format, parsed)
	const issues = findChartIssues(parsed, sameAsExpert(canonical.kind === 'accepted' ? canonical.chart : null), { recommendations: true })
		.map(({ code, instrument, difficulty, tick, msTime, recommendation }): Issue => ({
			scope: 'chart',
			code,
			severity: recommendation ? 'recommendation' : issueSeverities[code],
			instrument,
			difficulty,
			tick,
			msTime,
			file: null,
			message: recommendation ? chartRecommendationMessages[code as keyof typeof chartRecommendationMessages] : chartIssueMessages[code],
		}))
	return { issues: [...issues, ...chartSpellingIssues(source.source, options.styleNotes ?? false)], stats: chartStats(parsed, settings, format) }
}
