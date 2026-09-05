import { MidiData, writeMidi } from '@geomitron/midi-file'

import { CanonicalTrackSemantics, identifyCanonicalTrack } from 'src/chart/identity/btrack-20260801'
import { noteFlags, noteTypes } from 'src/chart/types'
import { defaultMetadata } from 'src/ini/metadata'
import { Difficulty, Instrument } from 'src/types'

export const resolvedModifiers = {
	song_length: defaultMetadata.song_length,
	hopo_frequency: defaultMetadata.hopo_frequency,
	eighthnote_hopo: defaultMetadata.eighthnote_hopo,
	multiplier_note: defaultMetadata.multiplier_note,
	sustain_cutoff_threshold: defaultMetadata.sustain_cutoff_threshold,
	chord_snap_threshold: defaultMetadata.chord_snap_threshold,
	five_lane_drums: defaultMetadata.five_lane_drums,
	pro_drums: defaultMetadata.pro_drums,
}

export interface AuthoredSourceCase {
	readonly id: string
	readonly purpose: string
	readonly format: 'chart' | 'mid'
	readonly bytes: Uint8Array
	readonly target: { readonly instrument: Instrument; readonly difficulty: Difficulty }
}

export interface AuthoredPhysicalCase {
	readonly id: string
	readonly purpose: string
	readonly expected: 'accepted' | 'rejected'
	readonly bytes: Uint8Array
}

function chart(sections: Record<string, readonly string[]>): Uint8Array {
	const lines: string[] = []
	for (const [name, values] of Object.entries(sections)) {
		lines.push(`[${name}]`, '{', ...values.map(value => `  ${value}`), '}')
	}
	return new TextEncoder().encode(`${lines.join('\r\n')}\r\n`)
}

type MidiEvent = MidiData['tracks'][number][number]

function midiTrack(name: string, events: readonly { tick: number; event: MidiEvent }[]): MidiData['tracks'][number] {
	const ordered = events.map((entry, sourceOrder) => ({ ...entry, sourceOrder }))
		.sort((left, right) => left.tick - right.tick || left.sourceOrder - right.sourceOrder)
	const result: MidiData['tracks'][number] = [{ deltaTime: 0, type: 'trackName', text: name }]
	let previousTick = 0
	for (const entry of ordered) {
		const event: MidiEvent = { ...entry.event }
		event.deltaTime = entry.tick - previousTick
		result.push(event)
		previousTick = entry.tick
	}
	result.push({ deltaTime: 0, type: 'endOfTrack' })
	return result
}

function modifierBoundaryMidi(): Uint8Array {
	const conductor: MidiData['tracks'][number] = [
		{ deltaTime: 0, type: 'trackName', text: '' },
		{ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500001 },
		{ deltaTime: 0, type: 'timeSignature', numerator: 4, denominator: 4, metronome: 24, thirtyseconds: 8 },
		{ deltaTime: 0, type: 'endOfTrack' },
	]
	const guitarEvents: { tick: number; event: MidiEvent }[] = [
		{ tick: 100, event: { deltaTime: 0, type: 'sysEx', data: [0x50, 0x53, 0, 0, 3, 1, 1, 0xf7] } },
		{ tick: 200, event: { deltaTime: 0, type: 'sysEx', data: [0x50, 0x53, 0, 0, 3, 1, 0, 0xf7] } },
		{ tick: 400, event: { deltaTime: 0, type: 'sysEx', data: [0x50, 0x53, 0, 0, 0xff, 4, 1, 0xf7] } },
		{ tick: 500, event: { deltaTime: 0, type: 'sysEx', data: [0x50, 0x53, 0, 0, 0xff, 4, 0, 0xf7] } },
		{ tick: 700, event: { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 101, velocity: 100 } },
		{ tick: 800, event: { deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: 101, velocity: 0 } },
		{ tick: 1000, event: { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 102, velocity: 100 } },
		{ tick: 1100, event: { deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: 102, velocity: 0 } },
		{ tick: 400, event: { deltaTime: 0, type: 'text', text: '[ld_range_shift 3 1 5]' } },
		{ tick: 400, event: { deltaTime: 0, type: 'text', text: '[ld_range_shift 3 3 3]' } },
		{ tick: 600, event: { deltaTime: 0, type: 'text', text: '[ld_range_shift 3 3 3]' } },
		{ tick: 650, event: { deltaTime: 0, type: 'text', text: '[ld_range_shift 3 3 0]' } },
	]
	for (const rangeStart of [100, 400, 700, 1000]) {
		for (const [index, tick] of [rangeStart, rangeStart + 50, rangeStart + 100, rangeStart + 150].entries()) {
			const noteNumber = rangeStart === 1000 && index % 2 === 1 ? 97 : 96
			guitarEvents.push(
				{ tick, event: { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber, velocity: 100 } },
				{ tick: tick + 1, event: { deltaTime: 0, type: 'noteOff', channel: 0, noteNumber, velocity: 0 } },
			)
		}
	}
	for (const tick of [400, 450, 500, 550]) {
		guitarEvents.push(
			{ tick, event: { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 } },
			{ tick: tick + 1, event: { deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 } },
		)
	}
	return new Uint8Array(writeMidi({
		header: { format: 1, numTracks: 3, ticksPerBeat: 480 },
		tracks: [conductor, midiTrack('EVENTS', []), midiTrack('PART GUITAR', guitarEvents)],
	}))
}

function rangeShiftChart(): Uint8Array {
	return chart({
		Song: ['Resolution = 192'],
		SyncTrack: ['0 = B 120001', '0 = B 130000', '0 = B 120001', '0 = TS 3', '0 = TS 4'],
		Events: [],
		EasySingle: ['0 = N 0 0', '100 = E "ld_range_shift 0 1"'],
		MediumDoubleBass: ['0 = N 0 0', '100 = E "ld_range_shift 1 2"'],
		HardDoubleRhythm: ['0 = N 0 0', '100 = E "ld_range_shift 2 1"'],
		ExpertDoubleGuitar: ['0 = N 0 0', '100 = E "ld_range_shift 3 1 5"'],
		ExpertKeyboard: [
			'0 = N 0 0',
			'50 = E "ld_range_shift"',
			'60 = E "ld_range_shift 9 1 3"',
			'70 = E "ld_range_shift 2 1 3"',
			'100 = E "ld_range_shift 3 1 5"',
			'100 = E "ld_range_shift 3 3 3"',
			'200 = E "ld_range_shift 3 3 3"',
			'250 = E "ld_range_shift 3 3 0"',
		],
		ExpertDrums: ['0 = N 1 0', '100 = E "ld_range_shift 3 1 5"'],
	})
}

function storedRangeBoundaryChart(): Uint8Array {
	return chart({
		Song: ['Resolution = 192'],
		SyncTrack: ['0 = B 120000', '0 = TS 4'],
		Events: [],
		ExpertDrums: [
			'0 = S 2 100', '100 = N 1 0',
			'200 = S 2 100', '299 = N 1 0',
			'400 = E "solo"', '500 = E "soloend"', '501 = N 1 0',
			'600 = E "solo"', '700 = E "soloend"', '700 = N 1 0',
			'800 = S 65 100', '900 = N 1 0',
			'1000 = S 66 100', '1101 = N 1 0',
			'1200 = S 64 100', '1300 = N 1 0',
			'1400 = S 64 100', '1501 = N 1 0',
		],
	})
}

export const sourceCases: readonly AuthoredSourceCase[] = [
	{
		id: 'source-chart-minimal-unaffected',
		purpose: 'Minimal source with no range shifts or modifier-boundary differences.',
		format: 'chart',
		bytes: chart({
			Song: ['Resolution = 192'],
			SyncTrack: ['0 = B 120000', '0 = TS 4'],
			Events: [],
			ExpertSingle: ['0 = N 0 0'],
		}),
		target: { instrument: 'guitar', difficulty: 'expert' },
	},
	{
		id: 'source-chart-range-shifts-tempo',
		purpose: 'Chart-form range shifts, defaults, same-tick precedence, redundant markers, diagnostics, and exact milli-BPM conversion.',
		format: 'chart',
		bytes: rangeShiftChart(),
		target: { instrument: 'keys', difficulty: 'expert' },
	},
	{
		id: 'source-chart-range-shifts-guitar',
		purpose: 'Chart-form range shifts on the applicable five-fret Guitar track.',
		format: 'chart',
		bytes: rangeShiftChart(),
		target: { instrument: 'guitar', difficulty: 'easy' },
	},
	{
		id: 'source-chart-range-shifts-bass',
		purpose: 'Chart-form range shifts on the applicable five-fret Bass track.',
		format: 'chart',
		bytes: rangeShiftChart(),
		target: { instrument: 'bass', difficulty: 'medium' },
	},
	{
		id: 'source-chart-range-shifts-rhythm',
		purpose: 'Chart-form range shifts on the applicable five-fret Rhythm track.',
		format: 'chart',
		bytes: rangeShiftChart(),
		target: { instrument: 'rhythm', difficulty: 'hard' },
	},
	{
		id: 'source-chart-range-shifts-guitar-coop',
		purpose: 'Chart-form range shifts on the applicable five-fret Guitar Co-op track.',
		format: 'chart',
		bytes: rangeShiftChart(),
		target: { instrument: 'guitarcoop', difficulty: 'expert' },
	},
	{
		id: 'source-midi-modifier-boundaries',
		purpose: 'Per-difficulty open, all-difficulty tap, forced-HOPO, and forced-strum boundaries plus range shifts and exact tempo conversion.',
		format: 'mid',
		bytes: modifierBoundaryMidi(),
		target: { instrument: 'guitar', difficulty: 'expert' },
	},
	{
		id: 'source-midi-all-difficulty-tap-boundary',
		purpose: 'All-difficulty tap applies to a second charted difficulty and remains active at its end tick.',
		format: 'mid',
		bytes: modifierBoundaryMidi(),
		target: { instrument: 'guitar', difficulty: 'easy' },
	},
	{
		id: 'source-chart-duplicate-overlap',
		purpose: 'Duplicate pruning and overlap correction for phrases and notes.',
		format: 'chart',
		bytes: chart({
			Song: ['Resolution = 192'],
			SyncTrack: ['0 = B 120000', '0 = TS 4'],
			Events: [],
			ExpertSingle: [
				'0 = N 0 200',
				'0 = N 0 100',
				'100 = N 0 200',
				'0 = S 2 250',
				'0 = S 2 200',
				'100 = S 2 200',
			],
		}),
		target: { instrument: 'guitar', difficulty: 'expert' },
	},
	{
		id: 'source-chart-stored-range-boundaries',
		purpose: 'Star-power and solo exclusive ends plus flex-lane and freestyle inclusive ends.',
		format: 'chart',
		bytes: storedRangeBoundaryChart(),
		target: { instrument: 'drums', difficulty: 'expert' },
	},
]

function emptySemantics(): CanonicalTrackSemantics {
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

function data(length: number, write: (view: DataView) => void): Uint8Array {
	const value = new Uint8Array(length)
	write(new DataView(value.buffer))
	return value
}

function counted(...records: Uint8Array[]): Uint8Array {
	const value = data(4 + records.reduce((total, record) => total + record.length, 0), view => view.setUint32(0, records.length, true))
	let offset = 4
	for (const record of records) { value.set(record, offset); offset += record.length }
	return value
}

function physical(sections: readonly { id: bigint; payload: Uint8Array }[]): Uint8Array {
	const mapEnd = 12 + sections.length * 20
	const value = data(sections.reduce((total, section) => total + section.payload.length, mapEnd), view => {
		view.setUint32(4, 20260801, true)
		view.setUint32(8, sections.length, true)
	})
	value.set([0x43, 0x48, 0x4e, 0x46])
	const view = new DataView(value.buffer)
	let offset = mapEnd
	sections.forEach((section, index) => {
		const entry = 12 + index * 20
		view.setBigUint64(entry, section.id, true)
		view.setBigUint64(entry + 8, BigInt(offset), true)
		view.setUint32(entry + 16, section.payload.length, true)
		value.set(section.payload, offset)
		offset += section.payload.length
	})
	return value
}

const resolution = data(4, view => view.setUint32(0, 480, true))
const resolutionOnly = identifyCanonicalTrack(emptySemantics()).physicalBTrack.bytes
const allSections = identifyCanonicalTrack({
	resolution: 480,
	tempos: [{ tick: 0n, beatsPerMinute: 119.99976000048 }],
	timeSignatures: [{ tick: 0n, numerator: 4, denominator: 4 }],
	starPower: [{ tick: 0n, length: 100n }],
	solos: [{ tick: 100n, length: 100n }],
	flexLanes: [{ tick: 200n, length: 50n, isDouble: false }, { tick: 200n, length: 50n, isDouble: true }],
	drumFreestyle: [{ tick: 300n, length: 100n, isCoda: false }],
	rangeShifts: [
		{ tick: 400n, position: 1, size: 5 },
		{ tick: 500n, position: 2, size: 4 },
		{ tick: 600n, position: 3, size: 3 },
		{ tick: 700n, position: 4, size: 2 },
	],
	notes: [
		{ tick: 0n, length: 100n, type: noteTypes.green, flags: noteFlags.strum },
		{ tick: 0n, length: 0n, type: noteTypes.red, flags: noteFlags.hopo },
		{ tick: 100n, length: 0n, type: noteTypes.green, flags: noteFlags.tap },
		{ tick: 250n, length: 0n, type: noteTypes.green, flags: noteFlags.strum },
		{ tick: 400n, length: 0n, type: noteTypes.green, flags: noteFlags.strum },
	],
}).physicalBTrack.bytes

const duplicateIds = physical([{ id: 1n, payload: resolution }, { id: 1n, payload: resolution }])
const emptyTempo = physical([{ id: 1n, payload: resolution }, { id: 2n, payload: new Uint8Array(4) }])
const negativeRange = physical([{ id: 1n, payload: resolution }, {
	id: 8n,
	payload: counted(data(24, view => {
		view.setBigInt64(0, -1n, true)
		view.setBigInt64(8, 1n, true)
		view.setBigInt64(16, 5n, true)
	})),
}])
const unknown = physical([{ id: 1n, payload: resolution }, { id: 100n, payload: new Uint8Array([0xaa, 0xbb]) }])
const trailing = new Uint8Array(resolutionOnly.length + 1)
trailing.set(resolutionOnly)

function tickRangeRecord(tick: bigint, length: bigint): Uint8Array {
	return data(16, view => {
		view.setBigInt64(0, tick, true)
		view.setBigInt64(8, length, true)
	})
}

function rangeRecord(tick: bigint, position: bigint, size: bigint): Uint8Array {
	return data(24, view => {
		view.setBigInt64(0, tick, true)
		view.setBigInt64(8, position, true)
		view.setBigInt64(16, size, true)
	})
}

function noteRecord(tick: bigint, length: bigint, type: number, flags: number): Uint8Array {
	return data(24, view => {
		view.setBigInt64(0, tick, true)
		view.setBigInt64(8, length, true)
		view.setUint32(16, type, true)
		view.setUint32(20, flags, true)
	})
}

const badMagic = resolutionOnly.slice(); badMagic[0] = 0
const unsupportedVersion = resolutionOnly.slice(); new DataView(unsupportedVersion.buffer).setUint32(4, 1, true)
const noncanonicalOffset = new Uint8Array(resolutionOnly.length + 1); noncanonicalOffset.set(resolutionOnly); new DataView(noncanonicalOffset.buffer).setBigUint64(20, 33n, true)
const outOfBounds = resolutionOnly.slice(); new DataView(outOfBounds.buffer).setUint32(28, 5, true)
const arithmeticOverflow = resolutionOnly.slice(); new DataView(arithmeticOverflow.buffer).setBigUint64(20, 0xffffffffffffffffn, true)
const missingResolution = physical([{ id: 100n, payload: new Uint8Array([1]) }])
const countLengthMismatch = physical([{ id: 1n, payload: resolution }, {
	id: 2n,
	payload: data(4, view => view.setUint32(0, 1, true)),
}])
const invalidRangeBounds = physical([{ id: 1n, payload: resolution }, { id: 8n, payload: counted(rangeRecord(0n, 3n, 4n)) }])
const duplicateRangeTick = physical([{ id: 1n, payload: resolution }, {
	id: 8n,
	payload: counted(rangeRecord(0n, 1n, 5n), rangeRecord(0n, 2n, 4n)),
}])
const invalidBoolean = physical([{ id: 1n, payload: resolution }, {
	id: 6n,
	payload: counted(data(17, view => {
		view.setBigInt64(0, 0n, true)
		view.setBigInt64(8, 1n, true)
		view.setUint8(16, 2)
	})),
}])
const invalidNoteType = physical([{ id: 1n, payload: resolution }, { id: 9n, payload: counted(noteRecord(0n, 0n, 99, noteFlags.strum)) }])
const invalidNoteFlagBits = physical([{ id: 1n, payload: resolution }, { id: 9n, payload: counted(noteRecord(0n, 0n, noteTypes.green, 0x800)) }])
const invalidNoteFlagCombination = physical([{ id: 1n, payload: resolution }, {
	id: 9n,
	payload: counted(noteRecord(0n, 0n, noteTypes.green, noteFlags.strum | noteFlags.tap)),
}])
const unorderedNotes = physical([{ id: 1n, payload: resolution }, {
	id: 9n,
	payload: counted(
		noteRecord(0n, 0n, noteTypes.red, noteFlags.strum),
		noteRecord(0n, 0n, noteTypes.green, noteFlags.strum),
	),
}])
const overlappingPhrase = physical([{ id: 1n, payload: resolution }, {
	id: 4n,
	payload: counted(tickRangeRecord(0n, 100n), tickRangeRecord(50n, 10n)),
}])
const overlappingNote = physical([{ id: 1n, payload: resolution }, {
	id: 9n,
	payload: counted(
		noteRecord(0n, 100n, noteTypes.green, noteFlags.strum),
		noteRecord(50n, 10n, noteTypes.green, noteFlags.strum),
	),
}])
const oneTempo = counted(data(16, view => {
	view.setBigInt64(0, 0n, true)
	view.setFloat64(8, 120, true)
}))
const descendingIds = physical([{ id: 2n, payload: oneTempo }, { id: 1n, payload: resolution }])
const canonicalTwoSections = physical([{ id: 1n, payload: resolution }, { id: 2n, payload: oneTempo }])
const reorderedPayloads = canonicalTwoSections.slice()
new DataView(reorderedPayloads.buffer).setBigUint64(20, 56n, true)
new DataView(reorderedPayloads.buffer).setBigUint64(40, 52n, true)
const overlappingPayloads = canonicalTwoSections.slice()
new DataView(overlappingPayloads.buffer).setBigUint64(40, 54n, true)
const emptyStarPower = physical([{ id: 1n, payload: resolution }, { id: 4n, payload: counted(tickRangeRecord(0n, 100n)) }])
const emptySolo = physical([{ id: 1n, payload: resolution }, { id: 5n, payload: counted(tickRangeRecord(0n, 100n)) }])
const emptyFlex = physical([{ id: 1n, payload: resolution }, {
	id: 6n,
	payload: counted(data(17, view => view.setBigInt64(8, 100n, true))),
}])
const emptyFreestyle = physical([{ id: 1n, payload: resolution }, {
	id: 7n,
	payload: counted(data(17, view => view.setBigInt64(8, 100n, true))),
}])

export const physicalCases: readonly AuthoredPhysicalCase[] = [
	{ id: 'physical-resolution-only', purpose: 'Mandatory Resolution with every empty optional section omitted.', expected: 'accepted', bytes: resolutionOnly },
	{ id: 'physical-all-sections', purpose: 'Every recognized section and four representative stored range shapes.', expected: 'accepted', bytes: allSections },
	{ id: 'physical-unknown-section', purpose: 'Unknown physical section excluded from semantics and TrackHash.', expected: 'accepted', bytes: unknown },
	{ id: 'physical-reject-duplicate-ids', purpose: 'Duplicate section IDs are malformed.', expected: 'rejected', bytes: duplicateIds },
	{ id: 'physical-reject-empty-optional', purpose: 'A zero-count optional recognized section is malformed.', expected: 'rejected', bytes: emptyTempo },
	{ id: 'physical-reject-negative-range', purpose: 'Negative signed range data is malformed.', expected: 'rejected', bytes: negativeRange },
	{ id: 'physical-reject-trailing-byte', purpose: 'Physical padding and trailing bytes are malformed.', expected: 'rejected', bytes: trailing },
	{ id: 'physical-reject-truncated-header', purpose: 'A file shorter than the shared header is malformed.', expected: 'rejected', bytes: resolutionOnly.slice(0, 7) },
	{ id: 'physical-reject-bad-magic', purpose: 'A non-CHNF magic value is malformed.', expected: 'rejected', bytes: badMagic },
	{ id: 'physical-reject-version', purpose: 'An unsupported physical version is rejected.', expected: 'rejected', bytes: unsupportedVersion },
	{ id: 'physical-reject-truncated-map', purpose: 'A truncated section map is malformed.', expected: 'rejected', bytes: resolutionOnly.slice(0, 31) },
	{ id: 'physical-reject-noncanonical-offset', purpose: 'A physical gap is rejected instead of normalized.', expected: 'rejected', bytes: noncanonicalOffset },
	{ id: 'physical-reject-out-of-bounds', purpose: 'A section range beyond the file is malformed.', expected: 'rejected', bytes: outOfBounds },
	{ id: 'physical-reject-offset-overflow', purpose: 'Checked section-range arithmetic rejects uint64 overflow.', expected: 'rejected', bytes: arithmeticOverflow },
	{ id: 'physical-reject-missing-resolution', purpose: 'Resolution is mandatory even when unknown sections are present.', expected: 'rejected', bytes: missingResolution },
	{ id: 'physical-reject-count-length', purpose: 'A recognized count and payload-length mismatch is malformed.', expected: 'rejected', bytes: countLengthMismatch },
	{ id: 'physical-reject-range-bounds', purpose: 'Range position and size must stay within five lanes.', expected: 'rejected', bytes: invalidRangeBounds },
	{ id: 'physical-reject-duplicate-range-tick', purpose: 'Physical range records must have strictly increasing ticks.', expected: 'rejected', bytes: duplicateRangeTick },
	{ id: 'physical-reject-boolean', purpose: 'Boolean record bytes must be zero or one.', expected: 'rejected', bytes: invalidBoolean },
	{ id: 'physical-reject-note-type', purpose: 'Unknown NoteType values are malformed.', expected: 'rejected', bytes: invalidNoteType },
	{ id: 'physical-reject-note-flag-bits', purpose: 'Unknown NoteFlags bits are malformed.', expected: 'rejected', bytes: invalidNoteFlagBits },
	{ id: 'physical-reject-note-flag-combination', purpose: 'Mutually exclusive attack flags cannot coexist.', expected: 'rejected', bytes: invalidNoteFlagCombination },
	{ id: 'physical-reject-note-order', purpose: 'Same-tick notes must use ascending NoteType order.', expected: 'rejected', bytes: unorderedNotes },
	{ id: 'physical-reject-phrase-overlap', purpose: 'Canonical phrase records cannot overlap.', expected: 'rejected', bytes: overlappingPhrase },
	{ id: 'physical-reject-note-overlap', purpose: 'Canonical notes of the same type cannot overlap.', expected: 'rejected', bytes: overlappingNote },
	{ id: 'physical-reject-descending-ids', purpose: 'Descending section IDs are malformed.', expected: 'rejected', bytes: descendingIds },
	{ id: 'physical-reject-reordered-payloads', purpose: 'Payload order must follow strict section ID order.', expected: 'rejected', bytes: reorderedPayloads },
	{ id: 'physical-reject-overlapping-payloads', purpose: 'Overlapping physical section ranges are malformed.', expected: 'rejected', bytes: overlappingPayloads },
	{ id: 'physical-reject-empty-star-power', purpose: 'A star-power phrase without notes is noncanonical.', expected: 'rejected', bytes: emptyStarPower },
	{ id: 'physical-reject-empty-solo', purpose: 'A solo phrase without notes is noncanonical.', expected: 'rejected', bytes: emptySolo },
	{ id: 'physical-reject-empty-flex', purpose: 'A flex lane without notes is noncanonical.', expected: 'rejected', bytes: emptyFlex },
	{ id: 'physical-empty-freestyle', purpose: 'A freestyle range without notes remains canonical and hash-relevant.', expected: 'accepted', bytes: emptyFreestyle },
]
