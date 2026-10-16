
import { analyzeChart } from './analyze-chart'
import { audioNameRecommendations, scanAudio } from './assets/scan-audio'
import { scanFolderFiles } from './assets/scan-folder'
import { decodeAlbumArt, findAlbumArt } from './assets/scan-image'
import { scanMedia } from './assets/scan-media'
import { scanVideo } from './assets/scan-video'
import type { ChartStats } from './chart/chart-analysis'
import { getChartHash } from './chart/chart-hash'
import { parseChartSource, type ParsedChartFile } from './chart/parse-chart-file'
import { parseRules } from './chart/parse-rules'
import { calculateCompetitiveHashes, CompetitiveHashes } from './competitive'
import { resolveChart } from './gameplay-chart'
import { explicitLyricMatches } from './ini/explicit-lyrics'
import { ignoredIssueCodes, songIniIssues } from './ini/ini-checks'
import { metadataStyleIssues } from './ini/metadata-style'
import { defaultMetadata } from './ini/metadata'
import { FolderFinding, folderIssue, Issue, MetadataFinding, metadataIssue } from './issues'
import { songIniSpellingIssues } from './spelling-issues'
import { SongContext, songContext } from './song-context'
import { documentFiles, findChartData, parseSong, SongDocument, songOrigin } from './song-document'
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
	 * The issues found reading the audio, image and video files, such as an audio bitrate or a background image's size. It
	 * reads each audio and video file's headers, and the album art and background images whole. Default: `false`.
	 */
	readonly mediaIssues?: boolean
	/**
	 * Files your game reads that Clone Hero and YARG don't, so they aren't reported as unrecognized: a name, matched in
	 * any letter case, or a pattern. Files an operating system made, such as `desktop.ini`, are always reported.
	 */
	readonly extraFiles?: readonly (string | RegExp)[]
	/** song.ini tags your game reads that Clone Hero and YARG don't, so they aren't reported as unknown: a tag, or a pattern of its lowercase name. */
	readonly extraIniKeys?: readonly (string | RegExp)[]
	/**
	 * Style notes: what every reader reads alike. These are nonstandard spellings, such as a repeated `.chart` line, and
	 * song.ini lines: tags out of the standard order, `-1` numbers and blank text values, and lines that change nothing. Default: `false`.
	 */
	readonly styleNotes?: boolean
	/**
	 * Guesses about the metadata's style, such as credits joined with "and", which can be wrong. Default: `false`. One
	 * guess, `missingExplicitLyrics`, is reported without it.
	 */
	readonly metadataStyle?: boolean
	/** Remove style tags, such as `<b>`, from the metadata's text values, for plain-text display. Default: `false`. */
	readonly removeStyleTags?: boolean
}

/** A song folder, scanned. What wasn't asked for is `null`. */
export interface ScannedSong {
	readonly metadata: SongMetadata
	/** Every issue found, but those song.ini's `ignored_issues` lists: the folder's, then the metadata's, then the chart's. */
	readonly issues: readonly Issue[]
	/** The issues found whose codes song.ini's `ignored_issues` lists, in the same order. */
	readonly ignoredIssues: readonly Issue[]
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
	return scanSong(await parseSong(files), options)
}

/** `scanSongFolder` for a parsed song. */
export async function scanSong(song: SongDocument, options: ScanOptions = {}): Promise<ScannedSong> {
	// An edited song's chart and song.ini files are its edited ones.
	const files = songOrigin(song) === undefined ? song.files : documentFiles(song)
	const context = songContext(song)
	const metadata = songMetadata(song, { removeStyleTags: options.removeStyleTags })
	const folderIssues: FolderFinding[] = [...context.ini.folderIssues, ...findChartData(files).folderIssues]
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
	if (song.ini !== null && context.ini.metadata !== null && context.ini.songSection !== null) {
		metadataIssues.push(...songIniFindings(song, context, stats, options))
		if (options.metadataStyle) metadataIssues.push(...metadataStyleIssues(context.ini.metadata))
	}
	const ignored = context.ini.songSection === null ? null : ignoredIssueCodes(context.ini.songSection)
	metadataIssues.push(...ignored?.issues ?? [])

	// The album art's names are always checked. The art is read only when it's asked for, hashed, or checked.
	const album = findAlbumArt(files)
	folderIssues.push(...album.folderIssues)
	const readAlbumArt = options.albumArt || options.fileHashes || options.mediaIssues
	const assetFiles = readAlbumArt
		? await Promise.all(files.map(async file => hasAlbumName(file.fileName) ? { fileName: file.fileName, data: await readFileBytes(file) } : file))
		: files
	let albumArt: AlbumArt | null = null
	if ((options.albumArt || options.mediaIssues) && album.file !== null) {
		const data = fileBytes(assetFiles[files.indexOf(album.file)])
		const decoded = decodeAlbumArt(album.file.fileName, data, options.albumArtSizes ?? [512])
		folderIssues.push(...decoded.folderIssues)
		if (decoded.decoded && options.albumArt) albumArt = { data }
	}
	const audio = scanAudio(files)
	const songLength = context.ini.songSection !== null && context.ini.metadata !== null && context.ini.metadata.song_length > 0 ? context.ini.metadata.song_length : null
	const media = options.mediaIssues ? await scanMedia(files, audio.stemFiles, songLength) : null
	// An audio file that holds Opus is reported for its extension instead.
	const audioNames = audioNameRecommendations(audio.stemFiles).filter(issue => issue.folderIssue !== 'audioFormat' || !media?.opusFiles.includes(issue.file!))
	folderIssues.push(...audio.folderIssues, ...audioNames, ...media?.folderIssues ?? [])
	metadataIssues.push(...media?.metadataIssues ?? [])
	const video = scanVideo(files)
	folderIssues.push(...video.folderIssues)
	folderIssues.push(...scanFolderFiles(files, { chartFile: chartFile ?? null, songSection: context.ini.songSection, extraFiles: options.extraFiles ?? [] }))

	// An issue about ignored_issues itself is never ignored.
	const aboutTag = new Set<Issue>()
	const issues = [
		...folderIssues.map(folderIssue),
		...metadataIssues.map(finding => {
			const issue = metadataIssue({ ...finding, file: song.ini?.fileName })
			if (ignored?.issues.includes(finding)) aboutTag.add(issue)
			return issue
		}),
		...songIniSpellingIssues(song.ini),
		...chartIssues,
	]
	const isIgnored = (issue: Issue) => ignored !== null && ignored.codes.has(issue.code) && !aboutTag.has(issue)
	return {
		metadata,
		issues: issues.filter(issue => !isIgnored(issue)),
		ignoredIssues: issues.filter(isIgnored),
		playable: context.chart.kind === 'parsed' && !audio.folderIssues.some(issue => issue.folderIssue === 'noAudio'),
		hasVideoBackground: video.hasVideoBackground,
		stats,
		competitive,
		fileHashes: options.fileHashes ? await fileHashes(assetFiles, context) : null,
		albumArt,
	}
}

/** The song.ini checks' findings, given the chart's statistics; none when Clone Hero reads no song.ini `[song]` section. */
export function songIniFindings(song: SongDocument, context: SongContext, stats: ChartStats | null, options: ScanOptions): MetadataFinding[] {
	const { chart, ini, settings } = context
	if (song.ini === null || ini.metadata === null || ini.songSection === null) return []
	return songIniIssues({
		tokens: song.ini.tokens,
		songSection: ini.songSection,
		metadata: ini.metadata,
		requiredKeys: stats === null ? [] : chartedDifficultyKeys(stats),
		chart: chart.kind !== 'parsed' || stats === null ? null : {
			format: chart.source.format,
			drumType: stats.instruments.includes('drums') ? chart.parsed.drumType : null,
			// The games place the chart against the audio by song.ini's delay, or by the .chart Offset without one.
			lastNoteEndMs: lastNoteEndMs(chart.parsed) + (ini.metadata.delay !== 0 ? ini.metadata.delay : songMetadata(song).chartOffsetMs),
			detectedDrumType: () => parseChartSource(chart.source, { ...settings, pro_drums: false, five_lane_drums: false }, parseRules.canonical20260801).drumType,
			solosReadAsStarPower: () => {
				const starPower = (parsed: ParsedChartFile) => JSON.stringify(parsed.trackData.map(track => track.starPowerSections.map(phrase => [phrase.tick, phrase.length])))
				return starPower(parseChartSource(chart.source, { ...settings, multiplier_note: 0 }, parseRules.canonical20260801)) !== starPower(chart.parsed)
			},
			explicitLyrics: () => explicitLyricMatches(chart.parsed.vocalTracks),
		},
		extraIniKeys: options.extraIniKeys ?? [],
		styleNotes: options.styleNotes ?? false,
	})
}

/** Where the chart's last note ends, sustain included, in milliseconds, or 0 when it has no notes. */
function lastNoteEndMs(chart: ParsedChartFile): number {
	let end = 0
	for (const track of chart.trackData) {
		for (const group of track.noteEventGroups) for (const note of group) end = Math.max(end, note.msTime + note.msLength)
	}
	return end
}

/** Each instrument's song.ini difficulty rating. */
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

/** The difficulty ratings a chart needs: one for each charted instrument, and for vocals. */
function chartedDifficultyKeys(stats: ChartStats): string[] {
	return [...ratings.filter(([instrument]) => stats.instruments.includes(instrument)).map(([, key]) => key), ...(stats.hasVocals ? ['diff_vocals'] : [])]
}

/** song.ini difficulty ratings missing for a charted instrument, or set for one that isn't charted. */
function difficultyIssues(metadata: SongMetadata, stats: ChartStats) {
	const issues: { metadataIssue: 'missingValue' | 'extraValue'; description: string }[] = []
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
