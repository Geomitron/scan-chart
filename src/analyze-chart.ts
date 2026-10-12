import { chartIssueMessages, ChartStats, chartStats, findChartIssues, sameAsExpert } from './chart/chart-analysis'
import { canonicalChartFromParse } from './chart/identity/canonical-source'
import { GameplayChart, gameplayChartSource } from './gameplay-chart'
import type { ChartIssueType, Difficulty, FolderIssueType, Instrument, MetadataIssueType } from './types'

export type { ChartStats } from './chart/chart-analysis'

/** Where an issue is: the song folder's files, the song's metadata, or its chart. */
export type IssueScope = 'folder' | 'metadata' | 'chart'
export type IssueCode = FolderIssueType | MetadataIssueType | ChartIssueType

/** A problem found in a song folder. Every issue has this shape, whatever its scope. */
export interface Issue {
	readonly scope: IssueScope
	readonly code: IssueCode
	/** The instrument it's about, or `null` when it's about more than one. */
	readonly instrument: Instrument | null
	/** The difficulty it's about, or `null` when it's about more than one. */
	readonly difficulty: Difficulty | null
	/** Where in the chart, or `null` for an issue about a whole track, chart or file. */
	readonly tick: number | null
	readonly msTime: number | null
	readonly message: string
}

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
