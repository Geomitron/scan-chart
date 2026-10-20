import { describe, expect, it } from 'vitest'

import { readChartEventsText, readMidiEventsText, textInFirstBrackets } from 'src/chart/song-events'

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
		['[coda', null],
		[' [end] ', 'end'],
		['[ section Intro]', null],
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
		// A text that is an event as written stays that event: this is a lyric, not a section.
		expect(readChartEventsText('lyric [section X]')).toEqual({ type: 'vocals' })
		expect(readMidiEventsText('[lyric hello] there')).toEqual({ type: 'lyric' })
	})
})
