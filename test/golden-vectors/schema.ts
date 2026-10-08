import type { SongHashMetadata } from 'src/chart/identity/song-hash-20251010'
import { IniChartModifiers } from 'src/chart/types'
import { difficulties, Difficulty, instruments, Instrument } from 'src/types'

export interface FixtureFile {
	readonly path: string
	readonly byteLength: number
	readonly sha256: string
}

export interface FixtureProvenance {
	readonly kind: 'authored-minimal'
	readonly author: string
	readonly license: 'MIT'
	readonly purpose: string
}

export interface ExpectedPipeline {
	readonly parsedSemantics: FixtureFile
	readonly diagnostics: FixtureFile
	readonly physicalBTrack: FixtureFile
	readonly projection: FixtureFile
	readonly rawDigest: FixtureFile
	readonly trackHash: string
}

export interface ExpectedLegacyPipeline extends ExpectedPipeline {
	readonly publishedPaddedTrackHash: string
}

export interface SourceAcceptedVector {
	readonly kind: 'source-accepted'
	readonly id: string
	readonly provenance: FixtureProvenance
	readonly sourceFormat: 'chart' | 'mid'
	readonly source: FixtureFile
	readonly modifiers: IniChartModifiers
	readonly target: { readonly instrument: Instrument; readonly difficulty: Difficulty }
	readonly expected: {
		readonly legacy6142: ExpectedLegacyPipeline
		readonly canonical20260801: ExpectedPipeline
	}
}

export interface BTrackAcceptedVector {
	readonly kind: 'btrack-accepted'
	readonly id: string
	readonly provenance: FixtureProvenance
	readonly physicalBTrack: FixtureFile
	readonly expected: {
		readonly parsedSemantics: FixtureFile
		readonly projection: FixtureFile
		readonly rawDigest: FixtureFile
		readonly trackHash: string
	}
}

export interface BTrackRejectedVector {
	readonly kind: 'btrack-rejected'
	readonly id: string
	readonly provenance: FixtureProvenance
	readonly physicalBTrack: FixtureFile
	readonly expectedErrors: FixtureFile
}

export type GoldenVector = SourceAcceptedVector | BTrackAcceptedVector | BTrackRejectedVector

export interface GoldenManifestV1 {
	readonly schemaVersion: 1
	readonly contract: {
		readonly legacy: 'clone-hero-1.1.0.6142'
		readonly physical: 'CHNF/20260801'
		readonly projection: 'ticket-03-map-first'
		readonly parser: 'ticket-05-20260801'
	}
	readonly compatibility: {
		readonly vectorIdsAreImmutable: true
		readonly generatorMayOverwriteApprovedFixtures: false
		readonly canonicalHashEncoding: 'base64url-unpadded'
	}
	readonly vectors: readonly GoldenVector[]
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const allowed = new Set(keys)
	return Object.keys(value).every(key => allowed.has(key)) && keys.every(key => key in value)
}

function isFixtureFile(value: unknown): value is FixtureFile {
	if (!isObject(value) || !hasOnlyKeys(value, ['path', 'byteLength', 'sha256'])) return false
	if (typeof value.path !== 'string' || value.path.length === 0 || value.path.includes('\\')) return false
	if (value.path.startsWith('/') || value.path.split('/').some(part => part === '..' || part === '')) return false
	return Number.isSafeInteger(value.byteLength) && Number(value.byteLength) >= 0 &&
		typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/.test(value.sha256)
}

function isProvenance(value: unknown): value is FixtureProvenance {
	return isObject(value) && hasOnlyKeys(value, ['kind', 'author', 'license', 'purpose']) &&
		value.kind === 'authored-minimal' && typeof value.author === 'string' && value.author.length > 0 &&
		value.license === 'MIT' && typeof value.purpose === 'string' && value.purpose.length > 0
}

function isTrackHash(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
}

function isInstrument(value: unknown): value is Instrument {
	return typeof value === 'string' && instruments.some(instrument => instrument === value)
}

function isDifficulty(value: unknown): value is Difficulty {
	return typeof value === 'string' && difficulties.some(difficulty => difficulty === value)
}

function isExpectedPipeline(value: unknown): value is ExpectedPipeline {
	return isObject(value) && hasOnlyKeys(value, [
		'parsedSemantics', 'diagnostics', 'physicalBTrack', 'projection', 'rawDigest', 'trackHash',
	]) && isFixtureFile(value.parsedSemantics) && isFixtureFile(value.diagnostics) &&
		isFixtureFile(value.physicalBTrack) && isFixtureFile(value.projection) &&
		isFixtureFile(value.rawDigest) && isTrackHash(value.trackHash)
}

function isExpectedLegacyPipeline(value: unknown): value is ExpectedLegacyPipeline {
	if (!isObject(value) || !hasOnlyKeys(value, [
		'parsedSemantics', 'diagnostics', 'physicalBTrack', 'projection', 'rawDigest', 'trackHash', 'publishedPaddedTrackHash',
	])) return false
	const withoutPadded = { ...value }
	delete withoutPadded.publishedPaddedTrackHash
	return isExpectedPipeline(withoutPadded) && typeof value.publishedPaddedTrackHash === 'string' &&
		/^[A-Za-z0-9_-]{43}=$/.test(value.publishedPaddedTrackHash)
}

function isModifiers(value: unknown): value is IniChartModifiers {
	if (!isObject(value) || !hasOnlyKeys(value, [
		'song_length', 'hopo_frequency', 'eighthnote_hopo', 'multiplier_note',
		'sustain_cutoff_threshold', 'chord_snap_threshold', 'five_lane_drums', 'pro_drums',
	])) return false
	return typeof value.song_length === 'number' && typeof value.hopo_frequency === 'number' &&
		typeof value.eighthnote_hopo === 'boolean' && typeof value.multiplier_note === 'number' &&
		typeof value.sustain_cutoff_threshold === 'number' && typeof value.chord_snap_threshold === 'number' &&
		typeof value.five_lane_drums === 'boolean' && typeof value.pro_drums === 'boolean'
}

function isTarget(value: unknown): value is SourceAcceptedVector['target'] {
	return isObject(value) && hasOnlyKeys(value, ['instrument', 'difficulty']) &&
		isInstrument(value.instrument) && isDifficulty(value.difficulty)
}

function assertVector(value: unknown): asserts value is GoldenVector {
	if (!isObject(value) || typeof value.id !== 'string' || value.id.length === 0 || !isProvenance(value.provenance)) {
		throw new Error('Every vector must have a nonempty id and valid provenance')
	}
	if (value.kind === 'source-accepted') {
		if (!hasOnlyKeys(value, ['kind', 'id', 'provenance', 'sourceFormat', 'source', 'modifiers', 'target', 'expected']) ||
			(value.sourceFormat !== 'chart' && value.sourceFormat !== 'mid') || !isFixtureFile(value.source) ||
			!isModifiers(value.modifiers) || !isTarget(value.target) || !isObject(value.expected) ||
			!hasOnlyKeys(value.expected, ['legacy6142', 'canonical20260801']) ||
			!isExpectedLegacyPipeline(value.expected.legacy6142) || !isExpectedPipeline(value.expected.canonical20260801)) {
			throw new Error(`Source vector ${value.id} does not match the schema`)
		}
		return
	}
	if (value.kind === 'btrack-accepted') {
		if (!hasOnlyKeys(value, ['kind', 'id', 'provenance', 'physicalBTrack', 'expected']) ||
			!isFixtureFile(value.physicalBTrack) || !isObject(value.expected) ||
			!hasOnlyKeys(value.expected, ['parsedSemantics', 'projection', 'rawDigest', 'trackHash']) ||
			!isFixtureFile(value.expected.parsedSemantics) || !isFixtureFile(value.expected.projection) ||
			!isFixtureFile(value.expected.rawDigest) || !isTrackHash(value.expected.trackHash)) {
			throw new Error(`Accepted BTrack vector ${value.id} does not match the schema`)
		}
		return
	}
	if (value.kind === 'btrack-rejected') {
		if (!hasOnlyKeys(value, ['kind', 'id', 'provenance', 'physicalBTrack', 'expectedErrors']) ||
			!isFixtureFile(value.physicalBTrack) || !isFixtureFile(value.expectedErrors)) {
			throw new Error(`Rejected BTrack vector ${value.id} does not match the schema`)
		}
		return
	}
	throw new Error(`Vector ${value.id} has an unknown kind`)
}

export function parseManifest(value: unknown): GoldenManifestV1 {
	if (!isObject(value) || !hasOnlyKeys(value, ['schemaVersion', 'contract', 'compatibility', 'vectors']) ||
		value.schemaVersion !== 1 || !isObject(value.contract) ||
		!hasOnlyKeys(value.contract, ['legacy', 'physical', 'projection', 'parser']) ||
		value.contract.legacy !== 'clone-hero-1.1.0.6142' || value.contract.physical !== 'CHNF/20260801' ||
		value.contract.projection !== 'ticket-03-map-first' || value.contract.parser !== 'ticket-05-20260801' ||
		!isObject(value.compatibility) ||
		!hasOnlyKeys(value.compatibility, ['vectorIdsAreImmutable', 'generatorMayOverwriteApprovedFixtures', 'canonicalHashEncoding']) ||
		value.compatibility.vectorIdsAreImmutable !== true || value.compatibility.generatorMayOverwriteApprovedFixtures !== false ||
		value.compatibility.canonicalHashEncoding !== 'base64url-unpadded' || !Array.isArray(value.vectors)) {
		throw new Error('Golden-vector manifest must use schemaVersion 1 and contain a vectors array')
	}
	const ids = new Set<string>()
	const vectors: GoldenVector[] = []
	for (const vector of value.vectors) {
		assertVector(vector)
		if (ids.has(vector.id)) throw new Error(`Duplicate vector id: ${vector.id}`)
		ids.add(vector.id)
		vectors.push(vector)
	}
	return {
		schemaVersion: 1,
		contract: {
			legacy: 'clone-hero-1.1.0.6142',
			physical: 'CHNF/20260801',
			projection: 'ticket-03-map-first',
			parser: 'ticket-05-20260801',
		},
		compatibility: {
			vectorIdsAreImmutable: true,
			generatorMayOverwriteApprovedFixtures: false,
			canonicalHashEncoding: 'base64url-unpadded',
		},
		vectors,
	}
}

/*
 * Schema version 2 (suite v3 onward) describes the canonical `canonical-20260801` profile only. It keeps the
 * physical BTrack vectors of schema version 1, drops the legacy pipeline from source vectors, and adds song vectors,
 * whose input is a song folder and whose output is the canonical SongHash.
 */

export interface ExpectedCanonicalPipeline {
	readonly parsedSemantics: FixtureFile
	readonly diagnostics: FixtureFile
	readonly physicalBTrack: FixtureFile
	readonly projection: FixtureFile
	readonly rawDigest: FixtureFile
	readonly trackHash: string
}

export interface CanonicalSourceAcceptedVector {
	readonly kind: 'source-accepted'
	readonly id: string
	readonly provenance: FixtureProvenance
	readonly sourceFormat: 'chart' | 'mid'
	readonly source: FixtureFile
	readonly modifiers: IniChartModifiers
	readonly target: { readonly instrument: Instrument; readonly difficulty: Difficulty }
	readonly expected: ExpectedCanonicalPipeline
}

/** A file in a song folder, by its name in the folder. */
export interface SongInputFile {
	readonly name: string
	readonly file: FixtureFile
}

export interface ExpectedSongMember {
	readonly instrument: Instrument
	readonly difficulty: Difficulty
	readonly parsedSemantics: FixtureFile
	readonly physicalBTrack: FixtureFile
	readonly projection: FixtureFile
	readonly rawDigest: FixtureFile
	readonly trackHash: string
	/** Decimal strings: the Track's latest note end tick and its duration at song speed 1.0. */
	readonly trackDuration: { readonly lastNoteEndTick: string; readonly durationMs: string }
}

export type ResolvedSongHashMetadata = { readonly [K in keyof SongHashMetadata]: string }

export interface SongAcceptedVector {
	readonly kind: 'song-accepted'
	readonly id: string
	readonly provenance: FixtureProvenance
	readonly files: readonly SongInputFile[]
	readonly expected: {
		/** The name of the notes file the folder is parsed from. */
		readonly selectedSource: string
		/** The chart modifiers read from the folder's song.ini, or the defaults. */
		readonly modifiers: IniChartModifiers
		readonly metadata: {
			/** The metadata held on the song before the SongHash writer resolves it. */
			readonly selected: SongHashMetadata
			/** The metadata written into the SongHash preimage. */
			readonly resolved: ResolvedSongHashMetadata
		}
		readonly diagnostics: FixtureFile
		/** Decimal strings: the canonical song duration at song speed 1.0. */
		readonly songDuration: { readonly contentLastTick: string; readonly endTick: string; readonly durationMs: string }
		/** The SongHash members in SongHash order. */
		readonly members: readonly ExpectedSongMember[]
		readonly preimage: FixtureFile
		readonly rawDigest: FixtureFile
		readonly songHash: string
	}
}

export type GoldenVectorV2 = CanonicalSourceAcceptedVector | SongAcceptedVector | BTrackAcceptedVector | BTrackRejectedVector

export interface GoldenManifestV2 {
	readonly schemaVersion: 2
	readonly contract: {
		readonly profile: 'canonical-20260801'
		readonly physical: 'CHNF/20260801'
		readonly projection: 'ticket-03-map-first'
		readonly songHash: 'CHSH/20260801'
	}
	readonly compatibility: GoldenManifestV1['compatibility']
	readonly vectors: readonly GoldenVectorV2[]
}

export type GoldenManifest = GoldenManifestV1 | GoldenManifestV2

function isDecimal(value: unknown): value is string {
	return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)
}

function isSongHashMetadata(value: unknown, nullable: boolean): boolean {
	const fields = ['name', 'artist', 'album', 'genre', 'year', 'charter', 'icon']
	return isObject(value) && hasOnlyKeys(value, fields) &&
		fields.every(field => typeof value[field] === 'string' || (nullable && value[field] === null))
}

function isSongInputFile(value: unknown): value is SongInputFile {
	return isObject(value) && hasOnlyKeys(value, ['name', 'file']) && typeof value.name === 'string' &&
		/^[^/\\]+$/.test(value.name) && value.name !== '.' && value.name !== '..' && isFixtureFile(value.file)
}

function isSongMember(value: unknown): value is ExpectedSongMember {
	return isObject(value) && hasOnlyKeys(value, [
		'instrument', 'difficulty', 'parsedSemantics', 'physicalBTrack', 'projection', 'rawDigest', 'trackHash', 'trackDuration',
	]) && isInstrument(value.instrument) && isDifficulty(value.difficulty) && isFixtureFile(value.parsedSemantics) &&
		isFixtureFile(value.physicalBTrack) && isFixtureFile(value.projection) && isFixtureFile(value.rawDigest) &&
		isTrackHash(value.trackHash) && isObject(value.trackDuration) &&
		hasOnlyKeys(value.trackDuration, ['lastNoteEndTick', 'durationMs']) &&
		isDecimal(value.trackDuration.lastNoteEndTick) && isDecimal(value.trackDuration.durationMs)
}

function isSongExpectation(value: unknown): value is SongAcceptedVector['expected'] {
	if (!isObject(value) || !hasOnlyKeys(value, [
		'selectedSource', 'modifiers', 'metadata', 'diagnostics', 'songDuration', 'members', 'preimage', 'rawDigest', 'songHash',
	])) return false
	const { metadata, songDuration, members } = value
	return typeof value.selectedSource === 'string' && isModifiers(value.modifiers) &&
		isObject(metadata) && hasOnlyKeys(metadata, ['selected', 'resolved']) &&
		isSongHashMetadata(metadata.selected, true) && isSongHashMetadata(metadata.resolved, false) &&
		isFixtureFile(value.diagnostics) && isObject(songDuration) &&
		hasOnlyKeys(songDuration, ['contentLastTick', 'endTick', 'durationMs']) &&
		isDecimal(songDuration.contentLastTick) && isDecimal(songDuration.endTick) && isDecimal(songDuration.durationMs) &&
		Array.isArray(members) && members.every(isSongMember) &&
		isFixtureFile(value.preimage) && isFixtureFile(value.rawDigest) && isTrackHash(value.songHash)
}

function assertVectorV2(value: unknown): asserts value is GoldenVectorV2 {
	if (!isObject(value) || typeof value.id !== 'string' || value.id.length === 0 || !isProvenance(value.provenance)) {
		throw new Error('Every vector must have a nonempty id and valid provenance')
	}
	if (value.kind === 'source-accepted') {
		if (!hasOnlyKeys(value, ['kind', 'id', 'provenance', 'sourceFormat', 'source', 'modifiers', 'target', 'expected']) ||
			(value.sourceFormat !== 'chart' && value.sourceFormat !== 'mid') || !isFixtureFile(value.source) ||
			!isModifiers(value.modifiers) || !isTarget(value.target) || !isExpectedPipeline(value.expected)) {
			throw new Error(`Source vector ${value.id} does not match the schema`)
		}
		return
	}
	if (value.kind === 'song-accepted') {
		if (!hasOnlyKeys(value, ['kind', 'id', 'provenance', 'files', 'expected']) || !Array.isArray(value.files) ||
			value.files.length === 0 || !value.files.every(isSongInputFile) ||
			new Set(value.files.map(file => file.name)).size !== value.files.length || !isSongExpectation(value.expected)) {
			throw new Error(`Song vector ${value.id} does not match the schema`)
		}
		const selected = value.expected.selectedSource
		if (!value.files.some(file => file.name === selected)) {
			throw new Error(`Song vector ${value.id} selects a source that is not one of its files`)
		}
		return
	}
	if (value.kind === 'btrack-accepted' || value.kind === 'btrack-rejected') {
		assertVector(value)
		return
	}
	throw new Error(`Vector ${value.id} has an unknown kind`)
}

export function parseManifestV2(value: unknown): GoldenManifestV2 {
	if (!isObject(value) || !hasOnlyKeys(value, ['schemaVersion', 'contract', 'compatibility', 'vectors']) ||
		value.schemaVersion !== 2 || !isObject(value.contract) ||
		!hasOnlyKeys(value.contract, ['profile', 'physical', 'projection', 'songHash']) ||
		value.contract.profile !== 'canonical-20260801' || value.contract.physical !== 'CHNF/20260801' ||
		value.contract.projection !== 'ticket-03-map-first' || value.contract.songHash !== 'CHSH/20260801' ||
		!isObject(value.compatibility) ||
		!hasOnlyKeys(value.compatibility, ['vectorIdsAreImmutable', 'generatorMayOverwriteApprovedFixtures', 'canonicalHashEncoding']) ||
		value.compatibility.vectorIdsAreImmutable !== true || value.compatibility.generatorMayOverwriteApprovedFixtures !== false ||
		value.compatibility.canonicalHashEncoding !== 'base64url-unpadded' || !Array.isArray(value.vectors)) {
		throw new Error('Golden-vector manifest must use schemaVersion 2 and contain a vectors array')
	}
	const ids = new Set<string>()
	const vectors: GoldenVectorV2[] = []
	for (const vector of value.vectors) {
		assertVectorV2(vector)
		if (ids.has(vector.id)) throw new Error(`Duplicate vector id: ${vector.id}`)
		ids.add(vector.id)
		vectors.push(vector)
	}
	return {
		schemaVersion: 2,
		contract: {
			profile: 'canonical-20260801',
			physical: 'CHNF/20260801',
			projection: 'ticket-03-map-first',
			songHash: 'CHSH/20260801',
		},
		compatibility: {
			vectorIdsAreImmutable: true,
			generatorMayOverwriteApprovedFixtures: false,
			canonicalHashEncoding: 'base64url-unpadded',
		},
		vectors,
	}
}

/** Parses a manifest of either schema version. Suites v1 and v2 use schema version 1; suite v3 uses version 2. */
export function readManifest(value: unknown): GoldenManifest {
	if (isObject(value) && value.schemaVersion === 1) return parseManifest(value)
	if (isObject(value) && value.schemaVersion === 2) return parseManifestV2(value)
	throw new Error('Golden-vector manifest has an unsupported schemaVersion')
}
