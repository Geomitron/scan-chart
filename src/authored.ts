import {
	AuthoredSongEvents,
	AuthoredSource,
	authoredSongEvents as viewSongEvents,
	AuthoredTextEvent,
	chartAuthoredTracks,
	chartFormatCapabilities,
	FormatSupport,
	midiAuthoredTracks,
} from './chart/authored-view'
import type { ChartFormat } from './gameplay-chart'
import { EventType, eventTypes } from './chart/raw-types'
import type { ChartDocument } from './song-document'
import { Difficulty, getInstrumentType, Instrument, InstrumentType, instrumentTypes } from './types'

/** An event type, by name: a note, a note modifier or a phrase, such as `green`, `forceTap` or `starPower`. */
export type AuthoredEventType = Exclude<keyof typeof eventTypes, 'rejectedStarPower'>

/** A note, note modifier or phrase, as the file writes it. */
export interface AuthoredEvent {
	readonly tick: number
	readonly length: number
	readonly type: AuthoredEventType
	/** The difficulty the file stores it for, or `instrument` when it's stored once for every difficulty. */
	readonly scope: Difficulty | 'instrument'
	/** The MIDI note's velocity and channel; `null` in a `.chart` file. */
	readonly velocity: number | null
	readonly channel: number | null
	readonly source: AuthoredSource
}

/** One instrument track as the file writes it: a `.chart` section, or a MIDI track, which holds every difficulty. */
export interface AuthoredTrack {
	readonly instrument: Instrument
	/** The difficulty of a `.chart` section; `null` for a MIDI track. */
	readonly difficulty: Difficulty | null
	/** Whether Clone Hero reads it: `false` for an earlier `.chart` section whose name repeats, or a later MIDI track of an instrument. */
	readonly isRead: boolean
	/** Notes, note modifiers and phrases, by tick. */
	readonly events: readonly AuthoredEvent[]
	readonly textEvents: readonly AuthoredTextEvent[]
	/** Where it is in the file: the `.chart` section's or the MIDI track chunk's index in the file's tokens. */
	readonly location: { readonly format: 'chart'; readonly section: number } | { readonly format: 'mid'; readonly chunk: number }
}

const typeNames = new Map<EventType, AuthoredEventType>(
	(Object.entries(eventTypes) as [keyof typeof eventTypes, EventType][]).flatMap(([name, type]) => name === 'rejectedStarPower' ? [] : [[type, name]]))

/** The event type a name stands for. Throws for a name that isn't one. */
export function eventTypeOf(name: AuthoredEventType): EventType {
	const type = typeNames.has(eventTypes[name]) ? eventTypes[name] : undefined
	if (type === undefined) throw new RangeError(`"${name}" isn't an event type`)
	return type
}

/** Every instrument track of a chart file, as the file writes it, in file order. Empty for a `.mid` file that can't be read. */
export function authoredTracks(chart: ChartDocument): readonly AuthoredTrack[] {
	if (chart.format === 'chart') {
		return chartAuthoredTracks(chart.tokens).map(track => publicTrack(track, () => ({
			instrument: track.instrument,
			difficulty: track.difficulty,
			isRead: track.isRead,
			events: track.events.flatMap(event => {
				const type = typeNames.get(event.type)
				return type === undefined ? [] : [{ tick: event.tick, length: event.length, type, scope: track.difficulty, velocity: null, channel: null, source: event.source }]
			}),
			textEvents: track.textEvents,
			location: { format: 'chart', section: track.section },
		})))
	}
	if (chart.tokens === null) return []
	return midiAuthoredTracks(chart.tokens).map(track => publicTrack(track, () => ({
		instrument: track.instrument,
		difficulty: null,
		isRead: track.isFirst,
		events: track.events.flatMap(event => {
			const type = typeNames.get(event.type)
			return type === undefined ? [] : [{ tick: event.tick, length: event.length, type, scope: event.scope, velocity: event.velocity, channel: event.channel, source: event.source }]
		}),
		textEvents: [],
		location: { format: 'mid', chunk: track.chunk },
	})))
}

/**
 * The tempo map, time signatures and song text events of a chart file, as written, from the section or track Clone
 * Hero reads for each. Empty for a `.mid` file that can't be read.
 */
export function authoredSongEvents(chart: ChartDocument): AuthoredSongEvents {
	if (chart.format === 'chart') return viewSongEvents(chart)
	return chart.tokens === null ? { tempos: [], timeSignatures: [], textEvents: null } : viewSongEvents({ format: 'mid', tokens: chart.tokens })
}

/** What a chart format can store, and how: for each difficulty, once for the instrument, per note, or not at all. */
export type ChartCapabilities = { readonly [feature in keyof (typeof chartFormatCapabilities)['chart']]: FormatSupport }

/** What `format` can store: `addEvent` refuses what it can't, and conversion reports it. */
export function chartCapabilities(format: ChartFormat): ChartCapabilities {
	return chartFormatCapabilities[format]
}

// The authored views keep their unchanged tracks across an edit, so the public form of each is kept with it.
const publicTracks = new WeakMap<object, AuthoredTrack>()

function publicTrack(track: object, make: () => AuthoredTrack): AuthoredTrack {
	let made = publicTracks.get(track)
	if (made === undefined) {
		made = make()
		publicTracks.set(track, made)
	}
	return made
}

const fretPhrases: readonly EventType[] = [eventTypes.starPower, eventTypes.soloSection, eventTypes.soloSectionStart, eventTypes.soloSectionEnd]
const fretModifiers: readonly EventType[] = [eventTypes.forceTap, eventTypes.forceStrum, eventTypes.forceHopo, eventTypes.forceUnnatural]

/**
 * The event types that mean something on each kind of instrument. A format may still be unable to write one (a
 * forced HOPO in `.chart`, say); its encoder refuses that separately. Kick accents and ghosts aren't here: the
 * canonical rules ignore kick dynamics (C17).
 */
const meaningfulTypes: { readonly [type in InstrumentType]: ReadonlySet<EventType> } = {
	[instrumentTypes.fiveFret]: new Set([
		...fretPhrases, ...fretModifiers, eventTypes.forceOpen, eventTypes.flexLaneSingle, eventTypes.flexLaneDouble,
		eventTypes.open, eventTypes.green, eventTypes.red, eventTypes.yellow, eventTypes.blue, eventTypes.orange,
	]),
	[instrumentTypes.sixFret]: new Set([
		...fretPhrases, ...fretModifiers,
		eventTypes.open, eventTypes.black1, eventTypes.black2, eventTypes.black3, eventTypes.white1, eventTypes.white2, eventTypes.white3,
	]),
	[instrumentTypes.drums]: new Set([
		...fretPhrases, eventTypes.flexLaneSingle, eventTypes.flexLaneDouble, eventTypes.freestyleSection,
		eventTypes.kick, eventTypes.kick2x, eventTypes.redDrum, eventTypes.yellowDrum, eventTypes.blueDrum,
		eventTypes.fiveOrangeFourGreenDrum, eventTypes.fiveGreenDrum, eventTypes.forceFlam,
		eventTypes.yellowTomMarker, eventTypes.blueTomMarker, eventTypes.greenTomMarker,
		eventTypes.yellowCymbalMarker, eventTypes.blueCymbalMarker, eventTypes.greenCymbalMarker,
		eventTypes.redGhost, eventTypes.yellowGhost, eventTypes.blueGhost, eventTypes.fiveOrangeFourGreenGhost, eventTypes.fiveGreenGhost,
		eventTypes.redAccent, eventTypes.yellowAccent, eventTypes.blueAccent, eventTypes.fiveOrangeFourGreenAccent, eventTypes.fiveGreenAccent,
		eventTypes.discoFlipOff, eventTypes.discoFlipOn, eventTypes.discoNoFlipOn, eventTypes.enableChartDynamics,
	]),
}

/** Throws, with the reason, if an event of `type` means nothing on `instrument`. */
export function assertMeaningful(instrument: Instrument, type: EventType): void {
	if (!meaningfulTypes[getInstrumentType(instrument)].has(type)) {
		throw new RangeError(`A ${typeNames.get(type) ?? type} event means nothing on ${instrument}`)
	}
}
