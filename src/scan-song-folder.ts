
import { analyzeChart } from './analyze-chart'
import { scanAudio } from './assets/scan-audio'
import { scanFolderFiles } from './assets/scan-folder'
import { decodeAlbumArt, findAlbumArt } from './assets/scan-image'
import { scanVideo } from './assets/scan-video'
import type { ChartStats } from './chart/chart-analysis'
import { getChartHash } from './chart/chart-hash'
import { calculateCompetitiveHashes, CompetitiveHashes } from './competitive'
import { resolveChart } from './gameplay-chart'
import { defaultMetadata } from './ini/metadata'
import { FolderFinding, folderIssue, Issue, metadataIssue } from './issues'
import { songIniSpellingIssues } from './spelling-issues'
import { songContext } from './song-context'
import { findChartData, parseSong } from './song-document'
import { fileBytes, forEachChunk, readFileBytes, SongFile } from './song-files'
import { SongMetadata, songMetadata } from './song-metadata'
import { hasAlbumName } from './shared/file-names'
import type { Instrument } from './types'

/** What `scanSongFolder` calculates besides metadata, issues and statistics. Every cost is opt-in. */
export interface ScanOptions {
	/** The competitive hashes, optionally with each track's BTrack. Default: `false`. */
	readonly competitiveHashes?: boolean | { readonly btracks?: boolean }
	/** The folder, chart and album art file hashes. Default: `false`. */
	readonly fileHashes?: boolean
	/** The album art, and the issues found decoding it. Default: `false`. */
	readonly albumArt?: boolean
	/** The album art sizes accepted, in pixels: art that isn't a square of one of them is reported. Default: `[512]`. */
	readonly albumArtSizes?: readonly number[]
	/**
	 * Files your game reads that Clone Hero and YARG don't, so they aren't reported as unrecognized: a name, matched in
	 * any letter case, or a pattern. Files an operating system made, such as `desktop.ini`, are always reported.
	 */
	readonly extraFiles?: readonly (string | RegExp)[]
	/** Nonstandard spellings every reader reads alike, such as a repeated `.chart` line. Default: `false`. */
	readonly styleNotes?: boolean
	/** Remove style tags, such as `<b>`, from the metadata's text values, for plain-text display. Default: `false`. */
	readonly removeStyleTags?: boolean
}

/** A song folder, scanned. What wasn't asked for is `null`. */
export interface ScannedSong {
	readonly metadata: SongMetadata
	/** Every issue found: the folder's, then the metadata's, then the chart's. */
	readonly issues: readonly Issue[]
	/** Whether the song can be played: it has a readable chart and an audio file. */
	readonly playable: boolean
	readonly hasVideoBackground: boolean
	/** The chart's statistics, or `null` when there's no readable chart. */
	readonly stats: ChartStats | null
	/** `null` unless asked for, or when there's no readable chart. */
	readonly competitive: CompetitiveHashes | null
	/** `null` unless asked for. */
	readonly fileHashes: FileHashes | null
	/** `null` unless asked for, or when the song has none. */
	readonly albumArt: AlbumArt | null
}

/** Hashes that answer "is this the same file?", for caching, deduplication and downloads. */
export interface FileHashes {
	/** MD5 of every file's name and bytes, by file name. */
	readonly folderHash: string
	/** BLAKE3 of the chart file and its non-default parse settings, or `null` when there's no readable chart. */
	readonly chartHash: string | null
	/** MD5 of the album art file, or `null` when there's none. */
	readonly albumArtHash: string | null
}

export interface AlbumArt {
	/** The album art file's bytes, as written. */
	readonly data: Uint8Array
}

/** Scans a song folder in one call: its metadata, issues and statistics, and whatever else `options` asks for. */
export async function scanSongFolder(files: readonly SongFile[], options: ScanOptions = {}): Promise<ScannedSong> {
	const song = await parseSong(files)
	const context = songContext(song)
	const metadata = songMetadata(song, { removeStyleTags: options.removeStyleTags })
	const folderIssues: FolderFinding[] = [...context.ini.folderIssues, ...findChartData(song.files).folderIssues]
	const metadataIssues = [...context.ini.metadataIssues]
	let stats: ChartStats | null = null
	let competitive: CompetitiveHashes | null = null
	let chartIssues: readonly Issue[] = []
	const chartFile = song.chart?.fileName

	if (context.chart.kind === 'failed') folderIssues.push({ folderIssue: 'badChart', description: context.chart.error, file: chartFile })
	if (context.chart.kind === 'parsed') {
		const analysis = analyzeChart(resolveChart(song), { styleNotes: options.styleNotes })
		stats = analysis.stats
		chartIssues = analysis.issues
		if (options.competitiveHashes) {
			competitive = calculateCompetitiveHashes(song, { btracks: typeof options.competitiveHashes === 'object' && options.competitiveHashes.btracks })
			if (!competitive.accepted) {
				folderIssues.push({
					folderIssue: 'badChartIdentity',
					description: `This chart's TrackHashes and SongHash couldn't be calculated: ${competitive.reason}`,
					file: chartFile,
				})
			}
		}
		if (context.ini.metadata !== null) metadataIssues.push(...difficultyIssues(metadata, stats))
	}

	// The album art's names are always checked. The art is read only when it's asked for, or hashed.
	const album = findAlbumArt(song.files)
	folderIssues.push(...album.folderIssues)
	const readAlbumArt = options.albumArt || options.fileHashes
	const assetFiles = readAlbumArt
		? await Promise.all(song.files.map(async file => hasAlbumName(file.fileName) ? { fileName: file.fileName, data: await readFileBytes(file) } : file))
		: song.files
	let albumArt: AlbumArt | null = null
	if (options.albumArt && album.file !== null) {
		const data = fileBytes(assetFiles[song.files.indexOf(album.file)])
		const decoded = decodeAlbumArt(album.file.fileName, data, options.albumArtSizes ?? [512])
		folderIssues.push(...decoded.folderIssues)
		if (decoded.decoded) albumArt = { data }
	}
	const audio = scanAudio(song.files)
	folderIssues.push(...audio.folderIssues)
	const video = scanVideo(song.files)
	folderIssues.push(...video.folderIssues)
	folderIssues.push(...scanFolderFiles(song.files, { chartFile: chartFile ?? null, songSection: context.ini.songSection, extraFiles: options.extraFiles ?? [] }))

	return {
		metadata,
		issues: [
			...folderIssues.map(folderIssue),
			...metadataIssues.map(issue => metadataIssue(issue, song.ini?.fileName ?? null)),
			...songIniSpellingIssues(song.ini),
			...chartIssues,
		],
		playable: context.chart.kind === 'parsed' && !audio.folderIssues.some(issue => issue.folderIssue === 'noAudio'),
		hasVideoBackground: video.hasVideoBackground,
		stats,
		competitive,
		fileHashes: options.fileHashes ? await fileHashes(assetFiles, context) : null,
		albumArt,
	}
}

/** song.ini difficulty ratings missing for a charted instrument, or set for one that isn't charted. */
function difficultyIssues(metadata: SongMetadata, stats: ChartStats) {
	const issues: { metadataIssue: 'missingValue' | 'extraValue'; description: string }[] = []
	const ratings: readonly (readonly [Instrument, keyof typeof defaultMetadata])[] = [
		['guitar', 'diff_guitar'],
		['guitarcoop', 'diff_guitar_coop'],
		['rhythm', 'diff_rhythm'],
		['bass', 'diff_bass'],
		['drums', 'diff_drums'],
		['keys', 'diff_keys'],
		['keysghl', 'diff_keys_ghl'],
		['guitarghl', 'diff_guitarghl'],
		['guitarcoopghl', 'diff_guitar_coop_ghl'],
		['rhythmghl', 'diff_rhythm_ghl'],
		['bassghl', 'diff_bassghl'],
	]
	for (const [instrument, key] of ratings) {
		if (stats.instruments.includes(instrument) && metadata[key] === defaultMetadata[key]) {
			issues.push({ metadataIssue: 'missingValue', description: `Metadata is missing a "${key}" value.` })
		}
	}
	if (stats.hasVocals && metadata.diff_vocals === defaultMetadata.diff_vocals) {
		issues.push({ metadataIssue: 'missingValue', description: 'Metadata is missing a "diff_vocals" value.' })
	}
	for (const [instrument, key] of ratings) {
		if (metadata[key] !== defaultMetadata[key] && !stats.instruments.includes(instrument)) {
			issues.push({ metadataIssue: 'extraValue', description: `Metadata contains "${key}", but ${instrument} is not charted.` })
		}
	}
	if (metadata.diff_vocals !== defaultMetadata.diff_vocals && !stats.hasVocals) {
		issues.push({ metadataIssue: 'extraValue', description: 'Metadata contains "diff_vocals", but vocals are not charted.' })
	}
	return issues
}

async function fileHashes(files: readonly SongFile[], context: ReturnType<typeof songContext>): Promise<FileHashes> {
	// MD5 is loaded only when file hashes are asked for, so a tool that never asks doesn't bundle it.
	const { md5 } = await import('js-md5')
	// Each file's name, then its bytes, in file name order. A large file is read in chunks.
	const folder = md5.create()
	for (const file of [...files].sort((a, b) => a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0)) {
		folder.update(file.fileName)
		await forEachChunk(file, chunk => folder.update(chunk))
	}
	const albumFile = [...files].reverse().find(file => hasAlbumName(file.fileName))
	return {
		folderHash: folder.hex(),
		chartHash: context.chart.kind === 'parsed' ? getChartHash(context.chart.bytes, context.settings) : null,
		albumArtHash: albumFile === undefined ? null : md5.create().update(await readFileBytes(albumFile)).hex(),
	}
}
