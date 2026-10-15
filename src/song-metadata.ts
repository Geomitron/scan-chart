import { readChartSongEntries } from './chart/chart-file-parser'
import { chartSongIniEntries, previewEndMs, secondsToMs } from './ini/chart-song-entries'
import { defaultMetadata } from './ini/metadata'
import { tokenizeIni } from './ini/parse-ini'
import { extractSongMetadata, findIniData, scanIni } from './ini/scan-ini'
import { folderIssue, Issue, metadataIssue } from './issues'
import { findChartData, SongDocument } from './song-document'
import { fileBytes, isByteSource, readFileBytes, SongFile } from './song-files'
import { hasIniExtension } from './shared/file-names'
import { ObjectCache } from './shared/object-cache'
import { songIniSpellingIssues } from './spelling-issues'

/**
 * A song's metadata as Clone Hero reads it: song.ini when the song has one, and the `.chart` `[Song]` section only
 * when it doesn't. A value that isn't set is Clone Hero's default ("Unknown Artist", -1 for a difficulty, and so on).
 * Text keeps its style tags, such as `<b>`, which Clone Hero shows as formatting, unless `removeStyleTags` asks for
 * plain text. The keys are song.ini's; without song.ini, the `[Song]` Offset is the delay, and a preview time song.ini
 * leaves unset is read from `[Song]`.
 */
export type SongMetadata = { readonly [key in keyof typeof defaultMetadata]: (typeof defaultMetadata)[key] } & {
	/** The `.chart` `[Song]` Offset, converted from seconds to milliseconds as Clone Hero rounds it; 0 when there's none. */
	readonly chartOffsetMs: number
}

/** How to read metadata. */
export interface SongMetadataOptions {
	/** Remove style tags, such as `<b>` and `<color=#AEFFFF>`, from text values, for plain-text display. Default: `false`. */
	readonly removeStyleTags?: boolean
}

/**
 * Reads a song folder's metadata and the issues with its song.ini and chart file names, without reading the notes:
 * only song.ini and the `.chart` `[Song]` section are read.
 */
export async function parseSongMetadata(
	files: readonly SongFile[],
	options: SongMetadataOptions = {},
): Promise<{ readonly metadata: SongMetadata; readonly issues: readonly Issue[] }> {
	const { chartFile, format, folderIssues: chartFolderIssues } = findChartData(files)
	const read = await Promise.all(files.map(async file =>
		hasIniExtension(file.fileName) && isByteSource(file.data) ? { fileName: file.fileName, data: await readFileBytes(file) } : file))
	const removeStyleTags = options.removeStyleTags ?? false
	const ini = scanIni(read, { removeStyleTags })
	const { iniFile } = findIniData(read)
	const chartSong = format === 'chart' && chartFile !== null ? readChartSongEntries(await readFileBytes(chartFile)) : null
	return {
		metadata: songMetadataFrom(ini, chartSong, removeStyleTags),
		issues: [
			...ini.folderIssues.map(folderIssue),
			...chartFolderIssues.map(folderIssue),
			...ini.metadataIssues.map(metadataIssue),
			...songIniSpellingIssues(iniFile === null ? null : { fileName: iniFile.fileName, tokens: tokenizeIni(fileBytes(iniFile)) }),
		],
	}
}

/** The metadata of a song document, from its song.ini as edited and its `.chart` `[Song]` section. */
export function songMetadata(song: SongDocument, options: SongMetadataOptions = {}): SongMetadata {
	const removeStyleTags = options.removeStyleTags ?? false
	let cached = documentMetadata.get(song)
	if (cached === undefined) documentMetadata.set(song, cached = {})
	const variant = removeStyleTags ? 'plain' : 'asWritten'
	let metadata = cached[variant]
	if (metadata === undefined) {
		const { ini, chart, files } = song
		const iniFiles = files.map(file => ini !== null && file.fileName === ini.fileName ? { fileName: file.fileName, data: ini.tokens.bytes } : file)
		metadata = songMetadataFrom(scanIni(iniFiles, { removeStyleTags }), chart?.format === 'chart' ? readChartSongEntries(chart.tokens.bytes) : null, removeStyleTags)
		cached[variant] = metadata
	}
	return metadata
}

function previewFallbacks(metadata: Pick<SongMetadata, 'preview_start_time' | 'preview_end_time'>, chartSong: ReadonlyMap<string, string> | null): Partial<SongMetadata> {
	const start = secondsToMs(chartSong?.get('PreviewStart'))
	const end = previewEndMs(chartSong?.get('PreviewEnd'))
	return {
		...(metadata.preview_start_time === -1 && start !== null ? { preview_start_time: start } : {}),
		...(metadata.preview_end_time === -1 && end !== null ? { preview_end_time: end } : {}),
	}
}

const documentMetadata = new ObjectCache<SongDocument, { plain?: SongMetadata; asWritten?: SongMetadata }>('songMetadata')

function songMetadataFrom(ini: ReturnType<typeof scanIni>, chartSong: ReadonlyMap<string, string> | null, removeStyleTags: boolean): SongMetadata {
	const chartOffsetMs = secondsToMs(chartSong?.get('Offset')) ?? 0
	// Clone Hero reads only song.ini, in any letter case; scanIni also reads another .ini file when there's no song.ini.
	// A preview time song.ini leaves unset, at -1, is read from [Song], as Clone Hero reads PreviewStart.
	if (ini.metadata !== null && ini.songSection !== null) return { ...ini.metadata, ...previewFallbacks(ini.metadata, chartSong), chartOffsetMs }
	// Without song.ini, [Song]'s values go through song.ini's reading and cleaning; its issues are about song.ini.
	return { ...extractSongMetadata(Object.fromEntries(chartSong === null ? [] : chartSongIniEntries(chartSong)), { removeStyleTags }).metadata, chartOffsetMs }
}
