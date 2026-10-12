import { readChartSongEntries } from './chart/chart-file-parser'
import { chartSongIniEntries, secondsToMs } from './ini/chart-song-entries'
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
 * when it doesn't. Values are cleaned for display (style tags removed), and a value that isn't set is Clone Hero's
 * default ("Unknown Artist", -1 for a difficulty, and so on). The keys are song.ini's; without song.ini, the `[Song]`
 * Offset is the delay.
 */
export type SongMetadata = { readonly [key in keyof typeof defaultMetadata]: (typeof defaultMetadata)[key] } & {
	/** The `.chart` `[Song]` Offset, converted from seconds to milliseconds as Clone Hero rounds it; 0 when there's none. */
	readonly chartOffsetMs: number
}

/**
 * Reads a song folder's metadata and the issues with its song.ini and chart file names, without reading the notes:
 * only song.ini and the `.chart` `[Song]` section are read.
 */
export async function parseSongMetadata(files: readonly SongFile[]): Promise<{ readonly metadata: SongMetadata; readonly issues: readonly Issue[] }> {
	const { chartFile, format, folderIssues: chartFolderIssues } = findChartData(files)
	const read = await Promise.all(files.map(async file =>
		hasIniExtension(file.fileName) && isByteSource(file.data) ? { fileName: file.fileName, data: await readFileBytes(file) } : file))
	const ini = scanIni(read)
	const { iniFile } = findIniData(read)
	const chartSong = format === 'chart' && chartFile !== null ? readChartSongEntries(await readFileBytes(chartFile)) : null
	return {
		metadata: songMetadataFrom(ini, chartSong),
		issues: [
			...ini.folderIssues.map(folderIssue),
			...chartFolderIssues.map(folderIssue),
			...ini.metadataIssues.map(metadataIssue),
			...songIniSpellingIssues(iniFile === null ? null : { fileName: iniFile.fileName, tokens: tokenizeIni(fileBytes(iniFile)) }),
		],
	}
}

/** The metadata of a song document, from its song.ini as edited and its `.chart` `[Song]` section. */
export function songMetadata(song: SongDocument): SongMetadata {
	let metadata = documentMetadata.get(song)
	if (metadata === undefined) {
		const { ini, chart, files } = song
		const iniFiles = files.map(file => ini !== null && file.fileName === ini.fileName ? { fileName: file.fileName, data: ini.tokens.bytes } : file)
		metadata = songMetadataFrom(scanIni(iniFiles), chart?.format === 'chart' ? readChartSongEntries(chart.tokens.bytes) : null)
		documentMetadata.set(song, metadata)
	}
	return metadata
}

const documentMetadata = new ObjectCache<SongDocument, SongMetadata>('songMetadata')

function songMetadataFrom(ini: ReturnType<typeof scanIni>, chartSong: ReadonlyMap<string, string> | null): SongMetadata {
	const chartOffsetMs = secondsToMs(chartSong?.get('Offset')) ?? 0
	// Clone Hero reads only song.ini, in any letter case; scanIni also reads another .ini file when there's no song.ini.
	if (ini.metadata !== null && ini.songSection !== null) return { ...ini.metadata, chartOffsetMs }
	// Without song.ini, [Song]'s values go through song.ini's reading and cleaning; its issues are about song.ini.
	return { ...extractSongMetadata(Object.fromEntries(chartSong === null ? [] : chartSongIniEntries(chartSong))).metadata, chartOffsetMs }
}
