import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'

import { parseChartAndIni } from '../../src/chart/parse-chart-and-ini'
import { parseChartFileFrozenLegacyIdentity } from '../../src/chart/parse-chart-file'
import { canonical20260801, songBundle20251010 } from '../../src/chart/identity/public'
import type { TrackDuration } from '../../src/chart/chart-duration'
import type { Difficulty, File, Instrument, ScannedChartMetadata } from '../../src/types'
import type { SongHashMetadata } from '../../src/chart/identity/song-hash-20251010'
import { identityTrackKey, IdentityTrackKey } from '../../src/chart/identity/track-key'
import { resolveHistoricalDuration } from './duration'

const skippedDirectories = new Set(['.git', 'node_modules'])

interface ArtifactReference {
	readonly path: string
	readonly bytes: number
	readonly sha256: string
}

interface TrackManifest {
	readonly instrument: Instrument
	readonly difficulty: Difficulty
	readonly duration: TrackDuration
	readonly trackHash: string
	readonly physicalBTrack: ArtifactReference
	readonly projection: ArtifactReference
	readonly digest: ArtifactReference
	readonly trackHashArtifact: ArtifactReference
	readonly semantics?: ArtifactReference
}

interface SongFolderSuccess {
	readonly kind: 'success'
	readonly path: string
	readonly manifest: string
	readonly legacySongHash: string | null
	readonly canonicalSongHash: string
}

interface SongFolderFailure {
	readonly kind: 'failure'
	readonly path: string
	readonly error: string
}

type SongFolderResult = SongFolderSuccess | SongFolderFailure

export interface GenerateRunResult {
	readonly outputDirectory: string
	readonly results: readonly SongFolderResult[]
}

function posix(path: string): string {
	return path.split(sep).join('/')
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function sha256(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex')
}

function json(value: unknown): Uint8Array {
	return new TextEncoder().encode(`${JSON.stringify(value, (_key, current: unknown) =>
		typeof current === 'bigint' ? current.toString() : current, 2)}\n`)
}

export function toolProvenance(): object {
	return {
		name: 'ch-identity',
		version: '0.2.0',
		scanChartVersion: process.env.SCAN_CHART_BUILD_VERSION ?? 'working-tree',
		scanChartCommit: process.env.SCAN_CHART_BUILD_COMMIT ?? 'working-tree',
		scanChartDirty: process.env.SCAN_CHART_BUILD_DIRTY !== 'false',
		sourceTreeSha256: process.env.SCAN_CHART_BUILD_SOURCE_TREE_SHA256 ?? 'working-tree',
		profiles: {
			legacy: 'clone-hero-1.1.0.6142',
			canonical: '20260801',
			songHashWireVersion: 20251010,
		},
	}
}

async function writeArtifact(root: string, path: string, bytes: Uint8Array): Promise<ArtifactReference> {
	const target = join(root, ...path.split('/'))
	await mkdir(dirname(target), { recursive: true })
	await writeFile(target, bytes)
	return { path, bytes: bytes.byteLength, sha256: sha256(bytes) }
}

async function prepareOutputPath(path: string): Promise<void> {
	try {
		const existing = await lstat(path)
		if (!existing.isDirectory()) throw new Error(`Output path already exists and is not a directory: ${path}`)
		const entries = await readdir(path)
		if (entries.length > 0) throw new Error(`Output directory is not empty: ${path}`)
		await rmdir(path)
	} catch (error: unknown) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
		throw error
	}
}

function sourceFiles(entries: readonly string[]): readonly string[] {
	return entries.filter(name => {
		const lower = name.toLowerCase()
		return lower === 'notes.chart' || lower === 'notes.mid'
	})
}

export async function discoverSongFolders(input: string): Promise<readonly string[]> {
	const root = resolve(input)
	const found: string[] = []
	const walk = async (directory: string): Promise<void> => {
		const entries = await readdir(directory, { withFileTypes: true })
		if (sourceFiles(entries.filter(entry => entry.isFile()).map(entry => entry.name)).length > 0) {
			found.push(directory)
			return
		}
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			if (entry.isDirectory() && !skippedDirectories.has(entry.name)) await walk(join(directory, entry.name))
		}
	}
	await walk(root)
	return found.sort((left, right) => left.localeCompare(right))
}

async function loadFolder(folder: string): Promise<{
	readonly files: readonly File[]
	readonly sourceName: string
	readonly sourceBytes: Uint8Array
	readonly iniBytes: Uint8Array | null
	readonly fileNames: readonly string[]
}> {
	const entries = await readdir(folder, { withFileTypes: true })
	const names = entries.filter(entry => entry.isFile()).map(entry => entry.name)
	const sources = sourceFiles(names)
	if (sources.length !== 1) throw new Error(`Expected exactly one notes.chart or notes.mid; found ${sources.length}`)
	const iniNames = names.filter(name => name.toLowerCase() === 'song.ini')
	if (iniNames.length > 1) throw new Error(`Expected at most one song.ini; found ${iniNames.length}`)
	const sourceName = sources[0]
	const sourceBytes = new Uint8Array(await readFile(join(folder, sourceName)))
	const normalizedSourceName = extname(sourceName).toLowerCase() === '.mid' ? 'notes.mid' : 'notes.chart'
	const files: File[] = [{ fileName: normalizedSourceName, data: sourceBytes }]
	let iniBytes: Uint8Array | null = null
	if (iniNames.length === 1) {
		iniBytes = new Uint8Array(await readFile(join(folder, iniNames[0])))
		files.push({ fileName: 'song.ini', data: iniBytes })
	}
	return { files, sourceName, sourceBytes, iniBytes, fileNames: names }
}

function songMetadata(metadata: ScannedChartMetadata): SongHashMetadata {
	return {
		name: metadata.name ?? null,
		artist: metadata.artist ?? null,
		album: metadata.album ?? null,
		genre: metadata.genre ?? null,
		year: metadata.year ?? null,
		charter: metadata.charter ?? null,
		icon: metadata.icon ?? null,
	}
}

async function writeTrackArtifacts(
	root: string,
	profile: string,
	tracks: readonly {
		readonly instrument: Instrument
		readonly difficulty: Difficulty
		readonly duration: TrackDuration
		readonly identity: {
			readonly physicalBTrack: { readonly bytes: Uint8Array }
			readonly projection: { readonly bytes: Uint8Array }
			readonly digest: { readonly bytes: Uint8Array }
			readonly trackHash: { readonly value: string }
		}
	}[],
	semanticsByKey?: ReadonlyMap<IdentityTrackKey, unknown>,
): Promise<readonly TrackManifest[]> {
	const manifests: TrackManifest[] = []
	for (let index = 0; index < tracks.length; index++) {
		const track = tracks[index]
		const base = `${profile}/tracks/${String(index).padStart(3, '0')}-${track.instrument}-${track.difficulty}`
		const physicalBTrack = await writeArtifact(root, `${base}/physical.btrack`, track.identity.physicalBTrack.bytes)
		const projection = await writeArtifact(root, `${base}/projection.bin`, track.identity.projection.bytes)
		const digest = await writeArtifact(root, `${base}/digest.blake3`, track.identity.digest.bytes)
		const semantics = semanticsByKey?.get(identityTrackKey(track.instrument, track.difficulty))
		const semanticsArtifact = semantics === undefined
			? undefined
			: await writeArtifact(root, `${base}/semantics.json`, json(semantics))
		const trackHashArtifact = await writeArtifact(
			root,
			`${base}/track-hash.txt`,
			new TextEncoder().encode(`${track.identity.trackHash.value}\n`),
		)
		manifests.push({
			instrument: track.instrument,
			difficulty: track.difficulty,
			duration: track.duration,
			trackHash: track.identity.trackHash.value,
			physicalBTrack,
			projection,
			digest,
			trackHashArtifact,
			...(semanticsArtifact ? { semantics: semanticsArtifact } : {}),
		})
	}
	return manifests
}

async function writeSongArtifacts(
	root: string,
	profile: string,
	song: { readonly preimage: Uint8Array; readonly digest: Uint8Array; readonly songHash: { readonly value: string } },
): Promise<{
	readonly preimage: ArtifactReference
	readonly digest: ArtifactReference
	readonly songHash: string
	readonly songHashArtifact: ArtifactReference
}> {
	const preimage = await writeArtifact(root, `${profile}/song/preimage.chsh`, song.preimage)
	const digest = await writeArtifact(root, `${profile}/song/digest.blake3`, song.digest)
	const songHashArtifact = await writeArtifact(
		root,
		`${profile}/song/song-hash.txt`,
		new TextEncoder().encode(`${song.songHash.value}\n`),
	)
	return { preimage, digest, songHash: song.songHash.value, songHashArtifact }
}

async function generateSong(folder: string, inputRoot: string, outputRoot: string, outputRelative: string): Promise<SongFolderSuccess> {
	const loaded = await loadFolder(folder)
	const parsed = parseChartAndIni([...loaded.files])
	if (!parsed.parsedChart) {
		throw new Error(parsed.chartFolderIssues.map(issue => issue.description).join(' ') || 'Chart parser rejected the source')
	}
	const historicalDuration = resolveHistoricalDuration(loaded.iniBytes, loaded.fileNames, parseChartFileFrozenLegacyIdentity(
		parsed.parsedChart.chartBytes, parsed.parsedChart.format, parsed.parsedChart.iniChartModifiers,
	))
	const bundle = songBundle20251010.calculate({
		source: { format: parsed.parsedChart.format, bytes: parsed.parsedChart.chartBytes },
		modifiers: parsed.parsedChart.iniChartModifiers,
		metadata: songMetadata(parsed.parsedChart.metadata),
		...(historicalDuration.kind === 'available' ? { legacyDurationMs: historicalDuration.durationMs } : {}),
	})
	if (bundle.kind === 'rejected') throw new Error(bundle.errors.map(error => error.message).join(' '))

	const songRoot = join(outputRoot, ...outputRelative.split('/'))
	await mkdir(songRoot, { recursive: true })
	const canonicalSemantics = new Map<IdentityTrackKey, unknown>()
	for (const track of bundle.canonical20260801.tracks) {
		const read = canonical20260801.readBTrack(track.identity.physicalBTrack.bytes)
		if (read.kind === 'rejected') throw new Error(`Generated canonical BTrack failed its own reader: ${JSON.stringify(read.errors)}`)
		canonicalSemantics.set(identityTrackKey(track.instrument, track.difficulty), read.semantics)
	}
	const legacyTracks = await writeTrackArtifacts(songRoot, 'frozenLegacy6142', bundle.frozenLegacy6142.tracks)
	const canonicalTracks = await writeTrackArtifacts(songRoot, 'canonical20260801', bundle.canonical20260801.tracks, canonicalSemantics)
	const legacySong = bundle.frozenLegacy6142.song.kind === 'available'
		? {
			kind: 'available' as const,
			...await writeSongArtifacts(songRoot, 'frozenLegacy6142', bundle.frozenLegacy6142.song.identity),
		}
		: bundle.frozenLegacy6142.song
	const canonicalSong = await writeSongArtifacts(songRoot, 'canonical20260801', bundle.canonical20260801.song)
	const manifest = {
		schemaVersion: 3,
		tool: toolProvenance(),
		path: posix(relative(inputRoot, folder)) || '.',
		input: {
			sourceFile: loaded.sourceName,
			sourceBytes: loaded.sourceBytes.byteLength,
			sourceSha256: sha256(loaded.sourceBytes),
			ini: loaded.iniBytes === null ? null : { bytes: loaded.iniBytes.byteLength, sha256: sha256(loaded.iniBytes) },
		},
		duration: {
			songDurationMs: bundle.canonical20260801.duration.durationMs,
			canonical: bundle.canonical20260801.duration,
			frozenLegacy: historicalDuration,
		},
		metadata: songMetadata(parsed.parsedChart.metadata),
		profiles: {
			frozenLegacy6142: { song: legacySong, tracks: legacyTracks },
			canonical20260801: { song: canonicalSong, tracks: canonicalTracks, notices: bundle.canonical20260801.notices },
		},
	}
	const manifestPath = `${outputRelative}/manifest.json`
	await writeArtifact(outputRoot, manifestPath, json(manifest))
	return {
		kind: 'success',
		path: manifest.path,
		manifest: manifestPath,
		legacySongHash: legacySong.kind === 'available' ? legacySong.songHash : null,
		canonicalSongHash: canonicalSong.songHash,
	}
}

export interface GenerateRequest {
	readonly input: string
	readonly output: string
}

export async function generate({ input, output }: GenerateRequest): Promise<GenerateRunResult> {
	const inputRoot = resolve(input)
	const outputDirectory = resolve(output)
	const folders = await discoverSongFolders(inputRoot)
	if (folders.length === 0) throw new Error(`No notes.chart or notes.mid files found under ${inputRoot}`)
	await prepareOutputPath(outputDirectory)
	await mkdir(dirname(outputDirectory), { recursive: true })
	const temporaryRoot = await mkdtemp(join(dirname(outputDirectory), '.ch-identity-'))
	try {
		const results: SongFolderResult[] = []
		for (let index = 0; index < folders.length; index++) {
			const folder = folders[index]
			const rel = posix(relative(inputRoot, folder)) || 'song'
			const outputRelative = folders.length === 1 ? 'song' : `songs/${rel}`
			try {
				results.push(await generateSong(folder, inputRoot, temporaryRoot, outputRelative))
			} catch (error: unknown) {
				await rm(join(temporaryRoot, ...outputRelative.split('/')), { recursive: true, force: true })
				results.push({ kind: 'failure', path: rel, error: errorMessage(error) })
			}
		}
		await writeArtifact(temporaryRoot, 'manifest.json', json({
			schemaVersion: 3,
			tool: toolProvenance(),
			inputKind: folders.length === 1 ? 'song-folder' : 'library-root',
			counts: {
				total: results.length,
				succeeded: results.filter(result => result.kind === 'success').length,
				failed: results.filter(result => result.kind === 'failure').length,
			},
			results,
		}))
		await rename(temporaryRoot, outputDirectory)
		return { outputDirectory, results }
	} catch (error: unknown) {
		await rm(temporaryRoot, { recursive: true, force: true })
		throw error
	}
}

export interface InspectBTrackRequest {
	readonly input: string
	readonly output: string
}

export async function inspectBTrack({ input, output }: InspectBTrackRequest): Promise<void> {
	const outputDirectory = resolve(output)
	const inputPath = resolve(input)
	const bytes = new Uint8Array(await readFile(inputPath))
	const read = canonical20260801.readBTrack(bytes)
	if (read.kind === 'rejected') throw new Error(JSON.stringify(read.errors))
	const duration = canonical20260801.calculateTrackDuration(read.semantics)
	await prepareOutputPath(outputDirectory)
	await mkdir(dirname(outputDirectory), { recursive: true })
	const temporaryRoot = await mkdtemp(join(dirname(outputDirectory), '.ch-identity-inspect-'))
	try {
		const physicalBTrack = await writeArtifact(temporaryRoot, 'physical.btrack', read.identity.physicalBTrack.bytes)
		const projection = await writeArtifact(temporaryRoot, 'projection.bin', read.identity.projection.bytes)
		const digest = await writeArtifact(temporaryRoot, 'digest.blake3', read.identity.digest.bytes)
		const semantics = await writeArtifact(temporaryRoot, 'semantics.json', json(read.semantics))
		const trackHash = await writeArtifact(
			temporaryRoot,
			'track-hash.txt',
			new TextEncoder().encode(`${read.identity.trackHash.value}\n`),
		)
		await writeArtifact(temporaryRoot, 'manifest.json', json({
			schemaVersion: 2,
			tool: toolProvenance(),
			profile: 'canonical20260801',
			input: { path: inputPath, bytes: bytes.byteLength, sha256: sha256(bytes) },
			identity: {
				trackHash: read.identity.trackHash.value,
				duration,
				artifacts: { physicalBTrack, projection, digest, semantics, trackHash },
			},
		}))
		await rename(temporaryRoot, outputDirectory)
	} catch (error: unknown) {
		await rm(temporaryRoot, { recursive: true, force: true })
		throw error
	}
}
