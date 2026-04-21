import * as _ from 'lodash'

import { scanIni } from '../ini'
import { File, FolderIssueType, MetadataIssueType } from '../interfaces'
import { getExtension, hasChartExtension, hasChartName } from '../utils'
import { defaultIniChartModifiers, IniChartModifiers } from './note-parsing-interfaces'
import { parseChartFile } from './notes-parser'

/**
 * The full parsed chart, including the source bytes and ini modifiers needed
 * for downstream hashing.
 */
export type ParsedChart = ReturnType<typeof parseChartFile> & {
	/**
	 * The raw bytes of the source chart file. Needed by `scanChart` to compute
	 * `chartHash`, which is `blake3(chartBytes ++ ini-modifier name/value
	 * pairs)` — the file contents directly plus the few ini knobs that affect
	 * parsing. (Predates the SongHash spec, which scan-chart does not yet
	 * implement; once it does, this field can be dropped.)
	 */
	chartBytes: Uint8Array
	/** The format the chart was parsed from. */
	format: 'chart' | 'mid'
	/** The fully-resolved ini modifiers that influenced parsing. */
	iniChartModifiers: IniChartModifiers
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
 * Parse a chart folder's `notes.{mid,chart}` and `song.ini` into a
 * `ParsedChart`, with no hashing or audio/image scanning. Pair with
 * `scanChart` if you need hashes, chart issues, or asset scanning.
 */
export function parseChartAndIni(files: File[]): ParseChartAndIniResult {
	const iniData = scanIni(files)
	const iniChartModifiers: IniChartModifiers = iniData.metadata
		? { ...defaultIniChartModifiers, ...iniData.metadata }
		: defaultIniChartModifiers

	const { chartData, format, folderIssues: chartFolderIssues } = findChartData(files)

	let parsedChart: ParsedChart | null = null
	if (chartData) {
		try {
			const inner = parseChartFile(chartData, format!, iniChartModifiers)

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
				chartBytes: chartData,
				format: format!,
				iniChartModifiers,
			}) as ParsedChart
		} catch (err) {
			chartFolderIssues.push({
				folderIssue: 'badChart',
				description: typeof err === 'string' ? err : ((err as Error)?.message ?? JSON.stringify(err)),
			})
		}
	}

	return {
		parsedChart,
		hasIni: iniData.metadata !== null,
		chartFolderIssues,
		iniFolderIssues: iniData.folderIssues,
		iniMetadataIssues: iniData.metadataIssues,
	}
}

function findChartData(files: File[]) {
	const folderIssues: { folderIssue: FolderIssueType; description: string }[] = []

	const chartFiles = _.chain(files)
		.filter(f => hasChartExtension(f.fileName))
		.orderBy([f => hasChartName(f.fileName), f => getExtension(f.fileName).toLowerCase() === 'mid'], ['desc', 'desc'])
		.value()

	for (const file of chartFiles) {
		if (!hasChartName(file.fileName)) {
			folderIssues.push({
				folderIssue: 'invalidChart',
				description: `"${file.fileName}" is not named "notes.${getExtension(file.fileName).toLowerCase()}".`,
			})
		}
	}

	if (chartFiles.length > 1) {
		folderIssues.push({ folderIssue: 'multipleChart', description: 'This chart has multiple .chart/.mid files.' })
	}

	if (chartFiles.length === 0) {
		folderIssues.push({ folderIssue: 'noChart', description: 'This chart doesn\'t have "notes.chart"/"notes.mid".' })
		return { chartData: null, format: null, folderIssues }
	} else {
		return {
			chartData: chartFiles[0].data,
			format: (getExtension(chartFiles[0].fileName).toLowerCase() === 'mid' ? 'mid' : 'chart') as 'mid' | 'chart',
			folderIssues,
		}
	}
}
