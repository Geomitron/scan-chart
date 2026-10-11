import { blake3 } from '@awasm/noble'
import { base64url } from 'rfc4648'

import { NoteType, noteFlags, noteTypes } from '../types'

const PHYSICAL_VERSION = 20260801
const MAP_ENTRY_SIZE = 20
const HEADER_AND_COUNT_SIZE = 12
const ZERO = BigInt(0)
const ONE = BigInt(1)
const TWO = BigInt(2)
const THREE = BigInt(3)
const FOUR = BigInt(4)
const FIVE = BigInt(5)
const SIX = BigInt(6)
const SEVEN = BigInt(7)
const EIGHT = BigInt(8)
const NINE = BigInt(9)
const TWELVE = BigInt(12)
const MAX_UINT64 = BigInt('18446744073709551615')
const SECTION_RESOLUTION = ONE
const SECTION_TEMPO = TWO
const SECTION_TIME_SIGNATURE = THREE
const SECTION_STAR_POWER = FOUR
const SECTION_SOLO = FIVE
const SECTION_FLEX_LANE = SIX
const SECTION_DRUM_FREESTYLE = SEVEN
const SECTION_RANGE_SHIFT = EIGHT
const SECTION_NOTE = NINE

const canonicalPhysicalToken: unique symbol = Symbol('canonicalPhysicalBTrack')
const canonicalProjectionToken: unique symbol = Symbol('canonicalTrackHashProjection')
const canonicalDigestToken: unique symbol = Symbol('canonicalBlake3Digest')
const canonicalTrackHashToken: unique symbol = Symbol('canonicalTrackHash')
const validatedBTrackToken: unique symbol = Symbol('validatedBTrack20260801')

export interface CanonicalTempo {
	readonly tick: bigint
	readonly beatsPerMinute: number
}

export interface CanonicalTimeSignature {
	readonly tick: bigint
	readonly numerator: number
	readonly denominator: number
}

export interface CanonicalTickRange {
	readonly tick: bigint
	readonly length: bigint
}

export interface CanonicalFlexLane extends CanonicalTickRange {
	readonly isDouble: boolean
}

export interface CanonicalDrumFreestyle extends CanonicalTickRange {
	readonly isCoda: boolean
}

export type FiveFretRange =
	| { readonly position: 1; readonly size: 1 | 2 | 3 | 4 | 5 }
	| { readonly position: 2; readonly size: 1 | 2 | 3 | 4 }
	| { readonly position: 3; readonly size: 1 | 2 | 3 }
	| { readonly position: 4; readonly size: 1 | 2 }
	| { readonly position: 5; readonly size: 1 }

export function createFiveFretRange(position: number, size: number): FiveFretRange | null {
	if (position === 1) {
		if (size === 1) return { position: 1, size: 1 }
		if (size === 2) return { position: 1, size: 2 }
		if (size === 3) return { position: 1, size: 3 }
		if (size === 4) return { position: 1, size: 4 }
		if (size === 5) return { position: 1, size: 5 }
	}
	if (position === 2) {
		if (size === 1) return { position: 2, size: 1 }
		if (size === 2) return { position: 2, size: 2 }
		if (size === 3) return { position: 2, size: 3 }
		if (size === 4) return { position: 2, size: 4 }
	}
	if (position === 3) {
		if (size === 1) return { position: 3, size: 1 }
		if (size === 2) return { position: 3, size: 2 }
		if (size === 3) return { position: 3, size: 3 }
	}
	if (position === 4) {
		if (size === 1) return { position: 4, size: 1 }
		if (size === 2) return { position: 4, size: 2 }
	}
	if (position === 5 && size === 1) return { position: 5, size: 1 }
	return null
}

export type CanonicalRangeShift = { readonly tick: bigint } & FiveFretRange

export interface CanonicalNote extends CanonicalTickRange {
	readonly type: NoteType
	readonly flags: number
}

export interface CanonicalTrackSemantics {
	readonly resolution: number
	readonly tempos: readonly CanonicalTempo[]
	readonly timeSignatures: readonly CanonicalTimeSignature[]
	readonly starPower: readonly CanonicalTickRange[]
	readonly solos: readonly CanonicalTickRange[]
	readonly flexLanes: readonly CanonicalFlexLane[]
	readonly drumFreestyle: readonly CanonicalDrumFreestyle[]
	readonly rangeShifts: readonly CanonicalRangeShift[]
	readonly notes: readonly CanonicalNote[]
}

export interface CanonicalPhysicalBTrack {
	readonly kind: 'sectioned-btrack'
	readonly profile: 'canonical-20260801'
	readonly physicalVersion: 20260801
	readonly bytes: Uint8Array<ArrayBuffer>
	readonly [canonicalPhysicalToken]: true
}

export interface CanonicalTrackHashProjection {
	readonly kind: 'ticket-03-map-first'
	readonly profile: 'canonical-20260801'
	readonly bytes: Uint8Array
	readonly [canonicalProjectionToken]: true
}

export interface CanonicalBlake3Digest {
	readonly algorithm: 'blake3-256'
	readonly bytes: Uint8Array
	readonly [canonicalDigestToken]: true
}

export interface CanonicalTrackHash {
	readonly encoding: 'base64url-unpadded'
	readonly value: string
	readonly [canonicalTrackHashToken]: true
}

export interface CanonicalTrackIdentity {
	readonly profile: 'canonical-20260801'
	readonly physicalBTrack: CanonicalPhysicalBTrack
	readonly projection: CanonicalTrackHashProjection
	readonly digest: CanonicalBlake3Digest
	readonly trackHash: CanonicalTrackHash
}

export type BTrackRecordField =
	| 'resolution'
	| 'tick'
	| 'length'
	| 'tempo'
	| 'numerator'
	| 'denominator'
	| 'position'
	| 'size'
	| 'isDouble'
	| 'isCoda'
	| 'noteType'
	| 'noteFlags'

export type BTrackReadError =
	| { readonly code: 'headerTruncated'; readonly actualLength: number }
	| { readonly code: 'magicInvalid'; readonly actual: readonly number[] }
	| { readonly code: 'physicalVersionUnsupported'; readonly actual: number }
	| { readonly code: 'sectionMapTruncated'; readonly expectedEnd: bigint; readonly fileLength: bigint }
	| {
		readonly code: 'sectionIdsNotStrictlyIncreasing'
		readonly index: number
		readonly previous: bigint
		readonly current: bigint
	}
	| { readonly code: 'sectionRangeArithmeticOverflow'; readonly sectionId: bigint }
	| {
		readonly code: 'sectionRangeOutOfBounds'
		readonly sectionId: bigint
		readonly offset: bigint
		readonly length: number
		readonly fileLength: bigint
	}
	| {
		readonly code: 'sectionOffsetNoncanonical'
		readonly sectionId: bigint
		readonly expected: bigint
		readonly actual: bigint
	}
	| { readonly code: 'trailingBytes'; readonly expectedLength: bigint; readonly actualLength: bigint }
	| { readonly code: 'resolutionMissing' }
	| {
		readonly code: 'recognizedPayloadLengthInvalid'
		readonly sectionId: bigint
		readonly expected: bigint
		readonly actual: number
	}
	| { readonly code: 'emptyOptionalSection'; readonly sectionId: bigint }
	| {
		readonly code: 'recordValueInvalid'
		readonly sectionId: bigint
		readonly recordIndex: number
		readonly field: BTrackRecordField
		readonly reason:
			| 'negative'
			| 'notFinite'
			| 'zero'
			| 'booleanNotZeroOrOne'
			| 'enumUnknown'
			| 'flagBitsUnknown'
			| 'flagCombinationInvalid'
			| 'rangeOutOfBounds'
			| 'orderNoncanonical'
			| 'overlapNoncanonical'
			| 'containsNoNotes'
	}

export type CanonicalBTrackReadOutcome =
	| {
		readonly kind: 'accepted'
		readonly semantics: CanonicalTrackSemantics
		readonly identity: CanonicalTrackIdentity
	}
	| {
		readonly kind: 'rejected'
		readonly errors: readonly [BTrackReadError, ...BTrackReadError[]]
	}

interface CanonicalSection {
	readonly id: bigint
	readonly payload: Uint8Array
}

interface ValidatedBTrack20260801 {
	readonly semantics: CanonicalTrackSemantics
	readonly sections: readonly CanonicalSection[]
	readonly physicalBytes: Uint8Array
	readonly [validatedBTrackToken]: true
}

interface SectionMapEntry {
	readonly id: bigint
	readonly offset: bigint
	readonly length: number
}

function copyBytes(source: Uint8Array): () => Uint8Array<ArrayBuffer> {
	const owned = source.slice()
	return () => owned.slice()
}

function assertUint32(value: number, field: string): void {
	if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
		throw new RangeError(`${field} must be a uint32`)
	}
}

function assertNonnegative(value: bigint, field: string): void {
	if (value < ZERO) throw new RangeError(`${field} must be nonnegative`)
}

function hasAtMostOneFlag(flags: number, mask: number): boolean {
	const selected = flags & mask
	return selected === 0 || (selected & (selected - 1)) === 0
}

function noteFlagError(type: NoteType, flags: number): 'flagBitsUnknown' | 'flagCombinationInvalid' | null {
	if ((flags & ~0x7ff) !== 0) return 'flagBitsUnknown'
	if (!hasAtMostOneFlag(flags, noteFlags.strum | noteFlags.hopo | noteFlags.tap)) return 'flagCombinationInvalid'
	if (!hasAtMostOneFlag(flags, noteFlags.doubleKick | noteFlags.tom | noteFlags.cymbal)) return 'flagCombinationInvalid'
	if (!hasAtMostOneFlag(flags, noteFlags.discoNoflip | noteFlags.disco)) return 'flagCombinationInvalid'
	if (!hasAtMostOneFlag(flags, noteFlags.ghost | noteFlags.accent)) return 'flagCombinationInvalid'
	if ((flags & noteFlags.doubleKick) !== 0 && type !== noteTypes.kick) return 'flagCombinationInvalid'
	if ((flags & (noteFlags.ghost | noteFlags.accent)) !== 0 && type === noteTypes.kick) return 'flagCombinationInvalid'
	if ((flags & (noteFlags.tom | noteFlags.cymbal)) !== 0 && (type < noteTypes.redDrum || type > noteTypes.greenDrum)) {
		return 'flagCombinationInvalid'
	}
	if ((flags & (noteFlags.discoNoflip | noteFlags.disco)) !== 0 && type !== noteTypes.redDrum && type !== noteTypes.yellowDrum) {
		return 'flagCombinationInvalid'
	}
	return null
}

function isNoteType(value: number): value is NoteType {
	return Object.values(noteTypes).some(noteType => noteType === value)
}

function assertStrictTicks(values: readonly { readonly tick: bigint }[], section: string): void {
	for (let index = 1; index < values.length; index++) {
		if (values[index].tick <= values[index - 1].tick) throw new RangeError(`${section} ticks must be strictly increasing`)
	}
}

function assertNonoverlappingRanges(values: readonly CanonicalTickRange[], section: string): void {
	assertStrictTicks(values, section)
	for (let index = 1; index < values.length; index++) {
		if (values[index].tick < values[index - 1].tick + values[index - 1].length) {
			throw new RangeError(`${section} ranges must not overlap`)
		}
	}
}

function phraseContainsNote(
	range: CanonicalTickRange,
	notes: readonly CanonicalNote[],
	inclusiveEnd: boolean,
): boolean {
	const end = range.tick + (inclusiveEnd ? range.length : range.length || ONE)
	return notes.some(note => note.tick >= range.tick && (inclusiveEnd ? note.tick <= end : note.tick < end))
}

function assertCanonicalPhrasePruning(semantics: CanonicalTrackSemantics): void {
	const sections: readonly [string, readonly CanonicalTickRange[], boolean][] = [
		['star power', semantics.starPower, false],
		['solo', semantics.solos, false],
		['flex lane', semantics.flexLanes, true],
	]
	for (const [name, ranges, inclusiveEnd] of sections) {
		if (ranges.some(range => !phraseContainsNote(range, semantics.notes, inclusiveEnd))) {
			throw new RangeError(`${name} ranges must contain a note`)
		}
	}
}

function assertCanonicalRecordOrder(semantics: CanonicalTrackSemantics): void {
	assertStrictTicks(semantics.tempos, 'tempo')
	assertStrictTicks(semantics.timeSignatures, 'time signature')
	assertNonoverlappingRanges(semantics.starPower, 'star power')
	assertNonoverlappingRanges(semantics.solos, 'solo')
	assertStrictTicks(semantics.rangeShifts, 'range shift')

	// Flex lanes may overlap, including lanes of the same type; only their order is canonical.
	for (let index = 1; index < semantics.flexLanes.length; index++) {
		const lane = semantics.flexLanes[index]
		const previous = semantics.flexLanes[index - 1]
		if (lane.tick < previous.tick || (lane.tick === previous.tick && (previous.isDouble || !lane.isDouble))) {
			throw new RangeError('flex lanes must be ordered by tick, then single before double')
		}
	}

	for (let index = 1; index < semantics.drumFreestyle.length; index++) {
		if (semantics.drumFreestyle[index].tick < semantics.drumFreestyle[index - 1].tick) {
			throw new RangeError('drum freestyle ranges must use ascending tick order')
		}
	}

	const noteEnds = new Map<NoteType, bigint>()
	for (let index = 0; index < semantics.notes.length; index++) {
		const note = semantics.notes[index]
		const previous = semantics.notes[index - 1]
		if (previous && (note.tick < previous.tick || (note.tick === previous.tick && note.type <= previous.type))) {
			throw new RangeError('notes must be ordered by tick, then NoteType')
		}
		const priorEnd = noteEnds.get(note.type)
		if (priorEnd !== undefined && note.tick < priorEnd) throw new RangeError('notes of the same type must not overlap')
		noteEnds.set(note.type, note.tick + note.length)
	}
}

function createPayload(byteLength: number, write: (view: DataView) => void): Uint8Array {
	const bytes = new Uint8Array(byteLength)
	write(new DataView(bytes.buffer))
	return bytes
}

function createCountedPayload<T>(
	values: readonly T[],
	recordSize: number,
	writeRecord: (view: DataView, offset: number, value: T) => void,
): Uint8Array {
	assertUint32(values.length, 'section count')
	return createPayload(4 + values.length * recordSize, view => {
		view.setUint32(0, values.length, true)
		values.forEach((value, index) => writeRecord(view, 4 + index * recordSize, value))
	})
}

function assertCanonicalSemantics(semantics: CanonicalTrackSemantics): void {
	assertUint32(semantics.resolution, 'resolution')
	if (semantics.resolution === 0) throw new RangeError('resolution must be greater than zero')

	for (const tempo of semantics.tempos) {
		assertNonnegative(tempo.tick, 'tempo tick')
		if (!Number.isFinite(tempo.beatsPerMinute) || tempo.beatsPerMinute <= 0) {
			throw new RangeError('tempo must be finite and greater than zero')
		}
	}
	for (const signature of semantics.timeSignatures) {
		assertNonnegative(signature.tick, 'time signature tick')
		assertUint32(signature.numerator, 'time signature numerator')
		assertUint32(signature.denominator, 'time signature denominator')
		if (signature.numerator === 0 || signature.denominator === 0) {
			throw new RangeError('time signature values must be greater than zero')
		}
	}
	for (const range of [...semantics.starPower, ...semantics.solos, ...semantics.flexLanes, ...semantics.drumFreestyle]) {
		assertNonnegative(range.tick, 'range tick')
		assertNonnegative(range.length, 'range length')
	}
	for (const shift of semantics.rangeShifts) {
		assertNonnegative(shift.tick, 'range shift tick')
		if (shift.position < 1 || shift.position > 5 || shift.size < 1 || shift.size > 5 || shift.position + shift.size > 6) {
			throw new RangeError('range shift bounds are invalid')
		}
	}
	for (const note of semantics.notes) {
		assertNonnegative(note.tick, 'note tick')
		assertNonnegative(note.length, 'note length')
		if (!Object.values(noteTypes).includes(note.type)) throw new RangeError('note type is invalid')
		if (!Number.isInteger(note.flags) || note.flags < 0 || noteFlagError(note.type, note.flags) !== null) {
			throw new RangeError('note flags are invalid')
		}
	}
	assertCanonicalRecordOrder(semantics)
	assertCanonicalPhrasePruning(semantics)
}

function buildRecognizedSections(semantics: CanonicalTrackSemantics): CanonicalSection[] {
	assertCanonicalSemantics(semantics)
	const sections: CanonicalSection[] = [{
		id: SECTION_RESOLUTION,
		payload: createPayload(4, view => view.setUint32(0, semantics.resolution, true)),
	}]

	const addList = <T>(id: bigint, values: readonly T[], recordSize: number, write: (view: DataView, offset: number, value: T) => void) => {
		if (values.length > 0) sections.push({ id, payload: createCountedPayload(values, recordSize, write) })
	}

	addList(SECTION_TEMPO, semantics.tempos, 16, (view, offset, tempo) => {
		view.setBigInt64(offset, tempo.tick, true)
		view.setFloat64(offset + 8, tempo.beatsPerMinute, true)
	})
	addList(SECTION_TIME_SIGNATURE, semantics.timeSignatures, 16, (view, offset, signature) => {
		view.setBigInt64(offset, signature.tick, true)
		view.setUint32(offset + 8, signature.numerator, true)
		view.setUint32(offset + 12, signature.denominator, true)
	})
	addList(SECTION_STAR_POWER, semantics.starPower, 16, writeTickRange)
	addList(SECTION_SOLO, semantics.solos, 16, writeTickRange)
	addList(SECTION_FLEX_LANE, semantics.flexLanes, 17, (view, offset, lane) => {
		writeTickRange(view, offset, lane)
		view.setUint8(offset + 16, lane.isDouble ? 1 : 0)
	})
	addList(SECTION_DRUM_FREESTYLE, semantics.drumFreestyle, 17, (view, offset, range) => {
		writeTickRange(view, offset, range)
		view.setUint8(offset + 16, range.isCoda ? 1 : 0)
	})
	addList(SECTION_RANGE_SHIFT, semantics.rangeShifts, 24, (view, offset, shift) => {
		view.setBigInt64(offset, shift.tick, true)
		view.setBigInt64(offset + 8, BigInt(shift.position), true)
		view.setBigInt64(offset + 16, BigInt(shift.size), true)
	})
	addList(SECTION_NOTE, semantics.notes, 24, (view, offset, note) => {
		writeTickRange(view, offset, note)
		view.setUint32(offset + 16, note.type, true)
		view.setUint32(offset + 20, note.flags, true)
	})
	return sections
}

function writeTickRange(view: DataView, offset: number, range: CanonicalTickRange): void {
	view.setBigInt64(offset, range.tick, true)
	view.setBigInt64(offset + 8, range.length, true)
}

function writePhysicalFile(sections: readonly CanonicalSection[]): Uint8Array {
	const mapEnd = HEADER_AND_COUNT_SIZE + MAP_ENTRY_SIZE * sections.length
	const totalLength = sections.reduce((length, section) => length + section.payload.length, mapEnd)
	const bytes = new Uint8Array(totalLength)
	const view = new DataView(bytes.buffer)
	bytes.set([0x43, 0x48, 0x4e, 0x46], 0)
	view.setUint32(4, PHYSICAL_VERSION, true)
	view.setUint32(8, sections.length, true)

	let payloadOffset = mapEnd
	sections.forEach((section, index) => {
		const entryOffset = HEADER_AND_COUNT_SIZE + index * MAP_ENTRY_SIZE
		view.setBigUint64(entryOffset, section.id, true)
		view.setBigUint64(entryOffset + 8, BigInt(payloadOffset), true)
		view.setUint32(entryOffset + 16, section.payload.length, true)
		bytes.set(section.payload, payloadOffset)
		payloadOffset += section.payload.length
	})
	return bytes
}

/**
 * `.chart` stores tempo in thousandths of a BPM and `.mid` in microseconds per beat, so most tempos can't be converted
 * exactly. The TrackHash and chart durations use tempos rounded to 0.001 BPM, so a chart keeps its hashes when
 * converted between the two formats. BTrack files and gameplay keep the exact tempo.
 */
export function roundBpm(beatsPerMinute: number): number {
	return Math.floor(beatsPerMinute * 1000 + 0.5) / 1000
}

function roundTempoPayload(payload: Uint8Array): Uint8Array {
	const rounded = payload.slice()
	const view = new DataView(rounded.buffer)
	const count = view.getUint32(0, true)
	for (let index = 0; index < count; index++) {
		const offset = 4 + index * 16 + 8
		view.setFloat64(offset, roundBpm(view.getFloat64(offset, true)), true)
	}
	return rounded
}

function projectTrackHash(sections: readonly CanonicalSection[]): Uint8Array {
	const recognized = sections
		.filter(section => section.id >= SECTION_RESOLUTION && section.id <= SECTION_NOTE)
		.map(section => section.id === SECTION_TEMPO ? { ...section, payload: roundTempoPayload(section.payload) } : section)
	const payloadLength = recognized.reduce((length, section) => length + section.payload.length, 0)
	const bytes = new Uint8Array(4 + 8 * recognized.length + payloadLength)
	const view = new DataView(bytes.buffer)
	view.setUint32(0, recognized.length, true)
	let mapOffset = 4
	let payloadOffset = 4 + 8 * recognized.length
	for (const section of recognized) {
		view.setBigUint64(mapOffset, section.id, true)
		mapOffset += 8
		bytes.set(section.payload, payloadOffset)
		payloadOffset += section.payload.length
	}
	return bytes
}

function createValidatedBTrack(
	semantics: CanonicalTrackSemantics,
	sections: readonly CanonicalSection[],
	physicalBytes: Uint8Array,
): ValidatedBTrack20260801 {
	return {
		semantics,
		sections,
		physicalBytes: physicalBytes.slice(),
		[validatedBTrackToken]: true,
	}
}

function identifyValidatedBTrack(file: ValidatedBTrack20260801): CanonicalTrackIdentity {
	const physicalBytes = copyBytes(file.physicalBytes)
	const projection = projectTrackHash(file.sections)
	const projectionBytes = copyBytes(projection)
	const digest = blake3(projection)
	const digestBytes = copyBytes(digest)

	return {
		profile: 'canonical-20260801',
		physicalBTrack: {
			kind: 'sectioned-btrack',
			profile: 'canonical-20260801',
			physicalVersion: PHYSICAL_VERSION,
			get bytes() { return physicalBytes() },
			[canonicalPhysicalToken]: true,
		},
		projection: {
			kind: 'ticket-03-map-first',
			profile: 'canonical-20260801',
			get bytes() { return projectionBytes() },
			[canonicalProjectionToken]: true,
		},
		digest: {
			algorithm: 'blake3-256',
			get bytes() { return digestBytes() },
			[canonicalDigestToken]: true,
		},
		trackHash: {
			encoding: 'base64url-unpadded',
			value: base64url.stringify(digest, { pad: false }),
			[canonicalTrackHashToken]: true,
		},
	}
}

export function identifyCanonicalTrack(semantics: CanonicalTrackSemantics): CanonicalTrackIdentity {
	const sections = buildRecognizedSections(semantics)
	const physical = writePhysicalFile(sections)
	return identifyValidatedBTrack(createValidatedBTrack(semantics, sections, physical))
}

function reject(error: BTrackReadError): CanonicalBTrackReadOutcome {
	return { kind: 'rejected', errors: [error] }
}

function bytesEqualMagic(bytes: Uint8Array): boolean {
	return bytes[0] === 0x43 && bytes[1] === 0x48 && bytes[2] === 0x4e && bytes[3] === 0x46
}

function readMap(bytes: Uint8Array, view: DataView): CanonicalBTrackReadOutcome | SectionMapEntry[] {
	const sectionCount = view.getUint32(8, true)
	const mapEnd = BigInt(HEADER_AND_COUNT_SIZE) + BigInt(MAP_ENTRY_SIZE) * BigInt(sectionCount)
	if (mapEnd > BigInt(bytes.length)) {
		return reject({ code: 'sectionMapTruncated', expectedEnd: mapEnd, fileLength: BigInt(bytes.length) })
	}

	const entries: SectionMapEntry[] = []
	for (let index = 0; index < sectionCount; index++) {
		const entryOffset = HEADER_AND_COUNT_SIZE + index * MAP_ENTRY_SIZE
		const entry = {
			id: view.getBigUint64(entryOffset, true),
			offset: view.getBigUint64(entryOffset + 8, true),
			length: view.getUint32(entryOffset + 16, true),
		}
		const previous = entries[index - 1]
		if (previous && entry.id <= previous.id) {
			return reject({
				code: 'sectionIdsNotStrictlyIncreasing',
				index,
				previous: previous.id,
				current: entry.id,
			})
		}
		entries.push(entry)
	}

	let expectedOffset = mapEnd
	for (const entry of entries) {
		const end = entry.offset + BigInt(entry.length)
		if (end > MAX_UINT64) return reject({ code: 'sectionRangeArithmeticOverflow', sectionId: entry.id })
		if (entry.offset < mapEnd || end > BigInt(bytes.length)) {
			return reject({
				code: 'sectionRangeOutOfBounds',
				sectionId: entry.id,
				offset: entry.offset,
				length: entry.length,
				fileLength: BigInt(bytes.length),
			})
		}
		if (entry.offset !== expectedOffset) {
			return reject({
				code: 'sectionOffsetNoncanonical',
				sectionId: entry.id,
				expected: expectedOffset,
				actual: entry.offset,
			})
		}
		expectedOffset = end
	}
	if (expectedOffset !== BigInt(bytes.length)) {
		return reject({ code: 'trailingBytes', expectedLength: expectedOffset, actualLength: BigInt(bytes.length) })
	}
	return entries
}

function payloadFor(bytes: Uint8Array, entry: SectionMapEntry): Uint8Array {
	const start = Number(entry.offset)
	return bytes.slice(start, start + entry.length)
}

function validateListPayload(entry: SectionMapEntry, payload: Uint8Array, recordSize: number): CanonicalBTrackReadOutcome | number {
	if (payload.length < 4) {
		return reject({ code: 'recognizedPayloadLengthInvalid', sectionId: entry.id, expected: FOUR, actual: payload.length })
	}
	const count = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true)
	if (count === 0) return reject({ code: 'emptyOptionalSection', sectionId: entry.id })
	const expected = FOUR + BigInt(count) * BigInt(recordSize)
	if (expected !== BigInt(payload.length)) {
		return reject({ code: 'recognizedPayloadLengthInvalid', sectionId: entry.id, expected, actual: payload.length })
	}
	return count
}

function invalidRecord(
	sectionId: bigint,
	recordIndex: number,
	field: BTrackRecordField,
	reason: Extract<BTrackReadError, { code: 'recordValueInvalid' }>['reason'],
): CanonicalBTrackReadOutcome {
	return reject({ code: 'recordValueInvalid', sectionId, recordIndex, field, reason })
}

function checkTickOrder(sectionId: bigint, recordIndex: number, tick: bigint, previousTick: bigint | undefined): CanonicalBTrackReadOutcome | null {
	if (tick < ZERO) return invalidRecord(sectionId, recordIndex, 'tick', 'negative')
	if (previousTick !== undefined && tick < previousTick) {
		return invalidRecord(sectionId, recordIndex, 'tick', 'orderNoncanonical')
	}
	if (previousTick !== undefined && tick === previousTick &&
		sectionId !== SECTION_FLEX_LANE && sectionId !== SECTION_DRUM_FREESTYLE && sectionId !== SECTION_NOTE) {
		return invalidRecord(sectionId, recordIndex, 'tick', 'orderNoncanonical')
	}
	return null
}

function parseRecognizedSections(
	bytes: Uint8Array,
	entries: readonly SectionMapEntry[],
): CanonicalBTrackReadOutcome | { readonly semantics: CanonicalTrackSemantics; readonly sections: readonly CanonicalSection[] } {
	const resolutionEntry = entries.find(entry => entry.id === SECTION_RESOLUTION)
	if (!resolutionEntry) return reject({ code: 'resolutionMissing' })
	if (resolutionEntry.length !== 4) {
		return reject({ code: 'recognizedPayloadLengthInvalid', sectionId: SECTION_RESOLUTION, expected: FOUR, actual: resolutionEntry.length })
	}

	const sections = entries.map(entry => ({ id: entry.id, payload: payloadFor(bytes, entry) }))
	const resolutionPayload = payloadFor(bytes, resolutionEntry)
	const resolution = new DataView(resolutionPayload.buffer, resolutionPayload.byteOffset, resolutionPayload.byteLength).getUint32(0, true)
	if (resolution === 0) return invalidRecord(SECTION_RESOLUTION, 0, 'resolution', 'zero')

	const mutable: {
		resolution: number
		tempos: CanonicalTempo[]
		timeSignatures: CanonicalTimeSignature[]
		starPower: CanonicalTickRange[]
		solos: CanonicalTickRange[]
		flexLanes: CanonicalFlexLane[]
		drumFreestyle: CanonicalDrumFreestyle[]
		rangeShifts: CanonicalRangeShift[]
		notes: CanonicalNote[]
	} = {
		resolution,
		tempos: [],
		timeSignatures: [],
		starPower: [],
		solos: [],
		flexLanes: [],
		drumFreestyle: [],
		rangeShifts: [],
		notes: [],
	}

	for (const entry of entries) {
		if (entry.id < SECTION_TEMPO || entry.id > SECTION_NOTE) continue
		const payload = payloadFor(bytes, entry)
		const recordSize = entry.id === SECTION_FLEX_LANE || entry.id === SECTION_DRUM_FREESTYLE ? 17
			: entry.id === SECTION_RANGE_SHIFT || entry.id === SECTION_NOTE ? 24
			: 16
		const countResult = validateListPayload(entry, payload, recordSize)
		if (typeof countResult !== 'number') return countResult
		const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
		let previousTick: bigint | undefined
		let previousFlexDouble: boolean | undefined
		let previousNoteType: number | undefined
		let previousPhraseEnd: bigint | undefined
		const previousNoteEnd = new Map<number, bigint>()
		for (let index = 0; index < countResult; index++) {
			const offset = 4 + index * recordSize
			const tick = view.getBigInt64(offset, true)
			const sameTick = tick === previousTick
			const orderError = checkTickOrder(entry.id, index, tick, previousTick)
			if (orderError) return orderError
			previousTick = tick

			if (entry.id === SECTION_TEMPO) {
				const beatsPerMinute = view.getFloat64(offset + 8, true)
				if (!Number.isFinite(beatsPerMinute)) return invalidRecord(entry.id, index, 'tempo', 'notFinite')
				if (beatsPerMinute <= 0) return invalidRecord(entry.id, index, 'tempo', 'zero')
				mutable.tempos.push({ tick, beatsPerMinute })
			} else if (entry.id === SECTION_TIME_SIGNATURE) {
				const numerator = view.getUint32(offset + 8, true)
				const denominator = view.getUint32(offset + 12, true)
				if (numerator === 0) return invalidRecord(entry.id, index, 'numerator', 'zero')
				if (denominator === 0) return invalidRecord(entry.id, index, 'denominator', 'zero')
				mutable.timeSignatures.push({ tick, numerator, denominator })
			} else if (entry.id === SECTION_RANGE_SHIFT) {
				const position = view.getBigInt64(offset + 8, true)
				const size = view.getBigInt64(offset + 16, true)
				if (position < ZERO) return invalidRecord(entry.id, index, 'position', 'negative')
				if (size < ZERO) return invalidRecord(entry.id, index, 'size', 'negative')
				const range = createFiveFretRange(Number(position), Number(size))
				if (!range) {
					return invalidRecord(entry.id, index, 'position', 'rangeOutOfBounds')
				}
				mutable.rangeShifts.push({ tick, ...range })
			} else {
				const length = view.getBigInt64(offset + 8, true)
				if (length < ZERO) return invalidRecord(entry.id, index, 'length', 'negative')
				if (entry.id === SECTION_STAR_POWER || entry.id === SECTION_SOLO) {
					if (previousPhraseEnd !== undefined && tick < previousPhraseEnd) {
						return invalidRecord(entry.id, index, 'length', 'overlapNoncanonical')
					}
					previousPhraseEnd = tick + length
				}
				if (entry.id === SECTION_STAR_POWER) mutable.starPower.push({ tick, length })
				if (entry.id === SECTION_SOLO) mutable.solos.push({ tick, length })
				if (entry.id === SECTION_FLEX_LANE) {
					const isDouble = view.getUint8(offset + 16)
					if (isDouble > 1) return invalidRecord(entry.id, index, 'isDouble', 'booleanNotZeroOrOne')
					if (sameTick && (previousFlexDouble !== false || isDouble !== 1)) {
						return invalidRecord(entry.id, index, 'isDouble', 'orderNoncanonical')
					}
					previousFlexDouble = isDouble === 1
					mutable.flexLanes.push({ tick, length, isDouble: isDouble === 1 })
				}
				if (entry.id === SECTION_DRUM_FREESTYLE) {
					const isCoda = view.getUint8(offset + 16)
					if (isCoda > 1) return invalidRecord(entry.id, index, 'isCoda', 'booleanNotZeroOrOne')
					mutable.drumFreestyle.push({ tick, length, isCoda: isCoda === 1 })
				}
				if (entry.id === SECTION_NOTE) {
					const type = view.getUint32(offset + 16, true)
					const flags = view.getUint32(offset + 20, true)
					if (!isNoteType(type)) {
						return invalidRecord(entry.id, index, 'noteType', 'enumUnknown')
					}
					const flagError = noteFlagError(type, flags)
					if (flagError) return invalidRecord(entry.id, index, 'noteFlags', flagError)
					if (sameTick && previousNoteType !== undefined && type <= previousNoteType) {
						return invalidRecord(entry.id, index, 'noteType', 'orderNoncanonical')
					}
					previousNoteType = type
					const priorEnd = previousNoteEnd.get(type)
					if (priorEnd !== undefined && tick < priorEnd) {
						return invalidRecord(entry.id, index, 'length', 'overlapNoncanonical')
					}
					previousNoteEnd.set(type, tick + length)
					mutable.notes.push({ tick, length, type, flags })
				}
			}
		}
	}
	const phraseSections: readonly [bigint, readonly CanonicalTickRange[], boolean][] = [
		[SECTION_STAR_POWER, mutable.starPower, false],
		[SECTION_SOLO, mutable.solos, false],
		[SECTION_FLEX_LANE, mutable.flexLanes, true],
	]
	for (const [sectionId, ranges, inclusiveEnd] of phraseSections) {
		const emptyIndex = ranges.findIndex(range => !phraseContainsNote(range, mutable.notes, inclusiveEnd))
		if (emptyIndex >= 0) return invalidRecord(sectionId, emptyIndex, 'length', 'containsNoNotes')
	}
	return { semantics: mutable, sections }
}

export function readBTrack20260801(input: Uint8Array): CanonicalBTrackReadOutcome {
	const bytes = input.slice()
	if (bytes.length < 8) return reject({ code: 'headerTruncated', actualLength: bytes.length })
	if (!bytesEqualMagic(bytes)) return reject({ code: 'magicInvalid', actual: [...bytes.slice(0, 4)] })
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const version = view.getUint32(4, true)
	if (version !== PHYSICAL_VERSION) return reject({ code: 'physicalVersionUnsupported', actual: version })
	if (bytes.length < HEADER_AND_COUNT_SIZE) {
		return reject({ code: 'sectionMapTruncated', expectedEnd: TWELVE, fileLength: BigInt(bytes.length) })
	}
	const map = readMap(bytes, view)
	if (!Array.isArray(map)) return map
	const parsed = parseRecognizedSections(bytes, map)
	if ('kind' in parsed) return parsed
	const file = createValidatedBTrack(parsed.semantics, parsed.sections, bytes)
	return {
		kind: 'accepted',
		semantics: parsed.semantics,
		identity: identifyValidatedBTrack(file),
	}
}
