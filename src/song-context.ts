import { readChartSongMetadata } from './chart/chart-file-parser'
import { parseChartTokens } from './chart/chart-reparse'
import { wasEdited } from './chart/edit-history'
import type { SongHashMetadata } from './chart/identity/song-hash-20251010'
import { selectSongHashMetadata } from './chart/identity/song-metadata'
import { parseMidiTokens } from './chart/midi-reparse'
import { ChartSource, ParsedChartFile, parseChartSource } from './chart/parse-chart-file'
import { parseRules } from './chart/parse-rules'
import type { IniChartModifiers } from './chart/types'
import { defaultMetadata } from './ini/metadata'
import { scanIni } from './ini/scan-ini'
import { ObjectCache } from './shared/object-cache'
import type { SongDocument } from './song-document'
import type { SongFile } from './song-files'

/** What every view of a song reads first: its song.ini, the settings it gives, and one parse of its chart. */
export interface SongContext {
	/** The song.ini as Clone Hero reads it, with the folder and metadata issues of finding and reading it. */
	readonly ini: ReturnType<typeof scanIni>
	/** The parse settings: song.ini's values over the defaults. */
	readonly settings: IniChartModifiers
	/** The metadata the canonical SongHash reads: song.ini's `[song]` section, or else the `.chart` `[Song]` section. */
	readonly songHashMetadata: SongHashMetadata
	readonly chart: ChartParseOutcome
}

export type ChartParseOutcome =
	| { readonly kind: 'none' }
	| { readonly kind: 'failed'; readonly error: string }
	| { readonly kind: 'parsed'; readonly source: ChartSource; readonly bytes: Uint8Array; readonly parsed: ParsedChartFile }

const contexts = new ObjectCache<SongDocument, SongContext>('songContext')

/**
 * The song's context, calculated once per document. The chart is parsed with Clone Hero's rules (E2), which the
 * gameplay chart and the competitive hashes share; a document made by `editSong` reuses its original's parse for
 * whatever the edit didn't change. The parse is shared, so treat it as read-only.
 */
export function songContext(song: SongDocument): SongContext {
	let context = contexts.get(song)
	if (context === undefined) {
		context = createSongContext(song)
		contexts.set(song, context)
	}
	return context
}

function createSongContext(song: SongDocument): SongContext {
	const ini = scanIni(currentFiles(song))
	const settings: IniChartModifiers = ini.metadata ? { ...defaultMetadata, ...ini.metadata } : defaultMetadata
	const { chart } = song
	const chartSong = chart?.format === 'chart' ? readChartSongMetadata(chart.tokens.bytes) : {}
	return {
		ini,
		settings,
		songHashMetadata: selectSongHashMetadata(ini.songSection, chartSong),
		chart: chart === null ? { kind: 'none' } : parseChart(chart, settings),
	}
}

/** The song's files with its song.ini as edited. Only song.ini is read from them, so the chart file isn't serialized. */
function currentFiles(song: SongDocument): SongFile[] {
	const { ini } = song
	return song.files.map(file => ini !== null && file.fileName === ini.fileName ? { fileName: file.fileName, data: ini.tokens.bytes } : file)
}

function parseChart(chart: NonNullable<SongDocument['chart']>, settings: IniChartModifiers): ChartParseOutcome {
	const rules = parseRules.canonical20260801
	try {
		// A song made by an edit is parsed so that the next edit can reuse the parse; that keeps unresolved copies of
		// every track, so a song that's only read is parsed plainly. Its first edit then parses the whole chart once.
		if (chart.format === 'chart') {
			const source: ChartSource = { format: 'chart', tokens: chart.tokens }
			const parsed = wasEdited(chart.tokens) ? parseChartTokens(chart.tokens, settings, rules) : parseChartSource(source, settings, rules)
			return { kind: 'parsed', source, bytes: chart.tokens.bytes, parsed }
		}
		const source: ChartSource = { format: 'mid', bytes: chart.bytes, tokens: chart.tokens }
		const parsed = chart.tokens !== null && wasEdited(chart.tokens) ? parseMidiTokens(chart.tokens, settings, rules) : parseChartSource(source, settings, rules)
		return { kind: 'parsed', source, bytes: source.bytes, parsed }
	} catch (error) {
		return { kind: 'failed', error: typeof error === 'string' ? error : ((error as Error)?.message ?? JSON.stringify(error)) }
	}
}
