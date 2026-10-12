import { ChartFileTokens, tokenizeChartFile } from './chart/chart-file-parser'
import { findChartData } from './chart/parse-chart-and-ini'
import { IniTokens, tokenizeIni } from './ini/parse-ini'
import { findIniData } from './ini/scan-ini'
import type { File } from './types'

/** The chart file of a song, tokenized in its format. */
export type ChartDocument =
	| { readonly format: 'chart'; readonly fileName: string; readonly tokens: ChartFileTokens }
	| { readonly format: 'mid'; readonly fileName: string; readonly bytes: Uint8Array }

/** The song.ini of a song, tokenized. */
export interface IniDocument {
	readonly fileName: string
	readonly tokens: IniTokens
}

/**
 * A song folder as a document: the chart file and song.ini that Clone Hero reads, tokenized, and every file as
 * given. Every view of the song is derived from it.
 */
export interface SongDocument {
	/** Every file of the folder, in the order given. */
	readonly files: readonly File[]
	/** The chart file Clone Hero reads, or `null` when the folder has none. */
	readonly chart: ChartDocument | null
	/** The song.ini Clone Hero reads, or `null` when the folder has none. */
	readonly ini: IniDocument | null
}

/** Parses a song folder into a document. Never throws: a malformed chart or song.ini is reported when it is read. */
export function parseSong(files: readonly File[]): SongDocument {
	const { chartFile, format } = findChartData(files)
	const { iniFile } = findIniData(files)
	return {
		files,
		chart: chartFile === null ? null
			: format === 'mid' ? { format, fileName: chartFile.fileName, bytes: chartFile.data }
			: { format: 'chart', fileName: chartFile.fileName, tokens: tokenizeChartFile(chartFile.data) },
		ini: iniFile === null ? null : { fileName: iniFile.fileName, tokens: tokenizeIni(iniFile.data) },
	}
}

/** Writes a song document back to files: an unedited document gives back every file byte for byte. */
export function serializeSong(song: SongDocument): File[] {
	return song.files.map(file =>
		file.fileName === song.chart?.fileName ? { fileName: file.fileName, data: chartBytes(song.chart) }
		: file.fileName === song.ini?.fileName ? { fileName: file.fileName, data: song.ini.tokens.bytes }
		: file)
}

function chartBytes(chart: ChartDocument): Uint8Array {
	return chart.format === 'mid' ? chart.bytes : chart.tokens.bytes
}
