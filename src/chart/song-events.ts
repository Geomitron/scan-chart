/**
 * Song-wide events: the text of a `.chart` file's `[Events]` lines and of the text events (`FF 01`) in a `.mid` file's
 * `EVENTS` track. Both formats read them by one bracket rule, so this module is where readers and writers find what a
 * text holds.
 */
import { trimDotnet } from '../shared/text'

/**
 * The text that holds an event, by the bracket rule: the text without white space around it, as Clone Hero trims it,
 * when `isEvent` takes it as written. Otherwise the text between its first `[` and the `]` that closes it, counting
 * nested pairs, or, when the text starts with a `[` that no `]` closes, the text after that `[`, without trimming it
 * again, when `isEvent` takes that. `null` for text that holds no event, so `section Verse [2]` holds
 * `section Verse [2]`, `[prc_intro] "Intro"` holds `prc_intro`, and `[section Chorus 2` holds `section Chorus 2`.
 */
function eventText(rawText: string, isEvent: (text: string) => boolean): string | null {
	const text = trimDotnet(rawText)
	if (isEvent(text)) return text
	const inner = textInFirstBrackets(text) ?? (text.startsWith('[') ? text.slice(1) : null)
	return inner !== null && isEvent(inner) ? inner : null
}

/** The text between the first `[` and the `]` that closes it, counting nested pairs, or `null` when no `]` closes it. */
export function textInFirstBrackets(text: string): string | null {
	const start = text.indexOf('[')
	if (start === -1) return null
	let depth = 0
	for (let i = start; i < text.length; i++) {
		if (text[i] === '[') depth++
		else if (text[i] === ']' && --depth === 0) return text.slice(start + 1, i)
	}
	return null
}

/** An event a reader acts on in a `.chart` file's `[Events]` section: `vocals` is a lyric or a vocal phrase event. */
export type ChartEventsEvent = { type: 'section'; name: string } | { type: 'end' | 'coda' | 'vocals' }

/**
 * The event `.chart` `[Events]` text is as written. A section is `section NAME` or `prc NAME`, with a space or `_`
 * before the name, which is trimmed; an empty name isn't a section. A lyric is `lyric` alone or `lyric ` and its text.
 */
function chartEventsEventAsWritten(text: string): ChartEventsEvent | null {
	const name = /^(?:section|prc)[ _](.*)$/.exec(text)?.[1].trim()
	if (name) return { type: 'section', name }
	if (text === 'end' || text === 'coda') return { type: text }
	if (text === 'lyric' || text.startsWith('lyric ') || text === 'phrase_start' || text === 'phrase_end') return { type: 'vocals' }
	return null
}

/** The text of a `.chart` `[Events]` line that holds its event, by the bracket rule, or `null` for text that holds none. */
export function chartEventsEventText(rawText: string): string | null {
	return eventText(rawText, text => chartEventsEventAsWritten(text) !== null)
}

/** The event the text of a `.chart` `[Events]` line holds, or `null` for text no reader acts on. */
export function readChartEventsText(rawText: string): ChartEventsEvent | null {
	const text = chartEventsEventText(rawText)
	return text === null ? null : chartEventsEventAsWritten(text)
}

/** A song-wide event in a `.mid` file's `EVENTS` text events. */
export type MidiEventsEvent = { type: 'section'; name: string } | { type: 'end' | 'coda' }

/**
 * The song-wide event `.mid` `EVENTS` text is as written. A section is `section NAME` or `prc NAME`, with a space or
 * `_` before the name, which keeps any spaces at its ends, as Clone Hero keeps them.
 */
function midiEventsEventAsWritten(text: string): MidiEventsEvent | null {
	const section = /^(?:section|prc)[ _](.*)$/.exec(text)
	if (section) return { type: 'section', name: section[1] }
	if (text === 'end' || text === 'coda') return { type: text }
	return null
}

/**
 * The song-wide event the text of a `.mid` `EVENTS` text event holds, by the bracket rule, or `null` for text that
 * holds none. A lyric or vocal phrase event isn't one, since `EVENTS` holds no lyrics, so `lyric x [coda]` holds the
 * coda.
 */
export function readMidiEventsText(rawText: string): MidiEventsEvent | null {
	const text = eventText(rawText, text => midiEventsEventAsWritten(text) !== null)
	return text === null ? null : midiEventsEventAsWritten(text)
}

/**
 * A lyric or vocal phrase event in a `.mid` file's `EVENTS` text events. It's misplaced there: it belongs in a vocal
 * track, Clone Hero ignores it, YARG reads it as a lyric, and scan-chart reports it.
 */
export type MidiEventsVocalEvent = { type: 'lyric' | 'phraseStart' | 'phraseEnd' }

/** The vocal event `.mid` `EVENTS` text is as written. A lyric is `lyric` and a space or tab. */
function midiEventsVocalEventAsWritten(text: string): MidiEventsVocalEvent | null {
	if (/^lyric[ \t]/.test(text)) return { type: 'lyric' }
	if (text === 'phrase_start') return { type: 'phraseStart' }
	if (text === 'phrase_end') return { type: 'phraseEnd' }
	return null
}

/**
 * The misplaced lyric or vocal phrase event the text of a `.mid` `EVENTS` text event holds, read by the bracket rule's
 * steps, or `null` for text that holds none, or that holds a song-wide event.
 */
export function readMidiEventsVocalText(rawText: string): MidiEventsVocalEvent | null {
	if (readMidiEventsText(rawText) !== null) return null
	const text = eventText(rawText, text => midiEventsVocalEventAsWritten(text) !== null)
	return text === null ? null : midiEventsVocalEventAsWritten(text)
}
