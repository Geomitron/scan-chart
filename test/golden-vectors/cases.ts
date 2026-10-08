import { MidiData, writeMidi } from '@geomitron/midi-file'

import { CanonicalTrackSemantics, identifyCanonicalTrack } from 'src/chart/identity/btrack-20260801'
import { IniChartModifiers, noteFlags, noteTypes } from 'src/chart/types'
import { defaultMetadata } from 'src/ini/metadata'
import { Difficulty, Instrument } from 'src/types'

/*
 * The authored cases of the next suite, v3: the canonical `canonical-20260801` profile only. Approved suites are
 * frozen in `suites/`; changing a case here changes only drafts generated from now on.
 */

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
	/** The resolved chart modifiers; the defaults when omitted. */
	readonly modifiers?: IniChartModifiers
}

export interface AuthoredPhysicalCase {
	readonly id: string
	readonly purpose: string
	readonly expected: 'accepted' | 'rejected'
	readonly bytes: Uint8Array
}

/** A song folder: its notes file or files and an optional song.ini, by file name. */
export interface AuthoredSongCase {
	readonly id: string
	readonly purpose: string
	readonly files: readonly { readonly name: string; readonly bytes: Uint8Array }[]
}

function chart(sections: Record<string, readonly string[]>): Uint8Array {
	const lines: string[] = []
	for (const [name, values] of Object.entries(sections)) {
		lines.push(`[${name}]`, '{', ...values.map(value => `  ${value}`), '}')
	}
	return new TextEncoder().encode(`${lines.join('\r\n')}\r\n`)
}

type MidiEvent = MidiData['tracks'][number][number]

/** A track whose tick-0 track names are `names`, in order, then `events` sorted by tick and then by listed order. */
function midiTrack(names: string | readonly string[], events: readonly { tick: number; event: MidiEvent }[]): MidiData['tracks'][number] {
	const ordered = events.map((entry, sourceOrder) => ({ ...entry, sourceOrder }))
		.sort((left, right) => left.tick - right.tick || left.sourceOrder - right.sourceOrder)
	const result: MidiData['tracks'][number] = (typeof names === 'string' ? [names] : names)
		.map((text): MidiEvent => ({ deltaTime: 0, type: 'trackName', text }))
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
		id: 'source-chart-duplicate-overlap-sorted',
		purpose: 'Duplicate pruning and overlap correction for phrases and notes, with every line in tick order.',
		format: 'chart',
		bytes: chart({
			Song: ['Resolution = 192'],
			SyncTrack: ['0 = B 120000', '0 = TS 4'],
			Events: [],
			ExpertSingle: [
				'0 = N 0 200',
				'0 = N 0 100',
				'0 = S 2 250',
				'0 = S 2 200',
				'100 = N 0 200',
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
	...quotedEventCases(),
	...flexLaneCases(),
	...chartDynamicsCases(),
	...drumMarkerCases(),
	...discoCases(),
	...syncTrackAndInstrumentCases(),
]

function note(tick: number, noteNumber: number, length: number, velocity = 100): { tick: number; event: MidiEvent }[] {
	return [
		{ tick, event: { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber, velocity } },
		{ tick: tick + length, event: { deltaTime: 0, type: 'noteOff', channel: 0, noteNumber, velocity: 0 } },
	]
}

function textEvent(tick: number, text: string): { tick: number; event: MidiEvent } {
	return { tick, event: { deltaTime: 0, type: 'text', text } }
}

/** A format-1 MIDI file whose track 0 is `conductor`: by default 120 BPM and 4/4 at tick 0. */
function midi(tracks: readonly MidiData['tracks'][number][], ticksPerBeat = 480, conductor?: MidiData['tracks'][number]): Uint8Array {
	const tempoTrack: MidiData['tracks'][number] = conductor ?? [
		{ deltaTime: 0, type: 'trackName', text: '' },
		{ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 },
		{ deltaTime: 0, type: 'timeSignature', numerator: 4, denominator: 4, metronome: 24, thirtyseconds: 8 },
		{ deltaTime: 0, type: 'endOfTrack' },
	]
	return new Uint8Array(writeMidi({
		header: { format: 1, numTracks: tracks.length + 1, ticksPerBeat },
		tracks: [tempoTrack, ...tracks],
	}))
}

/** C6: a quoted `.chart` track event reads the same as the unquoted one, so each pair has one TrackHash. */
function quotedEventCases(): AuthoredSourceCase[] {
	const guitar = (expertQuoted: boolean, code: number) => {
		const event = (text: string) => expertQuoted ? `E "${text}"` : `E ${text}`
		return [
			'0 = N 0 0',
			`96 = ${event(`ld_range_shift ${code} 2 4`)}`,
			`192 = ${event('solo')}`,
			'192 = N 1 0',
			'384 = N 2 0',
			`576 = ${event('soloend')}`,
			'576 = N 3 0',
			'768 = N 4 0',
		]
	}
	const drums = (quoted: boolean, code: number) => {
		const event = (text: string) => quoted ? `E "${text}"` : `E ${text}`
		return [
			'0 = N 1 0', '0 = N 2 0',
			`192 = ${event(`[mix ${code} drums0d]`)}`, '192 = N 1 0', '192 = N 2 0',
			'384 = N 1 0', '384 = N 2 0',
			`576 = ${event(`[mix ${code} drums0]`)}`, '576 = N 1 0', '576 = N 2 0',
		]
	}
	const bytes = chart({
		Song: ['Resolution = 192'],
		SyncTrack: ['0 = B 120000', '0 = TS 4'],
		Events: [],
		ExpertSingle: guitar(true, 3),
		HardSingle: guitar(false, 2),
		ExpertDrums: drums(true, 3),
		HardDrums: drums(false, 2),
	})
	return [
		{
			id: 'source-chart-quoted-solo-and-range-shift',
			purpose: 'Quoted E "solo", E "soloend" and E "ld_range_shift 3 2 4" read like their unquoted forms; same TrackHash as source-chart-unquoted-solo-and-range-shift.',
			format: 'chart',
			bytes,
			target: { instrument: 'guitar', difficulty: 'expert' },
		},
		{
			id: 'source-chart-unquoted-solo-and-range-shift',
			purpose: 'Unquoted E solo, E soloend and E ld_range_shift 2 2 4, the control for the quoted forms.',
			format: 'chart',
			bytes,
			target: { instrument: 'guitar', difficulty: 'hard' },
		},
		{
			id: 'source-chart-quoted-mix-events',
			purpose: 'Quoted E "[mix 3 drums0d]" and E "[mix 3 drums0]" read like their unquoted forms; same TrackHash as source-chart-unquoted-mix-events.',
			format: 'chart',
			bytes,
			target: { instrument: 'drums', difficulty: 'expert' },
		},
		{
			id: 'source-chart-unquoted-mix-events',
			purpose: 'Unquoted E [mix 2 drums0d] and E [mix 2 drums0], the control for the quoted forms.',
			format: 'chart',
			bytes,
			target: { instrument: 'drums', difficulty: 'hard' },
		},
	]
}

/** C7: flex lanes keep overlaps, keep the longest same-tick duplicate of a type, and order single before double. */
function flexLaneCases(): AuthoredSourceCase[] {
	return [{
		id: 'source-chart-flex-lane-overlaps',
		purpose: 'Overlapping single-roll lanes both remain; same-tick duplicates of one type keep the longest; a single and a double lane on one tick are ordered single first; a lane without notes is dropped.',
		format: 'chart',
		bytes: chart({
			Song: ['Resolution = 192'],
			SyncTrack: ['0 = B 120000', '0 = TS 4'],
			Events: [],
			ExpertDrums: [
				'0 = N 1 0', '0 = S 65 768',
				'192 = N 1 0',
				'384 = N 1 0', '384 = S 65 768',
				'576 = N 1 0',
				'768 = N 1 0',
				'1152 = N 1 0',
				'1536 = S 65 96', '1536 = S 66 192', '1536 = S 65 192', '1536 = N 2 0',
				'1920 = S 65 96',
				'2304 = N 1 0',
			],
		}),
		target: { instrument: 'drums', difficulty: 'expert' },
	}]
}

/** Yellow Expert (98) and Hard (86) notes, with `[ENABLE_CHART_DYNAMICS]` at `eventTick`, before or after a same-tick note. */
function dynamicsMidi(eventTick: number, eventBeforeNotes: boolean): Uint8Array {
	const events: { tick: number; event: MidiEvent }[] = []
	for (const [tick, velocity] of [[0, 127], [480, 1], [1920, 127], [2400, 1]]) {
		if (tick === eventTick && eventBeforeNotes) events.push(textEvent(tick, '[ENABLE_CHART_DYNAMICS]'))
		events.push(...note(tick, 98, 60, velocity), ...note(tick, 86, 60, velocity))
		if (tick === eventTick && !eventBeforeNotes) events.push(textEvent(tick, '[ENABLE_CHART_DYNAMICS]'))
	}
	if (![0, 480, 1920, 2400].includes(eventTick)) events.push(textEvent(eventTick, '[ENABLE_CHART_DYNAMICS]'))
	return midi([midiTrack('PART DRUMS', events)])
}

/** C8: `[ENABLE_CHART_DYNAMICS]` applies from its event onward on every difficulty; `.chart` dynamics need no event. */
function chartDynamicsCases(): AuthoredSourceCase[] {
	const late = dynamicsMidi(1440, true)
	return [
		{
			id: 'source-midi-late-chart-dynamics-expert',
			purpose: 'A late [ENABLE_CHART_DYNAMICS] makes velocity 127 and 1 accents and ghosts only on Expert notes after the event.',
			format: 'mid',
			bytes: late,
			target: { instrument: 'drums', difficulty: 'expert' },
		},
		{
			id: 'source-midi-late-chart-dynamics-hard',
			purpose: 'The same late event applies to Hard from the event onward too, not to the whole difficulty.',
			format: 'mid',
			bytes: late,
			target: { instrument: 'drums', difficulty: 'hard' },
		},
		{
			id: 'source-midi-chart-dynamics-before-same-tick-note',
			purpose: '[ENABLE_CHART_DYNAMICS] listed before the note-ons of its own tick applies to those notes.',
			format: 'mid',
			bytes: dynamicsMidi(1920, true),
			target: { instrument: 'drums', difficulty: 'expert' },
		},
		{
			id: 'source-midi-chart-dynamics-after-same-tick-note',
			purpose: '[ENABLE_CHART_DYNAMICS] listed after the note-ons of its own tick applies only to later notes.',
			format: 'mid',
			bytes: dynamicsMidi(1920, false),
			target: { instrument: 'drums', difficulty: 'expert' },
		},
		{
			id: 'source-chart-dynamics-without-event',
			purpose: '.chart accent (N 35) and ghost (N 41) modifiers apply without any [ENABLE_CHART_DYNAMICS] event.',
			format: 'chart',
			bytes: chart({
				Song: ['Resolution = 480'],
				SyncTrack: ['0 = B 120000', '0 = TS 4'],
				Events: [],
				ExpertDrums: ['0 = N 2 0', '0 = N 35 0', '1920 = N 2 0', '1920 = N 41 0'],
			}),
			target: { instrument: 'drums', difficulty: 'expert' },
		},
	]
}

/** C9: a MIDI tom marker makes the chart pro drums only if it covers a note, kicks included, with an exclusive end. */
function drumMarkerCases(): AuthoredSourceCase[] {
	const drums = (notes: readonly (readonly [number, number])[], marker: readonly [number, number]) => midi([midiTrack('PART DRUMS', [
		...notes.flatMap(([tick, noteNumber]) => note(tick, noteNumber, 60)),
		...note(marker[0], 110, marker[1] - marker[0]),
	])])
	return [
		{
			id: 'source-midi-tom-marker-covering-no-notes',
			purpose: 'A yellow tom marker whose range holds no note (a note sits on its exclusive end) leaves the chart four-lane, so every pad is a tom.',
			format: 'mid',
			bytes: drums([[0, 97], [480, 98], [960, 99], [1440, 100]], [1000, 1440]),
			target: { instrument: 'drums', difficulty: 'expert' },
		},
		{
			id: 'source-midi-tom-marker-covering-a-kick',
			purpose: 'A tom marker covering only a kick makes the chart pro drums, so the uncovered yellow notes are cymbals.',
			format: 'mid',
			bytes: drums([[0, 98], [480, 98], [960, 96]], [960, 1200]),
			target: { instrument: 'drums', difficulty: 'expert' },
		},
		{
			id: 'source-midi-tom-marker-covering-a-note',
			purpose: 'A tom marker covering a yellow note makes the chart pro drums: the covered yellow is a tom and the next is a cymbal.',
			format: 'mid',
			bytes: drums([[0, 98], [480, 98]], [0, 240]),
			target: { instrument: 'drums', difficulty: 'expert' },
		},
	]
}

type Mix = readonly [tick: number, flag: '' | 'd' | 'dnoflip']

/** The ticks of the red and yellow Expert notes in the disco cases. */
function discoProbeTicks(): readonly number[] {
	return [0, 192, 384, 768, 960, 1344, 1536]
}

/** Red and yellow Expert drums at each probe tick, with Expert mix events in listed order. */
function discoChart(mixes: readonly Mix[], yellowCymbalTicks: readonly number[] = []): Uint8Array {
	const lines: { tick: number; order: number; text: string }[] = []
	mixes.forEach(([tick, flag], order) => lines.push({ tick, order, text: `E [mix 3 drums0${flag}]` }))
	for (const tick of discoProbeTicks()) lines.push({ tick, order: 100, text: 'N 1 0' }, { tick, order: 101, text: 'N 2 0' })
	for (const tick of yellowCymbalTicks) lines.push({ tick, order: 102, text: 'N 66 0' })
	lines.sort((left, right) => left.tick - right.tick || left.order - right.order)
	return chart({
		Song: ['Resolution = 192'],
		SyncTrack: ['0 = TS 4', '0 = B 120000'],
		Events: [],
		ExpertDrums: lines.map(line => `${line.tick} = ${line.text}`),
	})
}

function discoMidi(mixes: readonly Mix[]): Uint8Array {
	const events = mixes.map(([tick, flag]) => textEvent(tick, `[mix 3 drums0${flag}]`))
	for (const tick of discoProbeTicks()) events.push(...note(tick, 97, 10), ...note(tick, 98, 10))
	return midi([midiTrack('PART DRUMS', events)], 192)
}

/** C10: the latest mix event wins, and on a shared tick off > `d` > `dnoflip`, in `.chart` and `.mid`, pro and non-pro. */
function discoCases(): AuthoredSourceCase[] {
	const scenarios: readonly { readonly name: string; readonly mixes: readonly Mix[]; readonly purpose: string; readonly pro: boolean }[] = [
		{
			name: 'disco-d-dnoflip-off',
			mixes: [[192, 'd'], [768, 'dnoflip'], [1344, '']],
			purpose: 'd at 192, dnoflip at 768, off at 1344: disco, then no-flip disco, then none.',
			pro: true,
		},
		{
			name: 'disco-d-dnoflip-without-off',
			mixes: [[192, 'd'], [768, 'dnoflip']],
			purpose: 'd at 192 then dnoflip at 768 and no off: no-flip disco lasts to the end.',
			pro: true,
		},
		{
			name: 'disco-dnoflip-d-off',
			mixes: [[192, 'dnoflip'], [768, 'd'], [1344, '']],
			purpose: 'dnoflip at 192, d at 768, off at 1344: the later d replaces dnoflip.',
			pro: false,
		},
		{
			name: 'disco-same-tick-d-and-dnoflip',
			mixes: [[192, 'd'], [192, 'dnoflip'], [768, ''], [960, 'dnoflip'], [960, 'd'], [1344, '']],
			purpose: 'd and dnoflip on one tick, in both listed orders: d wins each time.',
			pro: false,
		},
		{
			name: 'disco-same-tick-off',
			mixes: [[192, 'd'], [384, ''], [384, 'd'], [768, 'd'], [960, 'd'], [960, ''], [1344, 'dnoflip'], [1536, 'dnoflip'], [1536, '']],
			purpose: 'off shares a tick with d (both listed orders) and with dnoflip: off wins each time.',
			pro: false,
		},
	]
	const cases: AuthoredSourceCase[] = []
	for (const scenario of scenarios) {
		cases.push({
			id: `source-chart-${scenario.name}`,
			purpose: `.chart, four-lane: ${scenario.purpose}`,
			format: 'chart',
			bytes: discoChart(scenario.mixes),
			target: { instrument: 'drums', difficulty: 'expert' },
		}, {
			id: `source-midi-${scenario.name}`,
			purpose: `.mid, four-lane: ${scenario.purpose}`,
			format: 'mid',
			bytes: discoMidi(scenario.mixes),
			target: { instrument: 'drums', difficulty: 'expert' },
		})
		if (scenario.pro) {
			cases.push({
				id: `source-chart-${scenario.name}-pro`,
				purpose: `.chart, pro drums from yellow cymbal markers (N 66) at 384 and 960: ${scenario.purpose}`,
				format: 'chart',
				bytes: discoChart(scenario.mixes, [384, 960]),
				target: { instrument: 'drums', difficulty: 'expert' },
			}, {
				id: `source-midi-${scenario.name}-pro`,
				purpose: `.mid, pro drums from song.ini pro_drums, so yellow notes are cymbals: ${scenario.purpose}`,
				format: 'mid',
				bytes: discoMidi(scenario.mixes),
				target: { instrument: 'drums', difficulty: 'expert' },
				modifiers: { ...resolvedModifiers, pro_drums: true },
			})
		}
	}
	return cases
}

/** The `.chart` `TS N ` trailing space, five-lane drums, GHL notes, and MIDI range shifts. */
function syncTrackAndInstrumentCases(): AuthoredSourceCase[] {
	const rangeShiftEvents = [
		textEvent(100, '[ld_range_shift 3 2 3]'),
		textEvent(200, 'ld_range_shift 3 3 3'),
		textEvent(300, '[ld_range_shift 3 3 3]'),
		textEvent(300, '[ld_range_shift 3 1 4]'),
		textEvent(400, '[ld_range_shift 2 1 3]'),
		textEvent(500, '[ld_range_shift 3 3 4]'),
		textEvent(600, '[ld_range_shift  3 2 2]'),
		textEvent(700, '[ld_range_shift 3 1]'),
	]
	return [
		{
			id: 'source-chart-time-signature-trailing-space',
			purpose: '"0 = TS 3 " and "768 = TS 5 " end in a space: the denominator exponent is read only when a digit follows, so both are quarter-note signatures.',
			format: 'chart',
			bytes: chart({
				Song: ['Resolution = 192'],
				SyncTrack: ['0 = B 120000', '0 = TS 3 ', '768 = TS 5 '],
				Events: [],
				ExpertSingle: ['0 = N 0 0', '768 = N 1 0'],
			}),
			target: { instrument: 'guitar', difficulty: 'expert' },
		},
		{
			id: 'source-chart-five-lane-drums',
			purpose: 'A .chart five-lane green (N 5) makes the chart five-lane: orange becomes green, and green becomes blue only in an orange-green chord.',
			format: 'chart',
			bytes: chart({
				Song: ['Resolution = 192'],
				SyncTrack: ['0 = B 120000', '0 = TS 4'],
				Events: [],
				ExpertDrums: ['0 = N 0 0', '0 = N 1 0', '192 = N 2 0', '384 = N 3 0', '576 = N 4 0', '768 = N 5 0', '960 = N 4 0', '960 = N 5 0'],
			}),
			target: { instrument: 'drums', difficulty: 'expert' },
		},
		{
			id: 'source-midi-five-lane-drums',
			purpose: 'A MIDI five-lane green (note 101) makes the chart five-lane, with the same orange-green chord rule.',
			format: 'mid',
			bytes: midi([midiTrack('PART DRUMS', [
				...note(0, 96, 60), ...note(0, 97, 60), ...note(480, 98, 60), ...note(960, 99, 60), ...note(1440, 100, 60),
				...note(1920, 101, 60), ...note(2400, 100, 60), ...note(2400, 101, 60),
			])]),
			target: { instrument: 'drums', difficulty: 'expert' },
		},
		{
			id: 'source-chart-ghl-guitar',
			purpose: 'Six-fret notes: three white and three black frets, open, a white-black chord, and a forced tap.',
			format: 'chart',
			bytes: chart({
				Song: ['Resolution = 192'],
				SyncTrack: ['0 = B 120000', '0 = TS 4'],
				Events: [],
				ExpertGHLGuitar: [
					'0 = N 0 0', '96 = N 1 0', '192 = N 2 0', '288 = N 3 0', '384 = N 4 0', '480 = N 8 0', '576 = N 7 0',
					'672 = N 0 0', '672 = N 3 0', '768 = N 2 0', '768 = N 6 0',
				],
			}),
			target: { instrument: 'guitarghl', difficulty: 'expert' },
		},
		{
			id: 'source-midi-range-shifts',
			purpose: 'MIDI range shifts: bracketed form only, same-tick last wins, a Hard marker, out-of-bounds and malformed markers with diagnostics, omitted size, and an inapplicable drums marker.',
			format: 'mid',
			bytes: midi([
				midiTrack('PART GUITAR', [
					...[0, 480, 960, 1440, 1920].flatMap(tick => [...note(tick, 96, 60), ...note(tick, 84, 60)]),
					...rangeShiftEvents,
				]),
				midiTrack('PART DRUMS', [...note(0, 97, 60), ...note(480, 97, 60), textEvent(100, '[ld_range_shift 3 1 5]')]),
			]),
			target: { instrument: 'guitar', difficulty: 'expert' },
		},
	]
}

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
const oneTempo = counted(data(16, view => {
	view.setBigInt64(0, 0n, true)
	view.setFloat64(8, 120, true)
}))
const oneTimeSignature = counted(data(16, view => {
	view.setBigInt64(0, 0n, true)
	view.setUint32(8, 4, true)
	view.setUint32(12, 4, true)
}))
// Since C13 a BTrack may omit its tempo map, so a vector for another rule carries one and fails only for that rule.
const tempoMap = [{ id: 2n, payload: oneTempo }, { id: 3n, payload: oneTimeSignature }]
const invalidNoteFlagCombination = physical([{ id: 1n, payload: resolution }, ...tempoMap, {
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
const descendingIds = physical([{ id: 2n, payload: oneTempo }, { id: 1n, payload: resolution }])
const canonicalTwoSections = physical([{ id: 1n, payload: resolution }, { id: 2n, payload: oneTempo }])
const reorderedPayloads = canonicalTwoSections.slice()
new DataView(reorderedPayloads.buffer).setBigUint64(20, 56n, true)
new DataView(reorderedPayloads.buffer).setBigUint64(40, 52n, true)
const overlappingPayloads = canonicalTwoSections.slice()
new DataView(overlappingPayloads.buffer).setBigUint64(40, 54n, true)
const emptyStarPower = physical([{ id: 1n, payload: resolution }, ...tempoMap, { id: 4n, payload: counted(tickRangeRecord(0n, 100n)) }])
const emptySolo = physical([{ id: 1n, payload: resolution }, ...tempoMap, { id: 5n, payload: counted(tickRangeRecord(0n, 100n)) }])
const emptyFlex = physical([{ id: 1n, payload: resolution }, ...tempoMap, {
	id: 6n,
	payload: counted(data(17, view => view.setBigInt64(8, 100n, true))),
}])
const emptyFreestyle = physical([{ id: 1n, payload: resolution }, {
	id: 7n,
	payload: counted(data(17, view => view.setBigInt64(8, 100n, true))),
}])

function flexLaneRecord(tick: bigint, length: bigint, isDouble: boolean): Uint8Array {
	return data(17, view => {
		view.setBigInt64(0, tick, true)
		view.setBigInt64(8, length, true)
		view.setUint8(16, isDouble ? 1 : 0)
	})
}

function canonicalTrack(semantics: Partial<CanonicalTrackSemantics>): Uint8Array {
	return identifyCanonicalTrack({ ...emptySemantics(), ...semantics }).physicalBTrack.bytes
}

const redTom = { length: 0n, type: noteTypes.redDrum, flags: noteFlags.tom }
const overlappingSameTypeFlexLanes = canonicalTrack({
	tempos: [{ tick: 0n, beatsPerMinute: 120 }],
	timeSignatures: [{ tick: 0n, numerator: 4, denominator: 4 }],
	flexLanes: [{ tick: 0n, length: 100n, isDouble: false }, { tick: 50n, length: 100n, isDouble: false }],
	notes: [{ tick: 0n, ...redTom }, { tick: 150n, ...redTom }],
})
const sameTickSameTypeFlexLanes = physical([{ id: 1n, payload: resolution }, ...tempoMap, {
	id: 6n,
	payload: counted(flexLaneRecord(0n, 100n, false), flexLaneRecord(0n, 50n, false)),
}, { id: 9n, payload: counted(noteRecord(0n, 0n, noteTypes.redDrum, noteFlags.tom)) }])
const doubleBeforeSingleFlexLanes = physical([{ id: 1n, payload: resolution }, ...tempoMap, {
	id: 6n,
	payload: counted(flexLaneRecord(0n, 100n, true), flexLaneRecord(0n, 100n, false)),
}, { id: 9n, payload: counted(noteRecord(0n, 0n, noteTypes.redDrum, noteFlags.tom)) }])
const greenStrum = { tick: 0n, length: 0n, type: noteTypes.green, flags: noteFlags.strum }
const timeSignatureWithoutTempo = canonicalTrack({ timeSignatures: [{ tick: 0n, numerator: 3, denominator: 4 }], notes: [greenStrum] })
const tempoWithoutTimeSignature = canonicalTrack({ tempos: [{ tick: 0n, beatsPerMinute: 150 }], notes: [greenStrum] })
const notesWithoutTempoMap = canonicalTrack({ notes: [greenStrum] })

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
	{
		id: 'physical-reject-note-flag-combination',
		purpose: 'Mutually exclusive attack flags cannot coexist; the tempo map is present.',
		expected: 'rejected',
		bytes: invalidNoteFlagCombination,
	},
	{ id: 'physical-reject-note-order', purpose: 'Same-tick notes must use ascending NoteType order.', expected: 'rejected', bytes: unorderedNotes },
	{ id: 'physical-reject-phrase-overlap', purpose: 'Canonical phrase records cannot overlap.', expected: 'rejected', bytes: overlappingPhrase },
	{ id: 'physical-reject-note-overlap', purpose: 'Canonical notes of the same type cannot overlap.', expected: 'rejected', bytes: overlappingNote },
	{ id: 'physical-reject-descending-ids', purpose: 'Descending section IDs are malformed.', expected: 'rejected', bytes: descendingIds },
	{ id: 'physical-reject-reordered-payloads', purpose: 'Payload order must follow strict section ID order.', expected: 'rejected', bytes: reorderedPayloads },
	{ id: 'physical-reject-overlapping-payloads', purpose: 'Overlapping physical section ranges are malformed.', expected: 'rejected', bytes: overlappingPayloads },
	{ id: 'physical-reject-empty-star-power', purpose: 'A star-power phrase without notes is noncanonical; the tempo map is present.', expected: 'rejected', bytes: emptyStarPower },
	{ id: 'physical-reject-empty-solo', purpose: 'A solo phrase without notes is noncanonical; the tempo map is present.', expected: 'rejected', bytes: emptySolo },
	{ id: 'physical-reject-empty-flex', purpose: 'A flex lane without notes is noncanonical; the tempo map is present.', expected: 'rejected', bytes: emptyFlex },
	{ id: 'physical-empty-freestyle', purpose: 'A freestyle range without notes remains canonical and hash-relevant.', expected: 'accepted', bytes: emptyFreestyle },
	{
		id: 'physical-flex-overlap-same-type',
		purpose: 'Overlapping flex lanes of the same type are canonical; the writer and the reader keep both.',
		expected: 'accepted',
		bytes: overlappingSameTypeFlexLanes,
	},
	{
		id: 'physical-reject-flex-same-tick-same-type',
		purpose: 'Two flex lanes of one type on one tick are noncanonical; a parser keeps only the longest.',
		expected: 'rejected',
		bytes: sameTickSameTypeFlexLanes,
	},
	{
		id: 'physical-reject-flex-double-before-single',
		purpose: 'On a shared tick the single flex lane comes before the double one.',
		expected: 'rejected',
		bytes: doubleBeforeSingleFlexLanes,
	},
	{
		id: 'physical-time-signature-without-tempo',
		purpose: 'A BTrack without a tempo section is valid; its TrackHash covers only the sections present.',
		expected: 'accepted',
		bytes: timeSignatureWithoutTempo,
	},
	{
		id: 'physical-tempo-without-time-signature',
		purpose: 'A BTrack without a time-signature section is valid; its TrackHash covers only the sections present.',
		expected: 'accepted',
		bytes: tempoWithoutTimeSignature,
	},
	{
		id: 'physical-notes-without-tempo-map',
		purpose: 'A BTrack with notes and neither a tempo nor a time-signature section is valid.',
		expected: 'accepted',
		bytes: notesWithoutTempoMap,
	},
]

/*
 * Song vectors: a song folder in, the canonical SongHash out. They cover the rules that only a whole song shows:
 * metadata, song.ini chart modifiers, SongHash membership, MIDI track selection, the notes-file choice, and durations.
 */

function utf8(text: string): Uint8Array {
	return new TextEncoder().encode(text)
}

/** A song.ini with a `[song]` section and the given `key = value` lines, CRLF line ends. */
function songIni(lines: readonly string[]): Uint8Array {
	return utf8(['[song]', ...lines, ''].join('\r\n'))
}

const threeGuitarNotes = ['0 = N 0 0', '192 = N 1 0', '384 = N 2 0']

/** A `.chart` at 192 ticks per beat, 120 BPM and 4/4, whose `[Song]` section adds `songLines`. */
function songChart(songLines: readonly string[], tracks: Record<string, readonly string[]> = { ExpertSingle: threeGuitarNotes }): Uint8Array {
	return chart({
		Song: ['Resolution = 192', ...songLines],
		SyncTrack: ['0 = B 120000', '0 = TS 4'],
		Events: [],
		...tracks,
	})
}

function chartOnly(id: string, purpose: string, songLines: readonly string[]): AuthoredSongCase {
	return { id, purpose, files: [{ name: 'notes.chart', bytes: songChart(songLines) }] }
}

function chartWithIni(id: string, purpose: string, songLines: readonly string[], ini: Uint8Array): AuthoredSongCase {
	return { id, purpose, files: [{ name: 'notes.chart', bytes: songChart(songLines) }, { name: 'song.ini', bytes: ini }] }
}

/** Five-fret notes at 480 ticks per beat: gaps around the HOPO thresholds, sustains around the cutoffs, a near-chord. */
const modifierPattern: readonly (readonly [tick: number, fret: number, length: number])[] = [
	[0, 0, 0], [80, 1, 40], [200, 2, 100], [360, 1, 200], [600, 3, 0], [840, 4, 0], [843, 0, 0], [960, 2, 0],
	[1000, 3, 30], [1120, 2, 0], [1440, 0, 480], [1920, 1, 0], [2040, 2, 0],
]

function modifierChart(): Uint8Array {
	const scale = (ticks: number) => Math.round(ticks * 192 / 480)
	return chart({
		Song: ['Resolution = 192'],
		SyncTrack: ['0 = B 120000', '0 = TS 4'],
		Events: [],
		ExpertSingle: ['0 = S 2 384', ...modifierPattern.map(([tick, fret, length]) => `${scale(tick)} = N ${fret} ${scale(length)}`)],
	})
}

/** The modifier pattern on Expert guitar with a phrase on `phraseNote` (116 star power, or 103) over its first two beats. */
function modifierGuitarTrack(phraseNote = 116): MidiData['tracks'][number] {
	return midiTrack('PART GUITAR', [
		...note(0, phraseNote, 960),
		...modifierPattern.flatMap(([tick, fret, length]) => note(tick, 96 + fret, Math.max(length, 10))),
	])
}

function modifierMidi(phraseNote = 116): Uint8Array {
	return midi([modifierGuitarTrack(phraseNote)])
}

/** Red, yellow, blue and orange Expert drums, one per beat. */
function fourPadDrums(name = 'PART DRUMS'): MidiData['tracks'][number] {
	return midiTrack(name, [...note(0, 97, 60), ...note(480, 98, 60), ...note(960, 99, 60), ...note(1440, 100, 60)])
}

function midiWithIni(id: string, purpose: string, bytes: Uint8Array, ini: Uint8Array): AuthoredSongCase {
	return { id, purpose, files: [{ name: 'notes.mid', bytes }, { name: 'song.ini', bytes: ini }] }
}

const songIniBase = ['name = Golden Vector', 'artist = Golden Artist', 'charter = Golden Charter']

function metadataCases(): AuthoredSongCase[] {
	return [
		chartOnly('song-chart-metadata-without-ini',
			'C1: without song.ini, .chart [Song] values are trimmed and used, and Year loses its leading ", ".',
			['Name = "Chart Name"', 'Artist = "Chart Artist "', 'Album = "Chart Album"', 'Genre = "Chart Genre"', 'Year = ", 2004"', 'Charter = "Chart Charter"']),
		chartOnly('song-chart-year-without-separator',
			'C1: a .chart Year without a leading ", " is kept whole.',
			['Name = "Year Without Separator"', 'Year = "2004"']),
		chartOnly('song-chart-year-comma-without-space',
			'C1: only a leading ", " is removed from a .chart Year; ",2004" is kept.',
			['Name = "Year Comma"', 'Year = ",2004"']),
		chartOnly('song-chart-metadata-sentinels-and-tags',
			'C1: .chart [Song] "0" and "-1" are unset, ", 0" is an unset Year, and style tags are stripped.',
			['Name = "0"', 'Artist = "-1"', 'Album = "<b>Bold</b> Album"', 'Genre = "<color=#FF0000>Red</color>"', 'Year = ", 0"', 'Charter = "0"']),
		chartOnly('song-chart-metadata-key-rules',
			'C1: .chart [Song] keys match by case, the first nonblank value wins, a lone quote is removed, and Name "midi_export" stops the reader.',
			['name = "lower"', 'Name = "First"', 'Name = "Second"', 'Artist = ""', 'Artist = "Later"', 'Genre = Unquoted"', 'Name = "midi_export"', 'Album = "After The Stop"']),
		chartWithIni('song-ini-precedence-over-chart',
			'C1: a song.ini [song] section replaces .chart [Song] entirely; its missing keys are unknown.',
			['Name = "Chart Name"', 'Artist = "Chart Artist"', 'Album = "Chart Album"'],
			songIni(['artist = Ini Artist'])),
		chartWithIni('song-ini-without-song-section',
			'C1: a song.ini without a [song] section is ignored, so the .chart [Song] values are used.',
			['Name = "Chart Name"', 'Artist = "Chart Artist"'],
			utf8('[other]\r\nname = Other Name\r\n')),
		chartWithIni('song-ini-empty-file',
			'C1: an empty song.ini is ignored, so the .chart [Song] values are used and trimmed.',
			['Name = "Chart Name"', 'Artist = "Trailing Artist "'],
			new Uint8Array(0)),
		chartWithIni('song-ini-sentinels-tags-and-icon',
			'C1: song.ini "0" and "-1" are unset, a tag-wrapped "0" is kept, style tags are stripped, and an icon equal to the charter is cleared.',
			[],
			songIni(['name = 0', 'artist = -1', 'album = <b>0</b>', 'genre = <i>Rock</i>', 'year = <u>2020</u>', 'charter = <color=#00ff00>Geo</color>', 'icon = GEO'])),
		chartWithIni('song-ini-frets-fallback-and-icon',
			'C1: without a charter key the charter comes from frets, and the icon is lowercased.',
			[],
			songIni(['name = Frets Fallback', 'frets = Frets Charter', 'icon = MyIcon'])),
		chartWithIni('song-ini-angle-text-and-nested-tags',
			'C1: angle-bracket text that is not a style tag is kept; nested and upper-case style tags are stripped.',
			[],
			songIni(['name = <LOST> in Time', 'artist = <|°_°|>', 'album = >_< Album', 'genre = Love <3', 'year = <b><i>2020</i></b>', 'charter = <B>Upper</B> Tag'])),
		chartWithIni('song-ini-dotnet-whitespace',
			'C2: song.ini lines, keys and values are trimmed with the .NET whitespace set, including U+0085, U+00A0, U+1680, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F and U+3000.',
			[],
			songIni([
				'name = 　Name\u0085',
				'artist = Artist  ',
				'album =  Album ',
				'genre = Genre  ',
				'year =  2020  ',
				'charter = \tCharter\u000b\u000c',
				'\u0085icon = Icon ',
			])),
		{
			id: 'song-ini-feff-is-not-whitespace',
			purpose: 'C2: one leading byte order mark is removed from song.ini, but U+FEFF inside values is not whitespace and is kept.',
			files: [
				{ name: 'notes.chart', bytes: songChart([]) },
				{ name: 'song.ini', bytes: Uint8Array.from([0xef, 0xbb, 0xbf, ...songIni(['name = Name﻿', 'artist = ﻿Artist', 'charter = Golden Charter'])]) },
			],
		},
		chartOnly('song-chart-metadata-dotnet-whitespace',
			'C2: .chart [Song] values are trimmed with the .NET set (U+0085, U+00A0), and U+FEFF is kept.',
			['Name = "Name\u0085"', 'Artist = " Artist"', 'Album = "Album﻿"']),
		chartOnly('song-minimal-chart-without-ini',
			'C14: a minimal .chart without song.ini; every metadata field is unknown and the preimage carries version 20260801.',
			[]),
	]
}

function membershipCases(): AuthoredSongCase[] {
	return [
		{
			id: 'song-chart-noteless-sections',
			purpose: 'C3: only .chart sections with a note after parsing are members: empty, star-power-only, modifier-only, freestyle-only and event-only sections are not; a kick-only section is.',
			files: [{
				name: 'notes.chart',
				bytes: songChart(['Name = "Noteless Sections"'], {
					ExpertSingle: ['0 = N 0 0'],
					HardSingle: [],
					MediumSingle: ['0 = S 2 192'],
					EasySingle: ['0 = N 5 0', '0 = N 6 0', '0 = E "solo"', '100 = E "soloend"'],
					ExpertDrums: ['0 = N 66 0', '0 = S 64 192'],
					HardDrums: ['0 = N 0 0'],
					EasyDoubleBass: ['100 = E "ld_range_shift 0 1"'],
				}),
			}],
		},
		midiWithIni('song-midi-noteless-tracks',
			'C3: a MIDI difficulty with only phrases or markers is not a member; a Medium difficulty with only a kick is.',
			midi([
				midiTrack('PART GUITAR', note(0, 96, 10)),
				midiTrack('PART BASS', [...note(0, 116, 480), ...note(0, 103, 480)]),
				midiTrack('PART DRUMS', [...note(0, 110, 10), ...note(480, 72, 10)]),
			]),
			songIni(songIniBase)),
		midiWithIni('song-midi-track-name-case',
			'C4a: MIDI track names match in any letter case, including the "part drum" alias.',
			midi([
				midiTrack('part guitar', note(0, 96, 10)),
				midiTrack('Part Bass', note(0, 97, 10)),
				midiTrack('part drum', note(0, 97, 10)),
				midiTrack('pArT kEyS', note(0, 98, 10)),
			]),
			songIni(songIniBase)),
		midiWithIni('song-midi-duplicate-instrument-first-wins',
			'C4b: of two tracks for one instrument the first wins; the second track adds no notes, difficulties or duration.',
			midi([
				midiTrack('PART DRUMS', note(0, 97, 10)),
				midiTrack('part drum', [...note(1920, 98, 10), ...note(1920, 86, 10)]),
			]),
			songIni(songIniBase)),
		midiWithIni('song-midi-duplicate-instrument-noteless-first',
			'C4b: a first guitar track with only a star-power phrase still hides a later T1 GEMS guitar track.',
			midi([
				midiTrack('PART GUITAR', note(0, 116, 480)),
				midiTrack('T1 GEMS', note(0, 96, 10)),
				midiTrack('PART BASS', note(480, 96, 10)),
			]),
			songIni(songIniBase)),
		midiWithIni('song-midi-tick-zero-track-names',
			'C4c: with several tick-0 track names the first recognized one names the track: PART DRUMS before Drums, PART BASS before PART GUITAR, and PART KEYS after Keys.',
			midi([
				midiTrack(['PART DRUMS', 'Drums'], note(0, 97, 10)),
				midiTrack(['PART BASS', 'PART GUITAR'], note(0, 96, 10)),
				midiTrack(['Keys', 'PART KEYS'], note(0, 97, 10)),
			]),
			songIni(songIniBase)),
		midiWithIni('song-midi-track-zero-is-not-an-instrument',
			'MIDI track 0 is never an instrument, even when it is named PART GUITAR and holds notes.',
			midi([midiTrack('PART BASS', note(0, 96, 10))], 480, midiTrack('PART GUITAR', [
				{ tick: 0, event: { deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 } },
				...note(0, 96, 10),
			])),
			songIni(songIniBase)),
		{
			id: 'song-folder-both-notes-files',
			purpose: 'C5: a folder with both notes.chart and notes.mid is read from notes.mid.',
			files: [
				{ name: 'notes.chart', bytes: songChart([], { ExpertSingle: threeGuitarNotes }) },
				{ name: 'notes.mid', bytes: midi([fourPadDrums()]) },
				{ name: 'song.ini', bytes: songIni(songIniBase) },
			],
		},
		{
			id: 'song-ghl-and-keysghl-members',
			purpose: 'Six-fret guitar and six-fret keys are canonical members next to five-fret guitar, in SongHash instrument order.',
			files: [{
				name: 'notes.chart',
				bytes: songChart([], {
					ExpertSingle: threeGuitarNotes,
					ExpertGHLGuitar: ['0 = N 0 0', '192 = N 3 0', '384 = N 8 0'],
					ExpertGHLKeys: ['0 = N 1 0', '192 = N 4 0', '384 = N 7 0'],
				}),
			}],
		},
	]
}

function modifierCases(): AuthoredSongCase[] {
	return [
		{
			id: 'song-ini-modifiers-chart-integers',
			purpose: 'C11: .chart with integer song.ini modifiers: hopo_frequency 100, sustain_cutoff_threshold 50 and chord_snap_threshold 5.',
			files: [
				{ name: 'notes.chart', bytes: modifierChart() },
				{ name: 'song.ini', bytes: songIni([...songIniBase, 'hopo_frequency = 100', 'sustain_cutoff_threshold = 50', 'chord_snap_threshold = 5']) },
			],
		},
		midiWithIni('song-ini-modifiers-mid-defaults',
			'C11: .mid with no modifier keys in song.ini, the control for the other MIDI modifier vectors.',
			modifierMidi(), songIni(songIniBase)),
		midiWithIni('song-ini-modifiers-mid-signed-integers',
			'C11: integers parse like int.TryParse: "+250" is 250 and "050" is 50.',
			modifierMidi(), songIni([...songIniBase, 'hopo_frequency = +250', 'sustain_cutoff_threshold = 050', 'chord_snap_threshold = 5'])),
		midiWithIni('song-ini-modifiers-invalid-integers',
			'C11: "170.5", "1e3", "2147483648" and "103.0" are not integers, so every modifier keeps its default; TrackHashes equal song-ini-modifiers-mid-defaults.',
			modifierMidi(), songIni([...songIniBase, 'hopo_frequency = 170.5', 'sustain_cutoff_threshold = 1e3', 'chord_snap_threshold = 2147483648', 'multiplier_note = 103.0'])),
		midiWithIni('song-ini-modifiers-clamp-and-negative',
			'C11: hopo_frequency 70000 is clamped to 65535, a negative sustain_cutoff_threshold uses the default, and "-0" is 0.',
			modifierMidi(), songIni([...songIniBase, 'hopo_frequency = 70000', 'sustain_cutoff_threshold = -5', 'chord_snap_threshold = -0'])),
		midiWithIni('song-ini-modifiers-booleans',
			'C11: booleans read like TryGetBool: eighthnote_hopo "2" and pro_drums "-1" are true, and five_lane_drums "yes" is false.',
			midi([modifierGuitarTrack(), fourPadDrums()]),
			songIni([...songIniBase, 'eighthnote_hopo = 2', 'pro_drums = -1', 'five_lane_drums = yes'])),
		midiWithIni('song-ini-multiplier-note-103',
			'C11: multiplier_note 103 turns the note-103 phrase into star power; the TrackHash equals song-ini-modifiers-mid-defaults, whose phrase is on note 116.',
			modifierMidi(103), songIni([...songIniBase, 'multiplier_note = 103'])),
		midiWithIni('song-ini-multiplier-note-absent',
			'C11: without multiplier_note a single note-103 phrase stays a solo.',
			modifierMidi(103), songIni(songIniBase)),
		midiWithIni('song-ini-five-lane-over-pro',
			'Drums: song.ini five_lane_drums and pro_drums together make the chart five-lane, not pro.',
			midi([fourPadDrums()]), songIni([...songIniBase, 'pro_drums = True', 'five_lane_drums = 1'])),
	]
}

function durationCases(): AuthoredSongCase[] {
	return [
		{
			id: 'song-duration-tempo-change-in-added-beat',
			purpose: 'C12: the song duration adds one beat after the last note end and converts it through a tempo change inside that beat.',
			files: [{
				name: 'notes.chart',
				bytes: chart({ Song: ['Resolution = 192'], SyncTrack: ['0 = B 120000', '0 = TS 4', '288 = B 60000'], Events: [], ExpertSingle: ['0 = N 0 192'] }),
			}],
		},
		{
			id: 'song-duration-latest-note-across-tracks',
			purpose: 'C12: the song duration starts from the latest note end of any track; each track duration uses its own last note end and no added beat.',
			files: [{ name: 'notes.chart', bytes: songChart([], { ExpertSingle: ['0 = N 0 192'], EasyDoubleBass: ['384 = N 0 192'] }) }],
		},
		{
			id: 'song-duration-rounding-and-track-minimum',
			purpose: 'C12: at resolution 3 and 25 BPM the conversion lands just above 2400 ms and rounds up once; a track whose last note ends at tick 0 lasts 1 ms.',
			files: [{
				name: 'notes.chart',
				bytes: chart({ Song: ['Resolution = 3'], SyncTrack: ['0 = B 25000', '0 = TS 4'], Events: [], ExpertSingle: ['0 = N 0 0'] }),
			}],
		},
		midiWithIni('song-duration-midi-sustain-and-tempo',
			'C12: a MIDI sustain longer than the cutoff ends the content, after a change to 200 BPM. Converting end tick 2400 needs the StrikeCore bit increment (1.9 s becomes 1.9000000000000001 s), so the song lasts 1901 ms.',
			midi([midiTrack('PART GUITAR', [...note(0, 96, 10), ...note(1440, 97, 480)])], 480, midiTrack('', [
				{ tick: 0, event: { deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 } },
				{ tick: 0, event: { deltaTime: 0, type: 'timeSignature', numerator: 4, denominator: 4, metronome: 24, thirtyseconds: 8 } },
				{ tick: 960, event: { deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 300000 } },
			])),
			songIni(songIniBase)),
	]
}

export const songCases: readonly AuthoredSongCase[] = [
	...metadataCases(),
	...membershipCases(),
	...modifierCases(),
	...durationCases(),
]
