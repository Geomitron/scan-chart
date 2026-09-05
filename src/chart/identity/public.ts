import { blake3 } from '@awasm/noble'

import { Difficulty, Instrument } from '../../types'
import { IniChartModifiers } from '../types'
import { parseChartFile, ParsedChartFile } from '../parse-chart-file'
import { calculateTrackHash } from '../track-hasher'
import {
	calculateCanonicalTrackDuration,
	calculateParsedTrackDuration,
} from '../chart-duration'
import type { TrackDuration } from '../chart-duration'
import {
	CanonicalBTrackReadOutcome,
	CanonicalTrackSemantics,
	CanonicalTrackIdentity,
	identifyCanonicalTrack,
	readBTrack20260801,
} from './btrack-20260801'
import {
	CanonicalParsedTrack,
	CanonicalParsedChart,
	CanonicalParseOutcome,
	CanonicalSourceNotice,
	parseCanonicalSource,
} from './canonical-source'
import {
	CanonicalSongIdentity,
	CanonicalSongHashMember,
	identifyCanonicalSong,
	identifyLegacySong,
	canonicalSongHashDifficultyOrder,
	canonicalSongHashInstrumentOrder,
	legacySongHashDifficultyOrder,
	legacySongHashInstrumentOrder,
	LegacySongHashMember,
	LegacySongIdentity,
	SongHashMetadata,
} from './song-hash-20251010'
import {
	CanonicalChartDurationMs,
	HistoricalSongHashDurationMs,
} from './duration-types'
import { identityTrackKey } from './track-key'

const frozenLegacyChartToken: unique symbol = Symbol('frozenLegacyChart')
const legacyPhysicalToken: unique symbol = Symbol('legacyPhysicalBTrack')
const legacyProjectionToken: unique symbol = Symbol('legacyTrackHashProjection')
const legacyDigestToken: unique symbol = Symbol('legacyBlake3Digest')
const legacyTrackHashToken: unique symbol = Symbol('legacyTrackHash')

export type ChartSource =
	| { readonly format: 'chart'; readonly bytes: Uint8Array }
	| { readonly format: 'mid'; readonly bytes: Uint8Array }

export interface SourceParseRequest {
	readonly source: ChartSource
	readonly modifiers: IniChartModifiers
}

export interface SourceParseError {
	readonly code: 'sourceParseFailed'
	readonly message: string
}

export interface FrozenLegacyParsedChart {
	readonly profile: 'clone-hero-1.1.0.6142'
	readonly [frozenLegacyChartToken]: ParsedChartFile
}

export type FrozenLegacyParseOutcome =
	| {
		readonly kind: 'accepted'
		readonly chart: FrozenLegacyParsedChart
	}
	| {
		readonly kind: 'rejected'
		readonly errors: readonly [SourceParseError, ...SourceParseError[]]
	}

export interface LegacyPhysicalBTrack {
	readonly kind: 'legacy-contiguous-btrack'
	readonly profile: 'clone-hero-1.1.0.6142'
	readonly physicalVersion: 20240320
	readonly bytes: Uint8Array
	readonly [legacyPhysicalToken]: true
}

export interface LegacyTrackHashProjection {
	readonly kind: 'legacy-whole-file'
	readonly profile: 'clone-hero-1.1.0.6142'
	readonly bytes: Uint8Array
	readonly [legacyProjectionToken]: true
}

export interface LegacyBlake3Digest {
	readonly algorithm: 'blake3-256'
	readonly bytes: Uint8Array
	readonly [legacyDigestToken]: true
}

export interface LegacyTrackHash {
	readonly encoding: 'base64url-unpadded'
	readonly value: string
	readonly [legacyTrackHashToken]: true
}

export interface FrozenLegacyTrackIdentity {
	readonly profile: 'clone-hero-1.1.0.6142'
	readonly physicalBTrack: LegacyPhysicalBTrack
	readonly projection: LegacyTrackHashProjection
	readonly digest: LegacyBlake3Digest
	readonly trackHash: LegacyTrackHash
}

export interface FrozenLegacy6142Api {
	parseSource(request: SourceParseRequest): FrozenLegacyParseOutcome
	calculateTrackDuration(
		chart: FrozenLegacyParsedChart,
		instrument: Instrument,
		difficulty: Difficulty,
	): TrackDuration
	calculateTrackIdentity(
		chart: FrozenLegacyParsedChart,
		instrument: Instrument,
		difficulty: Difficulty,
	): FrozenLegacyTrackIdentity
	calculateSongIdentity(
		metadata: SongHashMetadata,
		durationMs: HistoricalSongHashDurationMs,
		members: readonly LegacySongHashMember[],
	): LegacySongIdentity
}

export interface Canonical20260801Api {
	parseSource(request: SourceParseRequest): CanonicalParseOutcome
	calculateTrackDuration(semantics: CanonicalTrackSemantics): TrackDuration
	calculateTrackIdentity(track: CanonicalParsedTrack): CanonicalTrackIdentity
	calculateSongIdentity(
		metadata: SongHashMetadata,
		durationMs: CanonicalChartDurationMs,
		members: readonly CanonicalSongHashMember[],
	): CanonicalSongIdentity
	readBTrack(bytes: Uint8Array): CanonicalBTrackReadOutcome
}

export interface SongBundleIdentityRequest extends SourceParseRequest {
	readonly metadata: SongHashMetadata
	readonly legacyDurationMs?: HistoricalSongHashDurationMs
}

export type FrozenLegacySongBundleIdentity =
	| { readonly kind: 'available'; readonly identity: LegacySongIdentity }
	| { readonly kind: 'unavailable'; readonly reason: 'historicalDurationUnavailable' }

export interface LegacyBundleTrackIdentity {
	readonly instrument: Exclude<Instrument, 'keysghl'>
	readonly difficulty: Difficulty
	readonly duration: TrackDuration
	readonly identity: FrozenLegacyTrackIdentity
}

export interface CanonicalBundleTrackIdentity {
	readonly instrument: Instrument
	readonly difficulty: Difficulty
	readonly duration: TrackDuration
	readonly identity: CanonicalTrackIdentity
}

export type SongBundleIdentityOutcome =
	| {
		readonly kind: 'accepted'
		readonly frozenLegacy6142: {
			readonly tracks: readonly LegacyBundleTrackIdentity[]
			readonly song: FrozenLegacySongBundleIdentity
		}
		readonly canonical20260801: {
			readonly tracks: readonly CanonicalBundleTrackIdentity[]
			readonly song: CanonicalSongIdentity
			readonly duration: CanonicalParsedChart['duration']
			readonly notices: readonly CanonicalSourceNotice[]
		}
	}
	| {
		readonly kind: 'rejected'
		readonly errors: readonly [SourceParseError, ...SourceParseError[]]
	}

export interface SongBundle20251010Api {
	calculate(request: SongBundleIdentityRequest): SongBundleIdentityOutcome
}

function copyBytes(source: Uint8Array): () => Uint8Array {
	const owned = source.slice()
	return () => owned.slice()
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function parseFrozenLegacySource(request: SourceParseRequest): FrozenLegacyParseOutcome {
	try {
		const parsed = parseChartFile(request.source.bytes.slice(), request.source.format, request.modifiers)
		return {
			kind: 'accepted',
			chart: {
				profile: 'clone-hero-1.1.0.6142',
				[frozenLegacyChartToken]: parsed,
			},
		}
	} catch (error: unknown) {
		return {
			kind: 'rejected',
			errors: [{ code: 'sourceParseFailed', message: describeError(error) }],
		}
	}
}

function calculateFrozenLegacyTrackIdentity(
	chart: FrozenLegacyParsedChart,
	instrument: Instrument,
	difficulty: Difficulty,
): FrozenLegacyTrackIdentity {
	const current = calculateTrackHash(chart[frozenLegacyChartToken], instrument, difficulty)
	const physicalBytes = copyBytes(current.btrack)
	const projectionBytes = copyBytes(current.btrack)
	const digestBytes = copyBytes(blake3(current.btrack))

	return {
		profile: 'clone-hero-1.1.0.6142',
		physicalBTrack: {
			kind: 'legacy-contiguous-btrack',
			profile: 'clone-hero-1.1.0.6142',
			physicalVersion: 20240320,
			get bytes() { return physicalBytes() },
			[legacyPhysicalToken]: true,
		},
		projection: {
			kind: 'legacy-whole-file',
			profile: 'clone-hero-1.1.0.6142',
			get bytes() { return projectionBytes() },
			[legacyProjectionToken]: true,
		},
		digest: {
			algorithm: 'blake3-256',
			get bytes() { return digestBytes() },
			[legacyDigestToken]: true,
		},
		trackHash: {
			encoding: 'base64url-unpadded',
			value: current.hash,
			[legacyTrackHashToken]: true,
		},
	}
}

export const frozenLegacy6142: FrozenLegacy6142Api = {
	parseSource: parseFrozenLegacySource,
	calculateTrackDuration: (chart, instrument, difficulty) =>
		calculateParsedTrackDuration(chart[frozenLegacyChartToken], instrument, difficulty),
	calculateTrackIdentity: calculateFrozenLegacyTrackIdentity,
	calculateSongIdentity: identifyLegacySong,
}

export const canonical20260801: Canonical20260801Api = {
	parseSource: parseCanonicalSource,
	calculateTrackDuration: calculateCanonicalTrackDuration,
	calculateTrackIdentity: track => identifyCanonicalTrack(track.semantics),
	calculateSongIdentity: identifyCanonicalSong,
	readBTrack: readBTrack20260801,
}

function calculateSongBundleIdentity(request: SongBundleIdentityRequest): SongBundleIdentityOutcome {
	const legacyParsed = parseFrozenLegacySource(request)
	if (legacyParsed.kind === 'rejected') return legacyParsed
	const canonicalParsed = parseCanonicalSource(request)
	if (canonicalParsed.kind === 'rejected') return canonicalParsed

	const legacySourceKeys = new Set(legacyParsed.chart[frozenLegacyChartToken].trackData
		.map(track => identityTrackKey(track.instrument, track.difficulty)))
	const legacyTracks: LegacyBundleTrackIdentity[] = []
	const legacyMembers: LegacySongHashMember[] = []
	for (const instrument of legacySongHashInstrumentOrder) {
		for (const difficulty of legacySongHashDifficultyOrder) {
			if (!legacySourceKeys.has(identityTrackKey(instrument, difficulty))) continue
			const identity = calculateFrozenLegacyTrackIdentity(legacyParsed.chart, instrument, difficulty)
			const duration = calculateParsedTrackDuration(
				legacyParsed.chart[frozenLegacyChartToken],
				instrument,
				difficulty,
			)
			legacyTracks.push({ instrument, difficulty, duration, identity })
			legacyMembers.push({ instrument, difficulty, digest: identity.digest })
		}
	}

	const canonicalTracksByKey = new Map(canonicalParsed.chart.tracks
		.map(track => [identityTrackKey(track.key.instrument, track.key.difficulty), track]))
	const canonicalTracks: CanonicalBundleTrackIdentity[] = []
	const canonicalMembers: CanonicalSongHashMember[] = []
	for (const instrument of canonicalSongHashInstrumentOrder) {
		for (const difficulty of canonicalSongHashDifficultyOrder) {
			const track = canonicalTracksByKey.get(identityTrackKey(instrument, difficulty))
			if (!track) continue
			const identity = identifyCanonicalTrack(track.semantics)
			const duration = calculateCanonicalTrackDuration(track.semantics)
			canonicalTracks.push({ instrument, difficulty, duration, identity })
			canonicalMembers.push({ instrument, difficulty, digest: identity.digest })
		}
	}

	return {
		kind: 'accepted',
		frozenLegacy6142: {
			tracks: legacyTracks,
			song: request.legacyDurationMs === undefined
				? { kind: 'unavailable', reason: 'historicalDurationUnavailable' }
				: {
					kind: 'available',
					identity: identifyLegacySong(request.metadata, request.legacyDurationMs, legacyMembers),
				},
		},
		canonical20260801: {
			tracks: canonicalTracks,
			song: identifyCanonicalSong(request.metadata, canonicalParsed.chart.duration.durationMs, canonicalMembers),
			duration: canonicalParsed.chart.duration,
			notices: canonicalParsed.notices,
		},
	}
}

export const songBundle20251010: SongBundle20251010Api = {
	calculate: calculateSongBundleIdentity,
}
