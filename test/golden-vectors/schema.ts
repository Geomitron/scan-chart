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
