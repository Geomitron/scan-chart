import { difficulties, type Difficulty, type Instrument } from '../types'
import { ChartFileTokens, chartSectionLines, chartSectionTrack, parseTrackLine } from './chart-file-parser'
import { classifyMidiInstrumentTracks, compareTickAscTypeDesc, findMidiEventsTrack, isTextLikeEvent, pairEventEnds, TrackEventEnd } from './midi-file-parser'
import { midiTokensToMidiData, MidiTokens } from './midi-tokens'
import type { EventType } from './raw-types'

/**
 * Where an authored element is in its file, so an edit can rewrite exactly that source: a `.chart` line, or the start
 * and end events of a MIDI note or phrase (indices in the track chunk's events).
 */
export type AuthoredSource =
	| { readonly format: 'chart'; readonly section: number; readonly line: number }
	| { readonly format: 'mid'; readonly chunk: number; readonly events: readonly [start: number, end: number] }

export type ChartAuthoredSource = Extract<AuthoredSource, { format: 'chart' }>
export type MidiAuthoredSource = Extract<AuthoredSource, { format: 'mid' }>

/** A note, note modifier or phrase, as the file writes it. */
export interface AuthoredEvent {
	readonly tick: number
	readonly length: number
	readonly type: EventType
	readonly source: AuthoredSource
}

export interface AuthoredTextEvent {
	readonly tick: number
	readonly text: string
	readonly source: AuthoredSource
}

export interface AuthoredVersusPhrase {
	readonly tick: number
	readonly length: number
	readonly isPlayer2: boolean
	readonly source: AuthoredSource
}

/** One instrument section of a `.chart` file, as written. */
export interface ChartAuthoredTrack {
	readonly instrument: Instrument
	readonly difficulty: Difficulty
	readonly sectionName: string
	/** Index of the section in the file's tokens. */
	readonly section: number
	/** `false` for an earlier section whose name repeats later: classification reads only the last one. */
	readonly isRead: boolean
	/** Notes, note modifiers and phrases in file order. A solo is its `solo` and `soloend` events, as written. */
	readonly events: readonly (AuthoredEvent & { readonly source: ChartAuthoredSource })[]
	readonly textEvents: readonly AuthoredTextEvent[]
	readonly versusPhrases: readonly AuthoredVersusPhrase[]
}

/**
 * Reads every instrument section of a tokenized `.chart` file, in file order with repeated sections included. Each
 * element is a line the classifier reads, parsed by the classifier's own line parser, with that line as its source.
 */
export function chartAuthoredTracks(tokens: ChartFileTokens): ChartAuthoredTrack[] {
	const lastIndexOfName = new Map<string, number>()
	tokens.sections.forEach((section, index) => lastIndexOfName.set(section.name, index))

	const tracks: ChartAuthoredTrack[] = []
	tokens.sections.forEach((section, sectionIndex) => {
		const track = chartSectionTrack(section.name)
		if (track === null) return
		const events: (AuthoredEvent & { source: ChartAuthoredSource })[] = []
		const textEvents: AuthoredTextEvent[] = []
		const versusPhrases: AuthoredVersusPhrase[] = []
		chartSectionLines(tokens, section).forEach((line, lineIndex) => {
			if (line.text === '') return
			const parsed = parseTrackLine(line.text, track.instrument, track.difficulty)
			const source: ChartAuthoredSource = { format: 'chart', section: sectionIndex, line: lineIndex }
			if (parsed?.kind === 'note') events.push({ tick: parsed.tick, length: parsed.length, type: parsed.type, source })
			else if (parsed?.kind === 'text') textEvents.push({ tick: parsed.tick, text: parsed.text, source })
			else if (parsed?.kind === 'versus') versusPhrases.push({ tick: parsed.tick, length: parsed.length, isPlayer2: parsed.isPlayer2, source })
		})
		tracks.push({
			...track,
			sectionName: section.name,
			section: sectionIndex,
			isRead: lastIndexOfName.get(section.name) === sectionIndex,
			events,
			textEvents,
			versusPhrases,
		})
	})
	return tracks
}

/** A MIDI note, note modifier or phrase, as written. */
export interface MidiAuthoredEvent extends AuthoredEvent {
	/** The difficulty whose notes hold it, or `instrument` for an event stored once for every difficulty, such as star power. */
	readonly scope: Difficulty | 'instrument'
	readonly velocity: number
	readonly channel: number
	readonly source: MidiAuthoredSource
}

/** One MIDI instrument track, as written: every difficulty's notes and the events stored once for the instrument. */
export interface MidiAuthoredTrack {
	readonly instrument: Instrument
	/** Index of the track chunk in the file's tokens. */
	readonly chunk: number
	/** `false` for a later track of an instrument with an earlier one; Clone Hero reads only the first. */
	readonly isFirst: boolean
	/**
	 * The tick of the track's `ENHANCED_OPENS` event, from which each difficulty's lowest note is an open note; `null`
	 * when the track has none.
	 */
	readonly enhancedOpensFrom: number | null
	/** Notes, note modifiers and phrases by start tick, each with the events it came from. */
	readonly events: readonly MidiAuthoredEvent[]
}

/**
 * Reads every MIDI instrument track of a tokenized `.mid` file, including a later track of the same instrument. Notes
 * and phrases are paired from their start and end events exactly as parsing pairs them.
 */
export function midiAuthoredTracks(tokens: MidiTokens): MidiAuthoredTrack[] {
	const trackChunks = tokens.chunks.flatMap((chunk, index) => chunk.kind === 'track' ? [index] : [])
	const seen = new Set<Instrument>()
	return classifyMidiInstrumentTracks(midiTokensToMidiData(tokens)).map(({ instrument, trackIndex, scan }) => {
		const chunk = trackChunks[trackIndex]
		const isFirst = !seen.has(instrument)
		seen.add(instrument)
		const events: MidiAuthoredEvent[] = []
		const read = (ends: readonly TrackEventEnd[], scope: Difficulty | 'instrument') => {
			for (const { start, end } of pairEventEnds([...ends].sort(compareTickAscTypeDesc))) {
				events.push({
					tick: start.tick,
					length: end.tick - start.tick,
					type: start.type,
					scope,
					velocity: start.velocity,
					channel: start.channel,
					source: { format: 'mid', chunk, events: [start.eventIndex, end.eventIndex] },
				})
			}
		}
		read(scan.eventEnds.all, 'instrument')
		for (const difficulty of difficulties) read(scan.eventEnds[difficulty], difficulty)
		events.sort((a, b) => a.tick - b.tick)
		const chunkEvents = tokens.chunks[chunk].kind === 'track' ? tokens.chunks[chunk].events : []
		const enhancedOpens = chunkEvents.find(({ event }) => event.type === 'text' && (event.text === 'ENHANCED_OPENS' || event.text === '[ENHANCED_OPENS]'))
		return { instrument, chunk, isFirst, enhancedOpensFrom: enhancedOpens?.tick ?? null, events }
	})
}

/** A tempo marker as written: a `.chart` `B` line, or a MIDI tempo event on the conductor track. */
export interface AuthoredTempo {
	readonly tick: number
	readonly beatsPerMinute: number
	readonly source: AuthoredSource
}

/** A time signature as written: a `.chart` `TS` line, or a MIDI time signature event on the conductor track. */
export interface AuthoredTimeSignature {
	readonly tick: number
	readonly numerator: number
	readonly denominator: number
	readonly source: AuthoredSource
}

/** What a chart stores for the whole song rather than for one instrument, as written. */
export interface AuthoredSongEvents {
	readonly tempos: readonly AuthoredTempo[]
	readonly timeSignatures: readonly AuthoredTimeSignature[]
	/**
	 * The text events of the `[Events]` section or the MIDI events track: practice sections, the end event, and any
	 * other text, such as `.chart` lyrics. `null` when the file has no such section or track.
	 */
	readonly textEvents: readonly AuthoredTextEvent[] | null
}

/**
 * Reads the tempo map, time signatures and song text events of a chart, from the section or track Clone Hero reads
 * for each: the last `[SyncTrack]` and `[Events]` section, or the conductor track and the first events track.
 */
export function authoredSongEvents(
	chart: { readonly format: 'chart'; readonly tokens: ChartFileTokens } | { readonly format: 'mid'; readonly tokens: MidiTokens },
): AuthoredSongEvents {
	const tempos: AuthoredTempo[] = []
	const timeSignatures: AuthoredTimeSignature[] = []
	if (chart.format === 'chart') {
		const { tokens } = chart
		const lastSection = (name: string) => tokens.sections.reduce((last, section, index) => section.name === name ? index : last, -1)
		const lines = (section: number) => section === -1 ? [] : chartSectionLines(tokens, tokens.sections[section])
		const syncTrack = lastSection('SyncTrack')
		lines(syncTrack).forEach((line, lineIndex) => {
			const source: ChartAuthoredSource = { format: 'chart', section: syncTrack, line: lineIndex }
			const tempo = /^(\d+) = B (\d+)$/.exec(line.text)
			const timeSignature = /^(\d+) = TS (\d+)(?: (\d+))?$/.exec(line.text)
			if (tempo) tempos.push({ tick: Number(tempo[1]), beatsPerMinute: Number(tempo[2]) / 1000, source })
			if (timeSignature) {
				const denominator = timeSignature[3] ? Math.pow(2, Number(timeSignature[3])) : 4
				timeSignatures.push({ tick: Number(timeSignature[1]), numerator: Number(timeSignature[2]), denominator, source })
			}
		})
		const events = lastSection('Events')
		const textEvents = lines(events).flatMap((line, lineIndex): AuthoredTextEvent[] => {
			const match = /^(\d+) = E "([^\r\n]*?)"$/.exec(line.text)
			return match ? [{ tick: Number(match[1]), text: match[2], source: { format: 'chart', section: events, line: lineIndex } }] : []
		})
		return { tempos, timeSignatures, textEvents: events === -1 ? null : textEvents }
	}

	const { tokens } = chart
	const trackChunks = tokens.chunks.flatMap((chunk, index) => chunk.kind === 'track' ? [index] : [])
	const eventsOf = (chunk: number | undefined) => {
		const found = chunk === undefined ? undefined : tokens.chunks[chunk]
		return found?.kind === 'track' ? found.events : []
	}
	const conductor = trackChunks[0]
	eventsOf(conductor).forEach(({ tick, event }, eventIndex) => {
		const source: MidiAuthoredSource = { format: 'mid', chunk: conductor, events: [eventIndex, eventIndex] }
		if (event.type === 'setTempo') tempos.push({ tick, beatsPerMinute: 60000000 / event.microsecondsPerBeat, source })
		if (event.type === 'timeSignature') timeSignatures.push({ tick, numerator: event.numerator, denominator: event.denominator, source })
	})
	const eventsTrack = findMidiEventsTrack(midiTokensToMidiData(tokens))
	const eventsChunk = eventsTrack === null ? undefined : trackChunks[eventsTrack]
	const textEvents = eventsOf(eventsChunk).flatMap(({ tick, event }, eventIndex): AuthoredTextEvent[] =>
		isTextLikeEvent(event) ? [{ tick, text: event.text, source: { format: 'mid', chunk: eventsChunk!, events: [eventIndex, eventIndex] } }] : [])
	return { tempos, timeSignatures, textEvents: eventsChunk === undefined ? null : textEvents }
}

/** An authored event of one track, in either format. */
export interface AuthoredTrackEvent extends AuthoredEvent {
	/** The track's difficulty when the file stores the event for it alone, or `instrument` when stored once for all. */
	readonly scope: Difficulty | 'instrument'
}

/**
 * The authored events of one track, in either format: everything the file stores for that instrument and difficulty,
 * including events stored once for the whole instrument. Reads the section or MIDI track Clone Hero reads. Returns
 * `null` when the file has no such track.
 */
export function authoredTrack(
	chart: { readonly format: 'chart'; readonly tokens: ChartFileTokens } | { readonly format: 'mid'; readonly tokens: MidiTokens },
	instrument: Instrument,
	difficulty: Difficulty,
): readonly AuthoredTrackEvent[] | null {
	if (chart.format === 'chart') {
		const section = chartAuthoredTracks(chart.tokens).find(track => track.isRead && track.instrument === instrument && track.difficulty === difficulty)
		return section?.events.map(event => ({ ...event, scope: difficulty })) ?? null
	}
	const track = midiAuthoredTracks(chart.tokens).find(candidate => candidate.isFirst && candidate.instrument === instrument)
	if (!track) return null
	const events = track.events.filter(event => event.scope === difficulty || event.scope === 'instrument')
	return events.some(event => event.scope === difficulty) ? events : null
}

/** How a format stores a feature: for each difficulty, once for the instrument, on each note, or not at all. */
export type FormatSupport = 'perDifficulty' | 'perInstrument' | 'perNote' | 'kept' | 'unsupported'

/**
 * What each chart format can express. An editor targeting a format offers only what it supports; converting to a
 * format reports what it can't hold.
 */
export const chartFormatCapabilities = {
	chart: {
		starPower: 'perDifficulty',
		solos: 'perDifficulty',
		drumFills: 'perDifficulty',
		cymbalsAndToms: 'perNote',
		rollLanes: 'perDifficulty',
		flam: 'unsupported',
		accentsAndGhosts: 'perNote',
		kickDynamics: 'unsupported',
		lyrics: 'perInstrument',
		vocalNotes: 'unsupported',
		harmonies: 'unsupported',
		venue: 'unsupported',
	},
	mid: {
		starPower: 'perInstrument',
		solos: 'perInstrument',
		drumFills: 'perInstrument',
		cymbalsAndToms: 'perInstrument',
		rollLanes: 'perInstrument',
		flam: 'perInstrument',
		accentsAndGhosts: 'perNote',
		kickDynamics: 'unsupported',
		lyrics: 'perInstrument',
		vocalNotes: 'perInstrument',
		harmonies: 'perInstrument',
		venue: 'kept',
	},
} as const satisfies Record<'chart' | 'mid', Record<string, FormatSupport>>
