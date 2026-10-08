import { blake3 } from '@awasm/noble'
import { base64url } from 'rfc4648'

import type { Difficulty, Instrument } from '../../types'
import { removeStyleTags } from '../../shared/text'
import { CanonicalChartDurationMs, HistoricalSongHashDurationMs } from './duration-types'
import type { CanonicalBlake3Digest } from './btrack-20260801'
import type { LegacyBlake3Digest } from './public'

const MAGIC = new Uint8Array([0x43, 0x48, 0x53, 0x48])
const VERSION = 20251010
const MIN_INT64 = BigInt('-9223372036854775808')
const MAX_INT64 = BigInt('9223372036854775807')

const legacySongHashToken: unique symbol = Symbol('legacySongHash')
const canonicalSongHashToken: unique symbol = Symbol('canonicalSongHash')

export interface SongHashMetadata {
	readonly name: string | null
	readonly artist: string | null
	readonly album: string | null
	readonly genre: string | null
	readonly year: string | null
	readonly charter: string | null
	readonly icon: string | null
}

export interface LegacySongHashMember {
	readonly instrument: Exclude<Instrument, 'keysghl'>
	readonly difficulty: Difficulty
	readonly digest: LegacyBlake3Digest
}

export interface CanonicalSongHashMember {
	readonly instrument: Instrument
	readonly difficulty: Difficulty
	readonly digest: CanonicalBlake3Digest
}

export interface LegacySongIdentityRequest {
	readonly metadata: SongHashMetadata
	readonly durationMs: HistoricalSongHashDurationMs
	readonly members: readonly LegacySongHashMember[]
}

export interface CanonicalSongIdentityRequest {
	/**
	 * The song's metadata before the canonical writer resolves it, as Clone Hero holds it on the song. The writer
	 * treats `null`, "0", and "-1" as unset, strips style tags, lowercases the icon, and clears an icon that equals
	 * the charter. Use `ParsedChart.songHashMetadata` for a chart folder.
	 */
	readonly metadata: SongHashMetadata
	readonly durationMs: CanonicalChartDurationMs
	readonly members: readonly CanonicalSongHashMember[]
}

export interface LegacySongHash {
	readonly profile: 'clone-hero-1.1.0.6142'
	readonly encoding: 'base64url-unpadded'
	readonly value: string
	readonly [legacySongHashToken]: true
}

export interface CanonicalSongHash {
	readonly profile: 'canonical-20260801'
	readonly encoding: 'base64url-unpadded'
	readonly value: string
	readonly [canonicalSongHashToken]: true
}

export interface LegacySongIdentity {
	readonly profile: 'clone-hero-1.1.0.6142'
	readonly metadata: SongHashMetadata
	readonly durationMs: HistoricalSongHashDurationMs
	readonly members: readonly LegacySongHashMember[]
	readonly preimage: Uint8Array
	readonly digest: Uint8Array
	readonly songHash: LegacySongHash
}

export interface CanonicalSongIdentity {
	readonly profile: 'canonical-20260801'
	/** The resolved metadata written into the SongHash. */
	readonly metadata: SongHashMetadata
	readonly durationMs: CanonicalChartDurationMs
	readonly members: readonly CanonicalSongHashMember[]
	readonly preimage: Uint8Array
	readonly digest: Uint8Array
	readonly songHash: CanonicalSongHash
}

interface WireMember {
	readonly instrumentId: number
	readonly difficultyId: number
	readonly digest: Uint8Array
}

interface SerializeSongHashRequest {
	readonly metadata: SongHashMetadata
	readonly durationMs: bigint
	readonly members: readonly WireMember[]
}

const metadataDefaults: { readonly [K in keyof SongHashMetadata]: string } = {
	name: 'Unknown Name',
	artist: 'Unknown Artist',
	album: 'Unknown Album',
	genre: 'Unknown Genre',
	year: 'Unknown Year',
	charter: 'Unknown Charter',
	icon: '',
}

const legacyInstrumentIds = {
	guitar: 0,
	guitarcoop: 1,
	rhythm: 2,
	bass: 3,
	drums: 4,
	keys: 5,
	guitarghl: 6,
	guitarcoopghl: 7,
	rhythmghl: 8,
	bassghl: 9,
} satisfies Record<Exclude<Instrument, 'keysghl'>, number>

const canonicalInstrumentIds = {
	...legacyInstrumentIds,
	keysghl: 10,
} satisfies Record<Instrument, number>

const legacyDifficultyIds = {
	expert: 0,
	hard: 1,
	medium: 2,
	easy: 3,
} satisfies Record<Difficulty, number>

const canonicalDifficultyIds = {
	easy: 0,
	medium: 1,
	hard: 2,
	expert: 3,
} satisfies Record<Difficulty, number>

function keysById<Key extends string>(ids: Readonly<Record<Key, number>>): readonly Key[] {
	const entries: [Key, number][] = []
	for (const key in ids) entries.push([key, ids[key]])
	entries.sort((left, right) => left[1] - right[1])
	return Object.freeze(entries.map(([key]) => key))
}

export const legacySongHashInstrumentOrder = keysById(legacyInstrumentIds)
export const canonicalSongHashInstrumentOrder = keysById(canonicalInstrumentIds)
export const legacySongHashDifficultyOrder = keysById(legacyDifficultyIds)
export const canonicalSongHashDifficultyOrder = keysById(canonicalDifficultyIds)

function canonicalInstrumentId(instrument: Instrument): number {
	return canonicalInstrumentIds[instrument]
}

function legacyInstrumentId(instrument: Exclude<Instrument, 'keysghl'>): number {
	return legacyInstrumentIds[instrument]
}

function uint32(value: number): Uint8Array {
	const bytes = new Uint8Array(4)
	new DataView(bytes.buffer).setUint32(0, value, true)
	return bytes
}

function int32(value: number): Uint8Array {
	const bytes = new Uint8Array(4)
	new DataView(bytes.buffer).setInt32(0, value, true)
	return bytes
}

function int64(value: bigint): Uint8Array {
	const bytes = new Uint8Array(8)
	new DataView(bytes.buffer).setBigInt64(0, value, true)
	return bytes
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
	const length = parts.reduce((total, part) => total + part.byteLength, 0)
	const bytes = new Uint8Array(length)
	let offset = 0
	for (const part of parts) {
		bytes.set(part, offset)
		offset += part.byteLength
	}
	return bytes
}

function framedString(value: string): Uint8Array {
	const bytes = new TextEncoder().encode(value)
	if (bytes.byteLength > 0x7fffffff) throw new RangeError('SongHash metadata string exceeds signed int32 byte length')
	return concatenate([int32(bytes.byteLength), bytes])
}

function resolvedMetadata(metadata: SongHashMetadata): { readonly [K in keyof SongHashMetadata]: string } {
	return {
		name: metadata.name ?? metadataDefaults.name,
		artist: metadata.artist ?? metadataDefaults.artist,
		album: metadata.album ?? metadataDefaults.album,
		genre: metadata.genre ?? metadataDefaults.genre,
		year: metadata.year ?? metadataDefaults.year,
		charter: metadata.charter ?? metadataDefaults.charter,
		icon: metadata.icon ?? metadataDefaults.icon,
	}
}

/** Mirrors `BinarySongWriter.Resolve` and its icon rule in Clone Hero's canonical SongHash writer. */
function resolveCanonicalMetadata(metadata: SongHashMetadata): { readonly [K in keyof SongHashMetadata]: string } {
	const resolve = (field: keyof SongHashMetadata) => {
		const value = metadata[field]
		return removeStyleTags(value === null || value === '0' || value === '-1' ? metadataDefaults[field] : value)
	}
	const charter = resolve('charter')
	const icon = resolve('icon').toLowerCase()
	return {
		name: resolve('name'),
		artist: resolve('artist'),
		album: resolve('album'),
		genre: resolve('genre'),
		year: resolve('year'),
		charter,
		icon: icon === charter.toLowerCase() ? '' : icon,
	}
}

export function serializeSongHash20251010(request: SerializeSongHashRequest): Uint8Array {
	if (request.durationMs < MIN_INT64 || request.durationMs > MAX_INT64) {
		throw new RangeError('SongHash duration must fit signed int64')
	}
	if (request.members.length > 0xffffffff) throw new RangeError('SongHash member count exceeds uint32')
	const metadata = resolvedMetadata(request.metadata)
	const memberParts: Uint8Array[] = []
	for (const member of request.members) {
		if (member.digest.byteLength !== 32) throw new RangeError('SongHash member digest must be 32 bytes')
		memberParts.push(uint32(member.instrumentId), uint32(member.difficultyId), member.digest)
	}
	return concatenate([
		MAGIC,
		uint32(VERSION),
		framedString(metadata.name),
		framedString(metadata.artist),
		framedString(metadata.album),
		framedString(metadata.genre),
		framedString(metadata.year),
		int64(request.durationMs),
		framedString(metadata.charter),
		framedString(metadata.icon),
		uint32(request.members.length),
		...memberParts,
	])
}

function digestSong(preimage: Uint8Array): { readonly digest: Uint8Array; readonly value: string } {
	const digest = blake3(preimage)
	return { digest, value: base64url.stringify(digest, { pad: false }) }
}

function ownedBytes(bytes: Uint8Array): () => Uint8Array {
	const owned = bytes.slice()
	return () => owned.slice()
}

function assertUniqueMembers(members: readonly WireMember[]): void {
	const seen = new Set<string>()
	for (const member of members) {
		const key = `${member.instrumentId}:${member.difficultyId}`
		if (seen.has(key)) throw new RangeError(`Duplicate SongHash member ${key}`)
		seen.add(key)
	}
}

export function identifyLegacySong(request: LegacySongIdentityRequest): LegacySongIdentity {
	const orderedMembers = [...request.members].sort((left, right) =>
		legacyInstrumentId(left.instrument) - legacyInstrumentId(right.instrument)
		|| legacyDifficultyIds[left.difficulty] - legacyDifficultyIds[right.difficulty])
	const wireMembers = orderedMembers.map(member => ({
		instrumentId: legacyInstrumentId(member.instrument),
		difficultyId: legacyDifficultyIds[member.difficulty],
		digest: member.digest.bytes,
	}))
	assertUniqueMembers(wireMembers)
	const preimage = serializeSongHash20251010({
		metadata: request.metadata,
		durationMs: request.durationMs,
		members: wireMembers,
	})
	const result = digestSong(preimage)
	const preimageBytes = ownedBytes(preimage)
	const digestBytes = ownedBytes(result.digest)
	return {
		profile: 'clone-hero-1.1.0.6142',
		metadata: { ...request.metadata },
		durationMs: request.durationMs,
		members: orderedMembers,
		get preimage() { return preimageBytes() },
		get digest() { return digestBytes() },
		songHash: {
			profile: 'clone-hero-1.1.0.6142',
			encoding: 'base64url-unpadded',
			value: result.value,
			[legacySongHashToken]: true,
		},
	}
}

export function identifyCanonicalSong(request: CanonicalSongIdentityRequest): CanonicalSongIdentity {
	const orderedMembers = [...request.members].sort((left, right) =>
		canonicalInstrumentId(left.instrument) - canonicalInstrumentId(right.instrument)
		|| canonicalDifficultyIds[left.difficulty] - canonicalDifficultyIds[right.difficulty])
	const wireMembers = orderedMembers.map(member => ({
		instrumentId: canonicalInstrumentId(member.instrument),
		difficultyId: canonicalDifficultyIds[member.difficulty],
		digest: member.digest.bytes,
	}))
	assertUniqueMembers(wireMembers)
	const metadata = resolveCanonicalMetadata(request.metadata)
	const preimage = serializeSongHash20251010({
		metadata,
		durationMs: request.durationMs,
		members: wireMembers,
	})
	const result = digestSong(preimage)
	const preimageBytes = ownedBytes(preimage)
	const digestBytes = ownedBytes(result.digest)
	return {
		profile: 'canonical-20260801',
		metadata,
		durationMs: request.durationMs,
		members: orderedMembers,
		get preimage() { return preimageBytes() },
		get digest() { return digestBytes() },
		songHash: {
			profile: 'canonical-20260801',
			encoding: 'base64url-unpadded',
			value: result.value,
			[canonicalSongHashToken]: true,
		},
	}
}
