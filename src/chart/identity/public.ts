import { blake3 } from '@awasm/noble'

import { Difficulty, Instrument } from '../../types'
import { IniChartModifiers } from '../types'
import { parseChartFile, ParsedChartFile } from '../parse-chart-file'
import { calculateTrackHash } from '../track-hasher'
import {
	CanonicalBTrackReadOutcome,
	CanonicalTrackIdentity,
	identifyCanonicalTrack,
	readBTrack20260801,
} from './btrack-20260801'
import {
	CanonicalParsedTrack,
	CanonicalParseOutcome,
	parseCanonicalSource,
} from './canonical-source'

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
	calculateTrackIdentity(
		chart: FrozenLegacyParsedChart,
		instrument: Instrument,
		difficulty: Difficulty,
	): FrozenLegacyTrackIdentity
}

export interface Canonical20260801Api {
	parseSource(request: SourceParseRequest): CanonicalParseOutcome
	calculateTrackIdentity(track: CanonicalParsedTrack): CanonicalTrackIdentity
	readBTrack(bytes: Uint8Array): CanonicalBTrackReadOutcome
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
	calculateTrackIdentity: calculateFrozenLegacyTrackIdentity,
}

export const canonical20260801: Canonical20260801Api = {
	parseSource: parseCanonicalSource,
	calculateTrackIdentity: track => identifyCanonicalTrack(track.semantics),
	readBTrack: readBTrack20260801,
}
