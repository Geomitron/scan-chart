import { describe, expect, it } from 'vitest'

import { readChartEventsText, readMidiEventsText, readMidiEventsVocalText, textInFirstBrackets } from 'src/chart/song-events'

describe('song-wide events: the bracket rule', () => {
	it('takes the text between the first [ and the ] that closes it, counting nested pairs', () => {
		expect(textInFirstBrackets('asdf[section Chorus [2]]asdf')).toBe('section Chorus [2]')
		expect(textInFirstBrackets('[prc_intro] - Intro [2]')).toBe('prc_intro')
		expect(textInFirstBrackets('[section chorus_2c]]')).toBe('section chorus_2c')
		expect(textInFirstBrackets('[coda')).toBeNull()
		expect(textInFirstBrackets('coda]')).toBeNull()
		expect(textInFirstBrackets('no brackets')).toBeNull()
	})

	// The bracket rule's examples from its definition, in both formats.
	const examples: [string, string | null][] = [
		['section Chorus [2]', 'section:Chorus [2]'],
		['section asdf[section Chorus [2]]asdf', 'section:asdf[section Chorus [2]]asdf'],
		['[section Intro]', 'section:Intro'],
		['asdf[section Chorus [2]]asdf', 'section:Chorus [2]'],
		['[prc_intro] - Intro', 'section:intro'],
		['[section chorus_2c]]', 'section:chorus_2c'],
		['[coda]', 'coda'],
		['[coda] - Big Rock Ending', 'coda'],
		['[coda', 'coda'],
		['[section Chorus 2', 'section:Chorus 2'],
		['[prc_Chorus 2B}', 'section:Chorus 2B}'],
		['coda]', null],
		['x [coda', null],
		[' [end] ', 'end'],
		['[ section Intro]', null],
		['[ coda', null],
		// The text after an unclosed `[` is read as written, without the rule again.
		['[[coda]', null],
		['[section a[b]', 'section:a[b]'],
		['[', null],
		['[]', null],
		['', null],
	]
	const reading = (event: { type: string; name?: string } | null) => event === null ? null : event.type === 'section' ? `section:${event.name}` : event.type

	it.each(examples)('.chart [Events] %j reads as %j', (text, expected) => {
		expect(reading(readChartEventsText(text))).toBe(expected)
	})

	it.each(examples)('.mid EVENTS %j reads as %j', (text, expected) => {
		expect(reading(readMidiEventsText(text))).toBe(expected)
	})

	it('keeps each format\'s name and vocal rules', () => {
		// .chart trims a section name, .mid keeps the spaces at its ends, as Clone Hero does.
		expect(readChartEventsText('[section  Intro ]')).toEqual({ type: 'section', name: 'Intro' })
		expect(readMidiEventsText('[section  Intro ]')).toEqual({ type: 'section', name: ' Intro ' })
		// A text that is an event as written stays that event: in [Events], this is a lyric, not a section.
		expect(readChartEventsText('lyric [section X]')).toEqual({ type: 'vocals' })
		expect(readChartEventsText('lyric x [coda]')).toEqual({ type: 'vocals' })
		// EVENTS holds no lyrics, so a lyric there is no event for the rule, and the coda in its brackets is read.
		expect(readMidiEventsText('lyric x [coda]')).toEqual({ type: 'coda' })
		expect(readMidiEventsText('lyric [section X]')).toEqual({ type: 'section', name: 'X' })
		// Inside brackets, the text is read as written: a lyric there, whose own brackets hold the coda.
		expect(readChartEventsText('[lyric x [coda]]')).toEqual({ type: 'vocals' })
		expect(readMidiEventsText('[lyric x [coda]]')).toBeNull()
		expect(readMidiEventsVocalText('[lyric x [coda]]')).toEqual({ type: 'lyric' })
	})

	it('reads a misplaced lyric or phrase event in EVENTS by the same steps, where the text holds no song-wide event', () => {
		expect(readMidiEventsVocalText('[lyric hello] there')).toEqual({ type: 'lyric' })
		expect(readMidiEventsVocalText('lyric\thello')).toEqual({ type: 'lyric' })
		expect(readMidiEventsVocalText('[phrase_start')).toEqual({ type: 'phraseStart' })
		expect(readMidiEventsVocalText(' [phrase_end] ')).toEqual({ type: 'phraseEnd' })
		expect(readMidiEventsVocalText('lyric x [coda]')).toBeNull()
		expect(readMidiEventsVocalText('lyric')).toBeNull()
		expect(readMidiEventsVocalText('[crowd_clap]')).toBeNull()
	})
})
