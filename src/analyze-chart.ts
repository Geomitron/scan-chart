import { chartIssueMessages, chartRecommendationMessages, ChartStats, chartStats, findChartIssues, sameAsExpert } from './chart/chart-analysis'
import { chartSectionTrack } from './chart/chart-file-parser'
import { canonicalChartFromParse } from './chart/identity/canonical-source'
import { midiInstrumentTracks } from './chart/midi-file-parser'
import { GameplayChart, gameplayChartSource, GameplayChartSource } from './gameplay-chart'
import { Issue, issueSeverities } from './issues'
import { undelayedSyncAdvice } from './shared/time'
import { chartSpellingIssues } from './spelling-issues'
import type { Instrument } from './types'

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
	return { issues: [...issues, ...chartFileIssues(source), ...chartSpellingIssues(source.source, options.styleNotes ?? false)], stats: chartStats(parsed, settings, format) }
}

/** How the chart file is written: a `.chart` Offset, and instrument tracks with no notes, which games don't list. */
function chartFileIssues({ parsed, source, delay }: GameplayChartSource): Issue[] {
	const issues: Issue[] = []
	const add = (code: 'chartOffset' | 'emptyTrack', instrument: Issue['instrument'], difficulty: Issue['difficulty'], message: string) =>
		issues.push({ scope: 'chart', code, severity: issueSeverities[code], instrument, difficulty, tick: null, msTime: null, file: null, message })
	const hasTrack = (instrument: Instrument, difficulty?: Issue['difficulty']) =>
		parsed.trackData.some(track => track.instrument === instrument && (difficulty === undefined || track.difficulty === difficulty))

	const offsetMs = Math.round(parsed.metadata.chart_offset ?? 0)
	if (offsetMs !== 0) {
		const seconds = `${offsetMs / 1000} second${offsetMs === 1000 ? '' : 's'}`
		add('chartOffset', null, null, delay !== 0
			? `The chart's [Song] Offset is ${seconds}, which games ignore while song.ini sets "delay". Set the Offset to 0.`
			: `The chart's [Song] Offset is ${seconds}. Set it to 0, and keep the notes in time with the audio instead: ${undelayedSyncAdvice(offsetMs)}.`)
	}

	if (source.format === 'chart') {
		// A reader reads the first section of each name.
		for (const name of new Set(source.tokens.sections.map(section => section.name))) {
			const track = chartSectionTrack(name)
			if (track !== null && !hasTrack(track.instrument, track.difficulty)) {
				add('emptyTrack', track.instrument, track.difficulty, `The [${name}] section has no notes, so it isn't a track: games don't list it. Chart its notes, or remove it.`)
			}
		}
	} else if (source.tokens !== null) {
		const reported = new Set<Instrument>()
		for (const { name, instrument } of midiInstrumentTracks(source.tokens)) {
			if (!hasTrack(instrument) && !reported.has(instrument)) {
				reported.add(instrument)
				add('emptyTrack', instrument, null, `The "${name}" track has no notes, so games don't list it. Chart its notes, or remove it.`)
			}
		}
	}
	return issues
}
