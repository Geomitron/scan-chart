import { defaultMetadata } from '../ini/metadata'
import { ObjectCache } from '../shared/object-cache'
import { songContext } from '../song-context'
import { File, FolderIssueType, MetadataIssueType } from '../types'
import { findChartData, parseSongFiles, type SongDocument } from '../song-document'
import { IniChartModifiers } from './types'
import { ChartSource, ParsedChartFile } from './parse-chart-file'
import type { SongHashMetadata } from './identity/song-hash-20251010'

/**
 * Folder-parse result: a parsed chart file plus source bytes and ini modifiers
 * needed for downstream hashing.
 */
export type ParsedChart = ParsedChartFile & {
	/**
	 * The raw bytes of the source chart file. Needed by `scanChart` to compute
	 * `chartHash`, which is `blake3(chartBytes ++ ini-modifier name/value
	 * pairs)` — the file contents directly plus the few ini knobs that affect
	 * parsing — and to parse the chart again with the canonical identity rules.
	 */
	chartBytes: Uint8Array
	/** The format the chart was parsed from. */
	format: 'chart' | 'mid'
	/** The fully-resolved ini modifiers that influenced parsing. */
	iniChartModifiers: IniChartModifiers
	/**
	 * The metadata Clone Hero hashes into the canonical SongHash, before the SongHash writer resolves it.
	 * When a song.ini with a `[song]` section loads, only its values are used; otherwise the `.chart [Song]`
	 * values are. Blank values are "Unknown …". Unlike `metadata`, style tags and the "0"/"-1" sentinels remain.
	 */
	songHashMetadata: SongHashMetadata
}

export interface ParseChartAndIniResult {
	/**
	 * The parsed chart, or `null` if a chart file could not be found or could
	 * not be parsed. Inspect `chartFolderIssues` for the reason.
	 *
	 * `parsedChart.metadata` holds the normalized metadata: values from
	 * `song.ini` take precedence over the chart file's `[Song]` section, and
	 * unknown ini key/value pairs are preserved in `metadata.extraIniFields`
	 * for round-trip writing.
	 */
	parsedChart: ParsedChart | null
	/**
	 * `true` if the folder contains a parseable `song.ini` (i.e. a file was
	 * present AND it had a readable `[Song]` section). Useful for downstream
	 * checks that only make sense when ini-derived metadata is available —
	 * e.g. "ini is missing a diff_X value" issues don't apply at all when the
	 * ini file doesn't exist.
	 */
	hasIni: boolean
	/**
	 * The parsed `song.ini` metadata (with defaults filled in for missing
	 * fields), or `null` if no readable `song.ini` was found. Exposed so
	 * `scanChart` can surface ini-derived metadata (artist, name, year, …)
	 * even when `notes.{chart,mid}` failed to parse — matching pre-9.0
	 * scan-chart behavior that catalog consumers depend on for keeping
	 * broken-but-known charts visible.
	 */
	iniMetadata: typeof defaultMetadata | null
	/**
	 * Folder-level issues from chart file discovery and parsing
	 * (`noChart`, `invalidChart`, `multipleChart`, `badChart`).
	 */
	chartFolderIssues: { folderIssue: FolderIssueType; description: string }[]
	/**
	 * Folder-level issues from ini scanning (`noMetadata`, `invalidIni`,
	 * `invalidMetadata`, `badIniLine`, `multipleIniFiles`).
	 */
	iniFolderIssues: { folderIssue: FolderIssueType; description: string }[]
	/** Validation issues with ini values. */
	iniMetadataIssues: { metadataIssue: MetadataIssueType; description: string }[]
}

/**
 * The tokenized chart each parsed chart came from, and the canonical parse it extends, which the competitive hashes
 * reuse instead of parsing the chart again.
 */
export const parsedCharts = new ObjectCache<ParsedChart, { readonly source: ChartSource; readonly parsed: ParsedChartFile }>('parsedChart')

/**
 * Parse a chart folder's `notes.{mid,chart}` and `song.ini` into a
 * `ParsedChart`, with no hashing or audio/image scanning. Pair with
 * `scanChart` if you need hashes, chart issues, or asset scanning.
 *
 * The notes are read with Clone Hero's rules, the canonical ones (E2): a
 * `.chart` section with no notes isn't a track, only the first `.mid` track
 * of an instrument is read, and a `.mid` tap phrase includes its end tick.
 */
export function parseChartAndIni(files: File[]): ParseChartAndIniResult {
	return parseSongChartAndIni(parseSongFiles(files))
}

/** `parseChartAndIni` for a song document, from its context: what the 8.x writers, the converter's encoders, take. */
export function parseSongChartAndIni(song: SongDocument): ParseChartAndIniResult {
	const { folderIssues: chartFolderIssues } = findChartData(song.files)
	const { ini: iniData, settings: iniChartModifiers, songHashMetadata, chart } = songContext(song)

	let parsedChart: ParsedChart | null = null
	if (chart.kind === 'parsed') {
		const inner = chart.parsed
		// Merge [Song]-section metadata with song.ini metadata onto a single
		// `parsedChart.metadata`. song.ini wins where both provide a value —
		// the ini file is authoritative and the chart file's [Song] block is
		// a legacy overlap. Unknown ini keys are preserved in `extraIniFields`
		// for round-trip writing.
		const mergedMetadata: ParsedChart['metadata'] = {
			...inner.metadata,
			...(iniData.metadata ?? {}),
		}
		if (Object.keys(iniData.unknownIniValues).length > 0) {
			mergedMetadata.extraIniFields = { ...iniData.unknownIniValues }
		}

		parsedChart = Object.assign({}, inner, {
			metadata: mergedMetadata,
			chartBytes: chart.bytes,
			format: chart.source.format,
			iniChartModifiers,
			songHashMetadata,
		}) as ParsedChart
		parsedCharts.set(parsedChart, { source: chart.source, parsed: inner })
	} else if (chart.kind === 'failed') {
		chartFolderIssues.push({ folderIssue: 'badChart', description: chart.error })
	}

	return {
		parsedChart,
		hasIni: iniData.metadata !== null,
		iniMetadata: iniData.metadata,
		chartFolderIssues,
		iniFolderIssues: iniData.folderIssues,
		iniMetadataIssues: iniData.metadataIssues,
	}
}
