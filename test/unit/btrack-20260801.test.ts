import { describe, expect, it } from 'vitest'

import {
	CanonicalTrackSemantics,
	identifyCanonicalTrack,
	readBTrack20260801,
} from 'src/chart/identity/btrack-20260801'
import { noteFlags, noteTypes } from 'src/chart/types'

function emptyTrack(): CanonicalTrackSemantics {
	return {
		resolution: 480,
		tempos: [],
		timeSignatures: [],
		starPower: [],
		solos: [],
		flexLanes: [],
		drumFreestyle: [],
		rangeShifts: [],
		notes: [],
	}
}

function bytes(length: number, write: (view: DataView) => void): Uint8Array {
	const result = new Uint8Array(length)
	write(new DataView(result.buffer))
	return result
}

function counted(...records: Uint8Array[]): Uint8Array {
	const length = 4 + records.reduce((total, record) => total + record.length, 0)
	const result = bytes(length, view => view.setUint32(0, records.length, true))
	let offset = 4
	for (const record of records) {
		result.set(record, offset)
		offset += record.length
	}
	return result
}

function physical(sections: readonly { id: bigint; payload: Uint8Array }[]): Uint8Array {
	const mapEnd = 12 + sections.length * 20
	const length = sections.reduce((total, section) => total + section.payload.length, mapEnd)
	const result = bytes(length, view => {
		view.setUint32(4, 20260801, true)
		view.setUint32(8, sections.length, true)
	})
	result.set([0x43, 0x48, 0x4e, 0x46])
	const view = new DataView(result.buffer)
	let payloadOffset = mapEnd
	sections.forEach((section, index) => {
		const mapOffset = 12 + index * 20
		view.setBigUint64(mapOffset, section.id, true)
		view.setBigUint64(mapOffset + 8, BigInt(payloadOffset), true)
		view.setUint32(mapOffset + 16, section.payload.length, true)
		result.set(section.payload, payloadOffset)
		payloadOffset += section.payload.length
	})
	return result
}

const resolution = bytes(4, view => view.setUint32(0, 480, true))

function expectRejectedCode(input: Uint8Array, code: string): void {
	const read = readBTrack20260801(input)
	expect(read.kind).toBe('rejected')
	if (read.kind !== 'rejected') return
	expect(read.errors[0].code).toBe(code)
}

describe('CHNF/20260801', () => {
	it('writes the canonical resolution-only physical file', () => {
		const identity = identifyCanonicalTrack(emptyTrack())

		expect(Buffer.from(identity.physicalBTrack.bytes).toString('hex')).toBe(
			'43484e46c127350101000000' +
			'0100000000000000200000000000000004000000' +
			'e0010000',
		)
		expect(Buffer.from(identity.projection.bytes).toString('hex')).toBe(
			'010000000100000000000000e0010000',
		)
	})

	it('matches the approved map-first Resolution plus Note vector', () => {
		const identity = identifyCanonicalTrack({
			...emptyTrack(),
			notes: [{ tick: 0n, length: 0n, type: noteTypes.green, flags: noteFlags.strum }],
		})

		expect(Buffer.from(identity.projection.bytes).toString('hex')).toBe(
			'02000000' +
			'0100000000000000' +
			'0900000000000000' +
			'e0010000' +
			'01000000' +
			'0000000000000000' +
			'0000000000000000' +
			'02000000' +
			'01000000',
		)
		expect(identity.trackHash.value).toBe('13JYxJsrPorW6wRaFdq_PakAfaPuhUzS2wqxKkjH0dc')
	})

	it('reads its own physical bytes before calculating identity', () => {
		const written = identifyCanonicalTrack({
			...emptyTrack(),
			rangeShifts: [{ tick: 100n, position: 3, size: 3 }],
		})
		const read = readBTrack20260801(written.physicalBTrack.bytes)

		expect(read.kind).toBe('accepted')
		if (read.kind !== 'accepted') return
		expect(read.semantics).toEqual({
			...emptyTrack(),
			rangeShifts: [{ tick: 100n, position: 3, size: 3 }],
		})
		expect(read.identity.trackHash.value).toBe(written.trackHash.value)
	})

	it('round-trips every recognized section and valid same-tick records', () => {
		const semantics: CanonicalTrackSemantics = {
			resolution: 480,
			tempos: [{ tick: 0n, beatsPerMinute: 119.99976000048 }],
			timeSignatures: [{ tick: 0n, numerator: 4, denominator: 4 }],
			starPower: [{ tick: 0n, length: 100n }],
			solos: [{ tick: 100n, length: 100n }],
			flexLanes: [
				{ tick: 200n, length: 50n, isDouble: false },
				{ tick: 200n, length: 50n, isDouble: true },
			],
			drumFreestyle: [
				{ tick: 300n, length: 100n, isCoda: false },
				{ tick: 300n, length: 50n, isCoda: true },
			],
			rangeShifts: [{ tick: 400n, position: 3, size: 3 }],
			notes: [
				{ tick: 0n, length: 100n, type: noteTypes.green, flags: noteFlags.strum },
				{ tick: 0n, length: 0n, type: noteTypes.red, flags: noteFlags.hopo },
				{ tick: 100n, length: 0n, type: noteTypes.green, flags: noteFlags.tap },
				{ tick: 250n, length: 0n, type: noteTypes.green, flags: noteFlags.strum },
				{ tick: 350n, length: 0n, type: noteTypes.green, flags: noteFlags.strum },
				{ tick: 400n, length: 0n, type: noteTypes.green, flags: noteFlags.strum },
			],
		}

		const identity = identifyCanonicalTrack(semantics)
		const read = readBTrack20260801(identity.physicalBTrack.bytes)

		expect(read.kind).toBe('accepted')
		if (read.kind !== 'accepted') return
		expect(read.semantics).toEqual(semantics)
	})

	it('rejects a physical offset variation instead of normalizing it', () => {
		const bytes = identifyCanonicalTrack(emptyTrack()).physicalBTrack.bytes
		const changed = new Uint8Array(bytes.length + 1)
		changed.set(bytes)
		new DataView(changed.buffer).setBigUint64(20, 33n, true)

		const read = readBTrack20260801(changed)
		expect(read).toEqual({
			kind: 'rejected',
			errors: [{
				code: 'sectionOffsetNoncanonical',
				sectionId: 1n,
				expected: 32n,
				actual: 33n,
			}],
		})
	})

	it('ignores unknown sections for semantics and TrackHash', () => {
		const input = physical([
			{ id: 1n, payload: resolution },
			{ id: 100n, payload: new Uint8Array([0xaa, 0xbb]) },
		])
		const read = readBTrack20260801(input)
		const baseline = identifyCanonicalTrack(emptyTrack())

		expect(read.kind).toBe('accepted')
		if (read.kind !== 'accepted') return
		expect(read.semantics).toEqual(emptyTrack())
		expect(read.identity.trackHash.value).toBe(baseline.trackHash.value)
		expect(read.identity.projection.bytes).toEqual(baseline.projection.bytes)
		expect(read.identity.physicalBTrack.bytes).toEqual(input)
	})

	it('prunes empty phrases but preserves freestyle ranges without notes', () => {
		expect(() => identifyCanonicalTrack({
			...emptyTrack(),
			flexLanes: [{ tick: 0n, length: 100n, isDouble: false }],
		})).toThrow('flex lane ranges must contain a note')

		const emptySolo = physical([
			{ id: 1n, payload: resolution },
			{ id: 5n, payload: counted(bytes(16, view => view.setBigInt64(8, 100n, true))) },
		])
		expect(readBTrack20260801(emptySolo)).toEqual({
			kind: 'rejected',
			errors: [{
				code: 'recordValueInvalid',
				sectionId: 5n,
				recordIndex: 0,
				field: 'length',
				reason: 'containsNoNotes',
			}],
		})

		const freestyle = identifyCanonicalTrack({
			...emptyTrack(),
			drumFreestyle: [{ tick: 0n, length: 100n, isCoda: false }],
		})
		const read = readBTrack20260801(freestyle.physicalBTrack.bytes)
		expect(read.kind).toBe('accepted')
		if (read.kind !== 'accepted') return
		expect(read.semantics.drumFreestyle).toEqual([
			{ tick: 0n, length: 100n, isCoda: false },
		])
	})

	it('rejects malformed physical files before identity', () => {
		const canonical = identifyCanonicalTrack(emptyTrack()).physicalBTrack.bytes
		const badMagic = canonical.slice()
		badMagic[0] = 0
		const badVersion = canonical.slice()
		new DataView(badVersion.buffer).setUint32(4, 1, true)
		const trailing = new Uint8Array(canonical.length + 1)
		trailing.set(canonical)

		const negativeRange = counted(bytes(24, view => {
			view.setBigInt64(0, -1n, true)
			view.setBigInt64(8, 1n, true)
			view.setBigInt64(16, 5n, true)
		}))
		const outOfBoundsRange = counted(bytes(24, view => {
			view.setBigInt64(0, 0n, true)
			view.setBigInt64(8, 3n, true)
			view.setBigInt64(16, 4n, true)
		}))
		const invalidFlexBoolean = counted(bytes(17, view => {
			view.setBigInt64(0, 0n, true)
			view.setBigInt64(8, 1n, true)
			view.setUint8(16, 2)
		}))
		const invalidNoteType = counted(bytes(24, view => {
			view.setBigInt64(0, 0n, true)
			view.setBigInt64(8, 0n, true)
			view.setUint32(16, 99, true)
			view.setUint32(20, noteFlags.strum, true)
		}))
		const invalidNoteFlags = counted(bytes(24, view => {
			view.setBigInt64(0, 0n, true)
			view.setBigInt64(8, 0n, true)
			view.setUint32(16, noteTypes.green, true)
			view.setUint32(20, 0x800, true)
		}))
		const duplicateTempos = counted(
			bytes(16, view => { view.setBigInt64(0, 0n, true); view.setFloat64(8, 120, true) }),
			bytes(16, view => { view.setBigInt64(0, 0n, true); view.setFloat64(8, 130, true) }),
		)

		const cases: readonly [Uint8Array, string][] = [
			[new Uint8Array(7), 'headerTruncated'],
			[badMagic, 'magicInvalid'],
			[badVersion, 'physicalVersionUnsupported'],
			[canonical.slice(0, 31), 'sectionMapTruncated'],
			[physical([{ id: 1n, payload: resolution }, { id: 1n, payload: resolution }]), 'sectionIdsNotStrictlyIncreasing'],
			[trailing, 'trailingBytes'],
			[physical([{ id: 100n, payload: new Uint8Array([1]) }]), 'resolutionMissing'],
			[physical([{ id: 1n, payload: new Uint8Array(3) }]), 'recognizedPayloadLengthInvalid'],
			[physical([{ id: 1n, payload: resolution }, { id: 2n, payload: new Uint8Array(4) }]), 'emptyOptionalSection'],
			[physical([{ id: 1n, payload: resolution }, { id: 8n, payload: negativeRange }]), 'recordValueInvalid'],
			[physical([{ id: 1n, payload: resolution }, { id: 8n, payload: outOfBoundsRange }]), 'recordValueInvalid'],
			[physical([{ id: 1n, payload: resolution }, { id: 6n, payload: invalidFlexBoolean }]), 'recordValueInvalid'],
			[physical([{ id: 1n, payload: resolution }, { id: 9n, payload: invalidNoteType }]), 'recordValueInvalid'],
			[physical([{ id: 1n, payload: resolution }, { id: 9n, payload: invalidNoteFlags }]), 'recordValueInvalid'],
			[physical([{ id: 1n, payload: resolution }, { id: 2n, payload: duplicateTempos }]), 'recordValueInvalid'],
		]

		for (const [input, code] of cases) expectRejectedCode(input, code)
	})

	it('accepts overlapping flex lanes of the same type, as the BTrack spec allows', () => {
		const semantics: CanonicalTrackSemantics = {
			...emptyTrack(),
			flexLanes: [
				{ tick: 0n, length: 768n, isDouble: false },
				{ tick: 0n, length: 100n, isDouble: true },
				{ tick: 50n, length: 100n, isDouble: true },
				{ tick: 384n, length: 768n, isDouble: false },
			],
			notes: [
				{ tick: 0n, length: 0n, type: noteTypes.redDrum, flags: noteFlags.tom },
				{ tick: 100n, length: 0n, type: noteTypes.redDrum, flags: noteFlags.tom },
				{ tick: 400n, length: 0n, type: noteTypes.redDrum, flags: noteFlags.tom },
			],
		}
		const identity = identifyCanonicalTrack(semantics)
		const read = readBTrack20260801(identity.physicalBTrack.bytes)
		expect(read.kind).toBe('accepted')
		if (read.kind !== 'accepted') return
		expect(read.semantics).toEqual(semantics)
		expect(read.identity.trackHash.value).toBe(identity.trackHash.value)
	})

	it('still requires flex lanes in tick order with single before double and no repeated tick and type', () => {
		const note = { tick: 0n, length: 0n, type: noteTypes.redDrum, flags: noteFlags.tom }
		const lanes = (flexLanes: CanonicalTrackSemantics['flexLanes']) => () => identifyCanonicalTrack({ ...emptyTrack(), flexLanes, notes: [note] })
		expect(lanes([{ tick: 0n, length: 10n, isDouble: true }, { tick: 0n, length: 10n, isDouble: false }])).toThrow('single before double')
		expect(lanes([{ tick: 0n, length: 10n, isDouble: false }, { tick: 0n, length: 20n, isDouble: false }])).toThrow('single before double')

		const lane = (tick: bigint, isDouble: number) => bytes(17, view => {
			view.setBigInt64(0, tick, true)
			view.setBigInt64(8, 10n, true)
			view.setUint8(16, isDouble)
		})
		const notes = counted(bytes(24, view => {
			view.setUint32(16, noteTypes.redDrum, true)
			view.setUint32(20, noteFlags.tom, true)
		}))
		expectRejectedCode(physical([{ id: 1n, payload: resolution }, { id: 6n, payload: counted(lane(0n, 0), lane(0n, 0)) }, { id: 9n, payload: notes }]),
			'recordValueInvalid')
	})

	it('rejects accents and ghosts on kicks, which have no dynamics', () => {
		for (const flag of [noteFlags.accent, noteFlags.ghost]) {
			const writeKick = () => identifyCanonicalTrack({ ...emptyTrack(), notes: [{ tick: 0n, length: 0n, type: noteTypes.kick, flags: flag }] })
			expect(writeKick).toThrow('note flags are invalid')
			const kick = counted(bytes(24, view => {
				view.setUint32(16, noteTypes.kick, true)
				view.setUint32(20, flag, true)
			}))
			expectRejectedCode(physical([{ id: 1n, payload: resolution }, { id: 9n, payload: kick }]), 'recordValueInvalid')
		}
		const pad = { tick: 0n, length: 0n, type: noteTypes.redDrum, flags: noteFlags.accent | noteFlags.tom }
		expect(() => identifyCanonicalTrack({ ...emptyTrack(), notes: [pad] })).not.toThrow()
	})
})
