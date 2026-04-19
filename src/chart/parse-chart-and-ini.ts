import * as _ from 'lodash'

import { defaultMetadata, scanIni } from '../ini'
import { FolderIssueType, MetadataIssueType } from '../interfaces'
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
	 */
	parsedChart: ParsedChart | null
	/**
	 * Folder-level issues from chart file discovery and parsing
	 * (`noChart`, `invalidChart`, `multipleChart`, `badChart`).
	 */
	chartFolderIssues: { folderIssue: FolderIssueType; description: string }[]
	/** The metadata parsed from `song.ini`, or `null` if no ini was present. */
	iniMetadata: typeof defaultMetadata | null
	/**
	 * Folder-level issues from ini scanning (`noMetadata`, `invalidIni`,
	 * `invalidMetadata`, `badIniLine`, `multipleIniFiles`).
	 */
	iniFolderIssues: { folderIssue: FolderIssueType; description: string }[]
	/** Validation issues with ini values. */
	iniMetadataIssues: { metadataIssue: MetadataIssueType; description: string }[]
	/** ini key/value pairs not in scan-chart's known list. */
	iniUnknownValues: { [key: string]: string }
}

/**
 * Parse a chart folder's `notes.{mid,chart}` and `song.ini` into a
 * `ParsedChart`, with no hashing or audio/image scanning. Pair with
 * `scanChart` if you need hashes, chart issues, or asset scanning.
 */
export function parseChartAndIni(files: { fileName: string; data: Uint8Array }[]): ParseChartAndIniResult {
	const iniData = scanIni(files)
	const iniChartModifiers: IniChartModifiers = iniData.metadata
		? { ...defaultIniChartModifiers, ...iniData.metadata }
		: defaultIniChartModifiers

	const { chartData, format, folderIssues: chartFolderIssues } = findChartData(files)

	let parsedChart: ParsedChart | null = null
	if (chartData) {
		try {
			const inner = parseChartFile(chartData, format!, iniChartModifiers)
			parsedChart = Object.assign({}, inner, {
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
		chartFolderIssues,
		iniMetadata: iniData.metadata,
		iniFolderIssues: iniData.folderIssues,
		iniMetadataIssues: iniData.metadataIssues,
		iniUnknownValues: iniData.unknownIniValues,
	}
}

function findChartData(files: { fileName: string; data: Uint8Array }[]) {
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
