/**
 * `.chart` file writer — serializes a ParsedChart back to chart text.
 *
 * Emits `[Song]`, `[SyncTrack]`, `[Events]`, per-instrument track sections
 * (e.g. `[ExpertSingle]`, `[HardDrums]`), and any unrecognized chart sections
 * that the parser preserved verbatim.
 */

import type { Instrument } from '../interfaces'
import { computeHopoThresholdTicks, isNaturalHopo } from './natural-hopo'
import type { NoteEvent, NoteType } from './note-parsing-interfaces'
import { noteFlags, noteTypes } from './note-parsing-interfaces'
import type { ParsedChart } from './parse-chart-and-ini'

type ParsedTrack = ParsedChart['trackData'][number]

/**
 * Serialize a {@link ParsedChart} to `.chart` file text (CRLF line endings).
 * Emits `[Song]`, `[SyncTrack]`, `[Events]`, per-instrument track sections,
 * and any chart sections the parser preserved verbatim for round-trip.
 */
export function writeChartFile(chart: ParsedChart): string {
	const sections: string[][] = []
	sections.push(serializeSongSection(chart))
	sections.push(serializeSyncTrack(chart))
	sections.push(serializeEventsSection(chart))

	for (const track of chart.trackData) {
		const lines = serializeTrackSection(track, chart)
		if (lines.length === 0) continue
		sections.push(lines)
	}

	for (const us of chart.unrecognizedChartSections) {
		const sec: string[] = [`[${us.name}]`, '{']
		for (const ln of us.lines) sec.push(`  ${ln}`)
		sec.push('}')
		sections.push(sec)
	}

	const out: string[] = []
	for (const section of sections) {
		for (const line of section) out.push(line)
	}
	return out.join('\r\n') + '\r\n'
}

// ---------------------------------------------------------------------------
// [Song] section
// ---------------------------------------------------------------------------

/**
 * The subset of `song.ini` fields that the `[Song]` section in a `.chart`
 * file supports. Values for these fields in {@link ParsedChart.metadata} get
 * re-emitted here; all other ini fields live exclusively in `song.ini`.
 */
function serializeSongSection(chart: ParsedChart): string[] {
	const lines: string[] = ['[Song]', '{']
	const m = chart.metadata

	if (m.name != null) lines.push(`  Name = "${m.name}"`)
	if (m.artist != null) lines.push(`  Artist = "${m.artist}"`)
	if (m.charter != null) lines.push(`  Charter = "${m.charter}"`)
	if (m.album != null) lines.push(`  Album = "${m.album}"`)
	if (m.genre != null) lines.push(`  Genre = "${m.genre}"`)
	// [Song]'s `Year` is historically written with a leading `, ` separator
	// (a GHTCP quirk the scan-chart parser strips back out — see chart-parser).
	if (m.year != null) lines.push(`  Year = ", ${m.year}"`)

	lines.push(`  Resolution = ${chart.resolution}`)

	// `[Song].Offset` is a .chart-only field — distinct from ini's `delay`,
	// which games recognize only in song.ini. Read from `metadata.chart_offset`
	// (populated by the parser from [Song].Offset) so that ini's `delay`
	// never overrides it on the ini-wins merge. `PreviewStart` is seconds in
	// the file, ms on ParsedChart.
	if (m.chart_offset != null && m.chart_offset !== 0) {
		lines.push(`  Offset = ${m.chart_offset / 1000}`)
	}
	if (m.preview_start_time != null) {
		lines.push(`  PreviewStart = ${m.preview_start_time / 1000}`)
	}
	if (m.diff_guitar != null) lines.push(`  Difficulty = ${m.diff_guitar}`)

	// Round-trip any `[Song]` keys the parser didn't claim (deprecated
	// Moonscraper / GHTCP fields — `Player2`, `HoPo`, `PreviewEnd`, `MediaType`,
	// audio-stream filenames, etc.). Values are preserved verbatim: if the
	// source didn't quote the value, we don't quote it here either. Consumers
	// should treat these as opaque and never synthesize them — editors should
	// discover audio via folder scan rather than trust `*Stream` values here.
	if (m.extraChartSongFields) {
		for (const [key, value] of Object.entries(m.extraChartSongFields)) {
			lines.push(`  ${key} = ${value}`)
		}
	}

	lines.push('}')
	return lines
}

// ---------------------------------------------------------------------------
// [SyncTrack] section
// ---------------------------------------------------------------------------

function serializeSyncTrack(chart: ParsedChart): string[] {
	const lines: string[] = ['[SyncTrack]', '{']

	type SyncEvent =
		| { tick: number; order: 0; kind: 'ts'; numerator: number; denominator: number }
		| { tick: number; order: 1; kind: 'bpm'; beatsPerMinute: number }
		| { tick: number; order: 2; kind: 'raw'; text: string }

	const events: SyncEvent[] = [
		...chart.timeSignatures.map(
			(ts): SyncEvent => ({
				tick: ts.tick,
				order: 0,
				kind: 'ts',
				numerator: ts.numerator,
				denominator: ts.denominator,
			}),
		),
		...chart.tempos.map(
			(t): SyncEvent => ({ tick: t.tick, order: 1, kind: 'bpm', beatsPerMinute: t.beatsPerMinute }),
		),
		...chart.unrecognizedSyncTrackEvents.map(
			(e): SyncEvent => ({ tick: e.tick, order: 2, kind: 'raw', text: e.text }),
		),
	]

	// Sort by tick, then TS < B < raw at the same tick. Duplicates preserved.
	events.sort((a, b) => {
		if (a.tick !== b.tick) return a.tick - b.tick
		return a.order - b.order
	})

	for (const ev of events) {
		if (ev.kind === 'bpm') {
			const millibeats = Math.round(ev.beatsPerMinute * 1000)
			lines.push(`  ${ev.tick} = B ${millibeats}`)
		} else if (ev.kind === 'raw') {
			lines.push(`  ${ev.tick} = ${ev.text}`)
		} else if (ev.denominator === 4) {
			lines.push(`  ${ev.tick} = TS ${ev.numerator}`)
		} else {
			lines.push(`  ${ev.tick} = TS ${ev.numerator} ${Math.log2(ev.denominator)}`)
		}
	}

	lines.push('}')
	return lines
}

// ---------------------------------------------------------------------------
// [Events] section
// ---------------------------------------------------------------------------

function serializeEventsSection(chart: ParsedChart): string[] {
	const lines: string[] = ['[Events]', '{']

	// Typed events: sections (wrapped as `[section name]`), endEvents.
	// Wrapping: scan-chart's section regex `^\[?(?:section|prc)[ _](.*?)\]?$`
	// is greedy for the trailing `\]?$` and lazy for `(.*?)`, so an unwrapped
	// `section [name]` would have its trailing `]` eaten as the optional
	// closing bracket. Wrapping in outer brackets preserves the name.
	const events: { tick: number; text: string }[] = []
	for (const s of chart.sections) events.push({ tick: s.tick, text: `[section ${s.name}]` })
	for (const e of chart.endEvents) events.push({ tick: e.tick, text: 'end' })

	// Unrecognized global events (crowd events, music_start/end, coda, etc.).
	// If the chart was originally parsed from .mid, these came in as `[text]`
	// (square-bracketed MIDI text meta events) — strip the brackets so the
	// .chart output writes the naked text between quotes (the .chart E-event
	// convention).
	const sourceIsMidi = chart.format === 'mid'
	let hasCodaInGlobalEvents = false
	for (const ge of chart.unrecognizedEventsTrackTextEvents) {
		let text = ge.text
		if (sourceIsMidi) {
			const trimmed = text.trimEnd()
			if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
				text = trimmed.slice(1, -1)
			}
		}
		// endEvents are already emitted above; skip duplicates here.
		if (text.trim() === 'end') continue
		events.push({ tick: ge.tick, text })
		if (text.trim() === 'coda') hasCodaInGlobalEvents = true
	}

	// Coda events from drumFreestyleSections — only when not already present
	// in the unrecognizedEvents stream above.
	if (!hasCodaInGlobalEvents) {
		const codaTicks = new Set<number>()
		for (const track of chart.trackData) {
			for (const fs of track.drumFreestyleSections) {
				if (fs.isCoda) codaTicks.add(fs.tick)
			}
		}
		for (const tick of codaTicks) events.push({ tick, text: 'coda' })
	}

	// Vocal phrases + lyrics from the normalized `vocals` part. .chart supports
	// only one vocal track (harmonies are MIDI-only).
	type TaggedEvent = { tick: number; text: string; subKey: number }
	const eventPriority = (text: string): number => {
		if (text === 'phrase_end') return 0
		if (text.startsWith('lyric ')) return 1
		if (text === 'coda') return 2
		if (text.startsWith('section ')) return 3
		if (text === 'phrase_start') return 4
		if (text === 'end') return 5
		return 4
	}
	const tagged: TaggedEvent[] = events.map(e => ({
		tick: e.tick,
		text: e.text,
		subKey: 1_000_000 + eventPriority(e.text),
	}))

	const vocalsPart = chart.vocalTracks.parts.vocals
	if (vocalsPart) {
		// Emit phrase_start for every phrase. Omit phrase_end when the next
		// phrase starts at exactly the same tick: the .chart parser closes the
		// current phrase implicitly on the next phrase_start, so an explicit
		// phrase_end would round-trip as a spurious duplicate.
		const phrases = vocalsPart.notePhrases
		for (let i = 0; i < phrases.length; i++) {
			const phrase = phrases[i]
			const endTick = phrase.tick + phrase.length
			tagged.push({ tick: phrase.tick, text: 'phrase_start', subKey: i * 2 })
			const next = phrases[i + 1]
			const nextStartsAtOurEnd = next && next.tick === endTick
			if (!nextStartsAtOurEnd) {
				tagged.push({ tick: endTick, text: 'phrase_end', subKey: i * 2 + 1 })
			}
		}
		for (const phrase of phrases) {
			for (const lyric of phrase.lyrics) {
				tagged.push({ tick: lyric.tick, text: `lyric ${lyric.text}`, subKey: 1_000_000 + 1 })
			}
		}
	}

	tagged.sort((a, b) => {
		if (a.tick !== b.tick) return a.tick - b.tick
		return a.subKey - b.subKey
	})

	for (const ev of tagged) {
		lines.push(`  ${ev.tick} = E "${ev.text}"`)
	}

	lines.push('}')
	return lines
}

// ---------------------------------------------------------------------------
// [<Difficulty><Instrument>] track sections
// ---------------------------------------------------------------------------

type TrackLineEvent =
	| { tick: number; sortKey: 1; kind: 'S'; value: number; length: number }
	| { tick: number; sortKey: 0; kind: 'N'; value: number; length: number }
	| { tick: number; sortKey: 2; kind: 'E'; text: string }

const instrumentSectionSuffix: Record<string, string> = {
	guitar: 'Single',
	guitarcoop: 'DoubleGuitar',
	rhythm: 'DoubleRhythm',
	bass: 'DoubleBass',
	drums: 'Drums',
	keys: 'Keyboard',
	guitarghl: 'GHLGuitar',
	guitarcoopghl: 'GHLCoop',
	rhythmghl: 'GHLRhythm',
	bassghl: 'GHLBass',
}

const difficultyPrefix: Record<string, string> = {
	expert: 'Expert',
	hard: 'Hard',
	medium: 'Medium',
	easy: 'Easy',
}

const drumNoteTypeToNoteNumber: Partial<Record<NoteType, number>> = {
	[noteTypes.kick]: 0,
	[noteTypes.redDrum]: 1,
	[noteTypes.yellowDrum]: 2,
	[noteTypes.blueDrum]: 3,
	[noteTypes.greenDrum]: 4,
}

const drumNoteTypeToNoteNumberFiveLane: Partial<Record<NoteType, number>> = {
	[noteTypes.kick]: 0,
	[noteTypes.redDrum]: 1,
	[noteTypes.yellowDrum]: 2,
	[noteTypes.blueDrum]: 3,
	[noteTypes.greenDrum]: 5,
}

const fiveFretNoteTypeToNoteNumber: Partial<Record<NoteType, number>> = {
	[noteTypes.open]: 7,
	[noteTypes.green]: 0,
	[noteTypes.red]: 1,
	[noteTypes.yellow]: 2,
	[noteTypes.blue]: 3,
	[noteTypes.orange]: 4,
}

const ghlNoteTypeToNoteNumber: Partial<Record<NoteType, number>> = {
	[noteTypes.open]: 7,
	[noteTypes.white1]: 0,
	[noteTypes.white2]: 1,
	[noteTypes.white3]: 2,
	[noteTypes.black1]: 3,
	[noteTypes.black2]: 4,
	[noteTypes.black3]: 8,
}

const ghlInstrumentSet = new Set<string>([
	'guitarghl', 'guitarcoopghl', 'rhythmghl', 'bassghl',
])

function getNoteNumberMap(
	instrument: Instrument,
	drumType: number | null | undefined,
): Partial<Record<NoteType, number>> {
	if (instrument === 'drums') {
		return drumType === 2 ? drumNoteTypeToNoteNumberFiveLane : drumNoteTypeToNoteNumber
	}
	if (ghlInstrumentSet.has(instrument)) return ghlNoteTypeToNoteNumber
	return fiveFretNoteTypeToNoteNumber
}

const drumCymbalNoteNumber: Partial<Record<NoteType, number>> = {
	[noteTypes.yellowDrum]: 66,
	[noteTypes.blueDrum]: 67,
	[noteTypes.greenDrum]: 68,
}

const drumAccentNoteNumber: Partial<Record<NoteType, number>> = {
	[noteTypes.kick]: 33,
	[noteTypes.redDrum]: 34,
	[noteTypes.yellowDrum]: 35,
	[noteTypes.blueDrum]: 36,
	[noteTypes.greenDrum]: 37,
}

const drumGhostNoteNumber: Partial<Record<NoteType, number>> = {
	[noteTypes.kick]: 39,
	[noteTypes.redDrum]: 40,
	[noteTypes.yellowDrum]: 41,
	[noteTypes.blueDrum]: 42,
	[noteTypes.greenDrum]: 43,
}

// ---------------------------------------------------------------------------
// serializeTrackSection
// ---------------------------------------------------------------------------

function serializeTrackSection(track: ParsedTrack, chart: ParsedChart): string[] {
	const suffix = instrumentSectionSuffix[track.instrument]
	const prefix = difficultyPrefix[track.difficulty]
	if (suffix == null || prefix == null) return []

	const lines: string[] = [`[${prefix}${suffix}]`, '{']
	const drumType = chart.drumType
	const noteMap = getNoteNumberMap(track.instrument, drumType)
	const isDrums = track.instrument === 'drums'

	// Pre-compute natural-HOPO state per group for fret instruments.
	const isNaturalHopoByGroup: boolean[] = []
	if (!isDrums) {
		const hopoThreshold = computeHopoThresholdTicks(
			chart.resolution,
			chart.iniChartModifiers.hopo_frequency,
			chart.iniChartModifiers.eighthnote_hopo,
			'chart',
		)
		let lastGroup: NoteEvent[] | null = null
		for (const group of track.noteEventGroups) {
			isNaturalHopoByGroup.push(isNaturalHopo(group, lastGroup, hopoThreshold, 'chart'))
			lastGroup = group
		}
	}

	const events: TrackLineEvent[] = []

	for (const sp of track.starPowerSections) {
		events.push({ tick: sp.tick, sortKey: 1, kind: 'S', value: 2, length: sp.length })
	}
	for (const fs of track.drumFreestyleSections) {
		events.push({ tick: fs.tick, sortKey: 1, kind: 'S', value: 64, length: fs.length })
	}
	for (const fl of track.flexLanes) {
		events.push({ tick: fl.tick, sortKey: 1, kind: 'S', value: fl.isDouble ? 66 : 65, length: fl.length })
	}
	for (const vp of track.versusPhrases) {
		events.push({ tick: vp.tick, sortKey: 1, kind: 'S', value: vp.isPlayer2 ? 1 : 0, length: vp.length })
	}
	// Solo sections: `length = end - start + 1` in the parser, so subtract 1 to
	// round-trip `soloend` to the same tick.
	for (const solo of track.soloSections) {
		events.push({ tick: solo.tick, sortKey: 2, kind: 'E', text: 'solo' })
		events.push({ tick: solo.tick + Math.max(solo.length - 1, 0), sortKey: 2, kind: 'E', text: 'soloend' })
	}
	for (const te of track.textEvents) {
		events.push({ tick: te.tick, sortKey: 2, kind: 'E', text: te.text })
	}

	for (let gi = 0; gi < track.noteEventGroups.length; gi++) {
		const group = track.noteEventGroups[gi]
		let hasFlamInGroup = false

		for (const note of group) {
			let noteNumber = noteMap[note.type]
			if (noteNumber == null) continue

			// 5-lane cymbal-on-green: parser normalizes the 5-lane orange pad into
			// greenDrum, so cymbal-flagged greens go back to N 4 to restore the
			// original orange placement. Plain green (tom) stays at N 5.
			if (isDrums && drumType === 2 && note.type === noteTypes.greenDrum && (note.flags & noteFlags.cymbal)) {
				noteNumber = 4
			}

			// 5-lane drumType detection requires at least one fiveGreenDrum (N 5).
			// If a chart has green+cymbal but no plain green, the parser would
			// re-detect as fourLane. Heuristic: a blueDrum at the same tick as a
			// green+cymbal came from N 5 + N 4 in the original (the
			// hasOrangeAndGreen=true case). Emit as N 5 to preserve the layout.
			if (
				isDrums &&
				drumType === 2 &&
				note.type === noteTypes.blueDrum &&
				group.some(n => n.type === noteTypes.greenDrum && (n.flags & noteFlags.cymbal))
			) {
				noteNumber = 5
			}

			const isDoubleKick = isDrums && note.type === noteTypes.kick && (note.flags & noteFlags.doubleKick)
			if (isDoubleKick) {
				events.push({ tick: note.tick, sortKey: 0, kind: 'N', value: 32, length: note.length })
			} else {
				events.push({ tick: note.tick, sortKey: 0, kind: 'N', value: noteNumber, length: note.length })
			}

			if (isDrums) {
				// Cymbal markers only emit in fourLanePro. fourLane/fiveLane omit
				// markers (cymbal/tom state is implicit); emitting them would cause
				// the parser to re-detect the chart as fourLanePro.
				if ((note.flags & noteFlags.cymbal) && drumType === 1) {
					const cymbalNote = drumCymbalNoteNumber[note.type]
					if (cymbalNote != null) {
						events.push({ tick: note.tick, sortKey: 0, kind: 'N', value: cymbalNote, length: 0 })
					}
				}

				// Accent/ghost markers match the eventType of the emitted note.
				// If we remapped green → N 5 (fiveGreen), use N 38/N 44.
				const isFiveGreenEmitted = noteNumber === 5
				if (note.flags & noteFlags.accent) {
					const accentNote = isFiveGreenEmitted ? 38 : drumAccentNoteNumber[note.type]
					if (accentNote != null) events.push({ tick: note.tick, sortKey: 0, kind: 'N', value: accentNote, length: 0 })
				}
				if (note.flags & noteFlags.ghost) {
					const ghostNote = isFiveGreenEmitted ? 44 : drumGhostNoteNumber[note.type]
					if (ghostNote != null) events.push({ tick: note.tick, sortKey: 0, kind: 'N', value: ghostNote, length: 0 })
				}
				if (note.flags & noteFlags.flam) hasFlamInGroup = true
			} else {
				if (note.flags & noteFlags.tap) {
					events.push({ tick: note.tick, sortKey: 0, kind: 'N', value: 6, length: 0 })
				}
			}
		}

		// ForceUnnatural (N 5) when natural HOPO state disagrees with the flag.
		if (!isDrums && group.length > 0) {
			const firstNote = group[0]
			const wantHopo = (firstNote.flags & noteFlags.hopo) !== 0
			const wantStrum = (firstNote.flags & noteFlags.strum) !== 0
			const natural = isNaturalHopoByGroup[gi]
			if ((wantHopo && !natural) || (wantStrum && natural)) {
				events.push({ tick: firstNote.tick, sortKey: 0, kind: 'N', value: 5, length: 0 })
			}
		}

		if (hasFlamInGroup && group.length > 0) {
			events.push({ tick: group[0].tick, sortKey: 0, kind: 'N', value: 109, length: 0 })
		}
	}

	// Disco-flip state transitions → `mix <diff> drums0[...]` text events.
	if (isDrums) {
		const diffIdx: Record<string, number> = { easy: 0, medium: 1, hard: 2, expert: 3 }
		const di = diffIdx[track.difficulty] ?? 3
		let currentState: 'off' | 'disco' | 'discoNoflip' = 'off'

		for (const group of track.noteEventGroups) {
			if (group.length === 0) continue
			let newState: 'off' | 'disco' | 'discoNoflip' = 'off'
			for (const note of group) {
				if (note.type === noteTypes.redDrum || note.type === noteTypes.yellowDrum) {
					if (note.flags & noteFlags.discoNoflip) { newState = 'discoNoflip'; break }
					if (note.flags & noteFlags.disco) { newState = 'disco'; break }
				}
			}
			if (newState !== currentState) {
				const tick = group[0].tick
				const suf = newState === 'off' ? 'drums0' : newState === 'disco' ? 'drums0d' : 'drums0dnoflip'
				events.push({ tick, sortKey: 2, kind: 'E', text: `mix ${di} ${suf}` })
				currentState = newState
			}
		}
	}

	// Sort: by tick, then N (0) before S (1) before E (2). Preserve insertion
	// order within an N-group at the same tick — chord order is load-bearing
	// for downstream YARG parent-note selection.
	events.sort((a, b) => (a.tick !== b.tick ? a.tick - b.tick : a.sortKey - b.sortKey))

	// Deduplicate exact same-tick same-value duplicates (possible after modifier
	// emission produces redundant markers).
	const deduped: TrackLineEvent[] = []
	for (const ev of events) {
		const prev = deduped[deduped.length - 1]
		if (prev && prev.tick === ev.tick && prev.kind === ev.kind) {
			if (ev.kind === 'E' && prev.kind === 'E' && prev.text === ev.text) continue
			if (ev.kind !== 'E' && prev.kind !== 'E' && prev.value === ev.value && prev.length === ev.length) continue
		}
		deduped.push(ev)
	}

	for (const ev of deduped) {
		if (ev.kind === 'E') lines.push(`  ${ev.tick} = E ${ev.text}`)
		else lines.push(`  ${ev.tick} = ${ev.kind} ${ev.value} ${ev.length}`)
	}

	lines.push('}')
	return lines
}

