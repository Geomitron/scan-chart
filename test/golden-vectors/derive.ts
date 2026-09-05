import { base64url } from 'rfc4648'

import { CanonicalTrackIdentity, CanonicalTrackSemantics } from 'src/chart/identity/btrack-20260801'
import { canonical20260801, frozenLegacy6142, FrozenLegacyTrackIdentity } from 'src/chart/identity/public'
import { parseChartFile } from 'src/chart/parse-chart-file'
import { pruneEmptyPhrases } from 'src/chart/track-hasher'
import { IniChartModifiers } from 'src/chart/types'
import { Difficulty, Instrument } from 'src/types'

import { AuthoredSourceCase, resolvedModifiers } from './cases'

export function normalize(value: unknown): unknown {
	if (typeof value === 'bigint') return value.toString(10)
	if (value instanceof Uint8Array) return Buffer.from(value).toString('hex')
	if (Array.isArray(value)) return value.map(normalize)
	if (typeof value === 'object' && value !== null) {
		return Object.fromEntries(Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => [key, normalize(entry)]))
	}
	return value
}

export function stableJson(value: unknown): Uint8Array {
	return new TextEncoder().encode(`${JSON.stringify(normalize(value), null, 2)}\n`)
}

function identitySemantics(
	parsed: ReturnType<typeof parseChartFile>,
	instrument: Instrument,
	difficulty: Difficulty,
): unknown {
	const track = parsed.trackData.find(candidate => candidate.instrument === instrument && candidate.difficulty === difficulty)
	if (!track) throw new Error(`Legacy target ${instrument}/${difficulty} was not parsed`)
	return {
		resolution: parsed.resolution,
		tempos: parsed.tempos.map(({ tick, beatsPerMinute }) => ({ tick, beatsPerMinute })),
		timeSignatures: parsed.timeSignatures.map(({ tick, numerator, denominator }) => ({ tick, numerator, denominator })),
		starPower: pruneEmptyPhrases(track.starPowerSections, track.noteEventGroups).map(({ tick, length }) => ({ tick, length })),
		solos: pruneEmptyPhrases(track.soloSections, track.noteEventGroups).map(({ tick, length }) => ({ tick, length })),
		flexLanes: pruneEmptyPhrases(track.flexLanes, track.noteEventGroups).map(({ tick, length, isDouble }) => ({ tick, length, isDouble })),
		drumFreestyle: track.drumFreestyleSections.map(({ tick, length, isCoda }) => ({ tick, length, isCoda })),
		notes: track.noteEventGroups.flat().map(({ tick, length, type, flags }) => ({ tick, length, type, flags })),
	}
}

export interface DerivedPipeline {
	readonly semantics: unknown
	readonly diagnostics: unknown
	readonly physical: Uint8Array
	readonly projection: Uint8Array
	readonly digest: Uint8Array
	readonly trackHash: string
}

export interface DerivedLegacyPipeline extends DerivedPipeline {
	readonly publishedPaddedTrackHash: string
}

function legacyPipeline(identity: FrozenLegacyTrackIdentity, semantics: unknown): DerivedLegacyPipeline {
	return {
		semantics,
		diagnostics: [],
		physical: identity.physicalBTrack.bytes,
		projection: identity.projection.bytes,
		digest: identity.digest.bytes,
		trackHash: identity.trackHash.value,
		publishedPaddedTrackHash: base64url.stringify(identity.digest.bytes, { pad: true }),
	}
}

export function canonicalPipeline(identity: CanonicalTrackIdentity, semantics: CanonicalTrackSemantics, diagnostics: unknown = []): DerivedPipeline {
	return {
		semantics,
		diagnostics,
		physical: identity.physicalBTrack.bytes,
		projection: identity.projection.bytes,
		digest: identity.digest.bytes,
		trackHash: identity.trackHash.value,
	}
}

export function deriveSourceCase(sourceCase: AuthoredSourceCase, modifiers: IniChartModifiers = resolvedModifiers): {
	readonly legacy: DerivedLegacyPipeline
	readonly canonical: DerivedPipeline
} {
	const request = {
		source: { format: sourceCase.format, bytes: sourceCase.bytes },
		modifiers,
	} as const
	const legacyParsed = frozenLegacy6142.parseSource(request)
	if (legacyParsed.kind !== 'accepted') throw new Error(`${sourceCase.id}: frozen legacy parser rejected the source`)
	const legacyIdentity = frozenLegacy6142.calculateTrackIdentity({
		chart: legacyParsed.chart,
		instrument: sourceCase.target.instrument,
		difficulty: sourceCase.target.difficulty,
	})
	const legacySemantics = identitySemantics(
		parseChartFile(sourceCase.bytes.slice(), sourceCase.format, modifiers),
		sourceCase.target.instrument,
		sourceCase.target.difficulty,
	)

	const canonicalParsed = canonical20260801.parseSource(request)
	if (canonicalParsed.kind !== 'accepted') throw new Error(`${sourceCase.id}: canonical parser rejected the source`)
	const canonicalTrack = canonicalParsed.chart.tracks.find(track =>
		track.key.instrument === sourceCase.target.instrument && track.key.difficulty === sourceCase.target.difficulty)
	if (!canonicalTrack) throw new Error(`${sourceCase.id}: canonical target was not parsed`)
	const canonicalIdentity = canonical20260801.calculateTrackIdentity(canonicalTrack)

	return {
		legacy: legacyPipeline(legacyIdentity, legacySemantics),
		canonical: canonicalPipeline(canonicalIdentity, canonicalTrack.semantics, canonicalParsed.notices),
	}
}
