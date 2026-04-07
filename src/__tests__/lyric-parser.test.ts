import { describe, it, expect } from 'vitest'
import { parseMidi } from 'midi-file'
import {
	parseChartLyricLine,
	parseChartVocalPhraseLine,
	extractChartLyrics,
	extractChartVocalPhrases,
	isMidiVocalLyric,
	normalizeLyricText,
	extractMidiLyricText,
	extractMidiLyrics,
	extractMidiVocalPhrases,
} from '../chart/lyric-parser'

// ---------------------------------------------------------------------------
// parseChartLyricLine
// ---------------------------------------------------------------------------

describe('parseChartLyricLine', () => {
	it('parses a standard lyric line', () => {
		expect(parseChartLyricLine('480 = E "lyric Hello"')).toEqual({ tick: 480, text: 'Hello' })
	})

	it('parses lyric with special characters', () => {
		expect(parseChartLyricLine('960 = E "lyric Hel+"')).toEqual({ tick: 960, text: 'Hel+' })
	})

	it('parses lyric with hash (syllable boundary)', () => {
		expect(parseChartLyricLine('480 = E "lyric Cha#"')).toEqual({ tick: 480, text: 'Cha#' })
	})

	it('parses lyric with dash (word continuation)', () => {
		expect(parseChartLyricLine('480 = E "lyric to-"')).toEqual({ tick: 480, text: 'to-' })
	})

	it('parses lyric with equals sign', () => {
		expect(parseChartLyricLine('480 = E "lyric =§#"')).toEqual({ tick: 480, text: '=§#' })
	})

	it('parses lyric that is just a symbol', () => {
		expect(parseChartLyricLine('480 = E "lyric +"')).toEqual({ tick: 480, text: '+' })
	})

	it('parses lyric with spaces', () => {
		expect(parseChartLyricLine('480 = E "lyric hello world"')).toEqual({ tick: 480, text: 'hello world' })
	})

	it('returns null for non-lyric E events', () => {
		expect(parseChartLyricLine('480 = E "section_intro"')).toBeNull()
	})

	it('returns null for solo events', () => {
		expect(parseChartLyricLine('480 = E "solo"')).toBeNull()
	})

	it('returns null for phrase_start', () => {
		expect(parseChartLyricLine('480 = E "phrase_start"')).toBeNull()
	})

	it('returns null for N events', () => {
		expect(parseChartLyricLine('480 = N 0 100')).toBeNull()
	})

	it('returns null for empty string', () => {
		expect(parseChartLyricLine('')).toBeNull()
	})

	it('parses lyric with missing closing quote (lenient)', () => {
		expect(parseChartLyricLine('480 = E "lyric got')).toEqual({ tick: 480, text: 'got' })
	})

	it('parses lyric with missing closing quote and spaces', () => {
		expect(parseChartLyricLine('480 = E "lyric hello world')).toEqual({ tick: 480, text: 'hello world' })
	})

	it('parses empty lyric (space between lyric and closing quote)', () => {
		expect(parseChartLyricLine('480 = E "lyric "')).toEqual({ tick: 480, text: '' })
	})

	it('parses empty lyric (no space)', () => {
		expect(parseChartLyricLine('480 = E "lyric"')).toEqual({ tick: 480, text: '' })
	})

	it('handles embedded \\r before closing quote', () => {
		expect(parseChartLyricLine('480 = E "lyric hello\r"')).toEqual({ tick: 480, text: 'hello\r' })
	})

	it('handles embedded \\r in lyric text', () => {
		expect(parseChartLyricLine('480 = E "lyric Chart by Someone\r"')).toEqual({ tick: 480, text: 'Chart by Someone\r' })
	})

	it('parses lyric with leading space before "lyric" keyword', () => {
		expect(parseChartLyricLine('480 = E " lyric hey"')).toEqual({ tick: 480, text: 'hey' })
	})

	it('parses lyric with multiple leading spaces before "lyric"', () => {
		expect(parseChartLyricLine('480 = E "  lyric hello"')).toEqual({ tick: 480, text: 'hello' })
	})
})

// ---------------------------------------------------------------------------
// parseChartVocalPhraseLine
// ---------------------------------------------------------------------------

describe('parseChartVocalPhraseLine', () => {
	it('parses phrase_start', () => {
		expect(parseChartVocalPhraseLine('480 = E "phrase_start"')).toEqual({ tick: 480, type: 'start' })
	})

	it('parses phrase_end', () => {
		expect(parseChartVocalPhraseLine('960 = E "phrase_end"')).toEqual({ tick: 960, type: 'end' })
	})

	it('returns null for lyric events', () => {
		expect(parseChartVocalPhraseLine('480 = E "lyric Hello"')).toBeNull()
	})

	it('returns null for section events', () => {
		expect(parseChartVocalPhraseLine('480 = E "section_intro"')).toBeNull()
	})
})

// ---------------------------------------------------------------------------
// extractChartLyrics
// ---------------------------------------------------------------------------

describe('extractChartLyrics', () => {
	it('extracts lyrics from mixed event lines', () => {
		const lines = [
			'480 = E "phrase_start"',
			'960 = E "lyric Hello"',
			'1440 = E "lyric World"',
			'1920 = E "phrase_end"',
		]
		const lyrics = extractChartLyrics(lines)
		expect(lyrics).toHaveLength(2)
		expect(lyrics[0]).toEqual({ tick: 960, length: 0, text: 'Hello' })
		expect(lyrics[1]).toEqual({ tick: 1440, length: 0, text: 'World' })
	})

	it('returns empty for no lyrics', () => {
		const lines = ['480 = E "section_intro"', '960 = E "phrase_start"']
		expect(extractChartLyrics(lines)).toHaveLength(0)
	})

	it('filters bracketed annotations from lyrics', () => {
		const lines = [
			'480 = E "lyric Hello"',
			'960 = E "lyric [Everyone liked that]"',
			'1440 = E "lyric World"',
		]
		const lyrics = extractChartLyrics(lines)
		expect(lyrics).toHaveLength(2)
		expect(lyrics[0].text).toBe('Hello')
		expect(lyrics[1].text).toBe('World')
	})

	it('filters lyrics with brackets mid-text', () => {
		const lines = [
			'480 = E "lyric [screams for eight seconds]"',
		]
		expect(extractChartLyrics(lines)).toHaveLength(0)
	})

	it('filters lyrics with featuring annotation in brackets', () => {
		const lines = [
			'480 = E "lyric Single: December (again) [feat. Mark Hoppus]"',
		]
		expect(extractChartLyrics(lines)).toHaveLength(0)
	})

	it('deduplicates exact duplicate lyrics at same tick', () => {
		const lines = [
			'480 = E "lyric Gold"',
			'480 = E "lyric Gold"',
			'960 = E "lyric Silver"',
		]
		const lyrics = extractChartLyrics(lines)
		expect(lyrics).toHaveLength(2)
		expect(lyrics[0].text).toBe('Gold')
		expect(lyrics[1].text).toBe('Silver')
	})

	it('deduplicates lyrics at same tick with trailing whitespace difference', () => {
		// "lyric _" and "lyric _ " at same tick should dedup (trailing space stripped in key)
		const lines = [
			'480 = E "lyric _"',
			'480 = E "lyric _ "',
		]
		const lyrics = extractChartLyrics(lines)
		expect(lyrics).toHaveLength(1)
		expect(lyrics[0].text).toBe('_')
	})

	it('keeps different lyrics at same tick', () => {
		const lines = [
			'480 = E "lyric Hello"',
			'480 = E "lyric World"',
		]
		const lyrics = extractChartLyrics(lines)
		expect(lyrics).toHaveLength(2)
	})

	it('keeps multiple duplicate lyrics at different ticks', () => {
		const lines = [
			'480 = E "lyric Gold"',
			'960 = E "lyric Gold"',
		]
		const lyrics = extractChartLyrics(lines)
		expect(lyrics).toHaveLength(2)
	})
})

// ---------------------------------------------------------------------------
// extractChartVocalPhrases
// ---------------------------------------------------------------------------

describe('extractChartVocalPhrases', () => {
	it('pairs phrase_start with phrase_end', () => {
		const lines = [
			'480 = E "phrase_start"',
			'960 = E "lyric Hello"',
			'1440 = E "phrase_end"',
		]
		const phrases = extractChartVocalPhrases(lines)
		expect(phrases).toHaveLength(1)
		expect(phrases[0]).toEqual({ tick: 480, length: 960 })
	})

	it('handles multiple phrases', () => {
		const lines = [
			'480 = E "phrase_start"',
			'1440 = E "phrase_end"',
			'1920 = E "phrase_start"',
			'2880 = E "phrase_end"',
		]
		const phrases = extractChartVocalPhrases(lines)
		expect(phrases).toHaveLength(2)
		expect(phrases[0]).toEqual({ tick: 480, length: 960 })
		expect(phrases[1]).toEqual({ tick: 1920, length: 960 })
	})

	it('handles back-to-back phrase_start (closes previous)', () => {
		const lines = [
			'480 = E "phrase_start"',
			'960 = E "phrase_start"',
			'1440 = E "phrase_end"',
		]
		const phrases = extractChartVocalPhrases(lines)
		expect(phrases).toHaveLength(2)
		expect(phrases[0]).toEqual({ tick: 480, length: 480 })
		expect(phrases[1]).toEqual({ tick: 960, length: 480 })
	})

	it('ignores orphaned phrase_end', () => {
		const lines = [
			'480 = E "phrase_end"',
			'960 = E "phrase_start"',
			'1440 = E "phrase_end"',
		]
		const phrases = extractChartVocalPhrases(lines)
		expect(phrases).toHaveLength(1)
		expect(phrases[0]).toEqual({ tick: 960, length: 480 })
	})
})

// ---------------------------------------------------------------------------
// isMidiVocalLyric
// ---------------------------------------------------------------------------

describe('isMidiVocalLyric', () => {
	it('FF 05 lyrics event is a lyric', () => {
		expect(isMidiVocalLyric({ type: 'lyrics', text: 'Hello' })).toBe(true)
	})

	it('FF 01 text event without brackets is a lyric', () => {
		expect(isMidiVocalLyric({ type: 'text', text: 'Hello' })).toBe(true)
	})

	it('bracketed lyrics event is NOT a lyric ([play])', () => {
		expect(isMidiVocalLyric({ type: 'lyrics', text: '[play]' })).toBe(false)
	})

	it('bracketed text event is NOT a lyric ([idle])', () => {
		expect(isMidiVocalLyric({ type: 'text', text: '[idle]' })).toBe(false)
	})

	it('bracketed with spaces is NOT a lyric', () => {
		expect(isMidiVocalLyric({ type: 'lyrics', text: ' [idle_realtime] ' })).toBe(false)
	})

	it('noteOn is not a lyric', () => {
		expect(isMidiVocalLyric({ type: 'noteOn' })).toBe(false)
	})

	it('empty lyrics IS a lyric (YARG stores as "lyric ")', () => {
		expect(isMidiVocalLyric({ type: 'lyrics', text: '' })).toBe(true)
	})

	it('space-only lyrics IS a lyric (TrimAscii → empty → "lyric ")', () => {
		expect(isMidiVocalLyric({ type: 'lyrics', text: '   ' })).toBe(true)
	})

	it('empty text event IS a lyric on PART VOCALS', () => {
		expect(isMidiVocalLyric({ type: 'text', text: '' })).toBe(true)
	})

	it('syllable with hash is a lyric', () => {
		expect(isMidiVocalLyric({ type: 'lyrics', text: 'Cha#' })).toBe(true)
	})

	it('syllable with plus is a lyric (pitch slide)', () => {
		expect(isMidiVocalLyric({ type: 'lyrics', text: 'oh+' })).toBe(true)
	})

	it('marker type IS a lyric on PART VOCALS', () => {
		expect(isMidiVocalLyric({ type: 'marker', text: 'verse' })).toBe(true)
	})

	it('instrumentName type is NOT a lyric (contains track name, not lyrics)', () => {
		expect(isMidiVocalLyric({ type: 'instrumentName', text: 'PART VOCALS' })).toBe(false)
	})

	it('UTF-8 multibyte text is a lyric', () => {
		expect(isMidiVocalLyric({ type: 'lyrics', text: 'café' })).toBe(true)
	})

	it('text with leading space (no bracket) is a lyric', () => {
		expect(isMidiVocalLyric({ type: 'text', text: ' hey^' })).toBe(true)
	})

	it('bracketed annotation in lyrics type is NOT a lyric', () => {
		expect(isMidiVocalLyric({ type: 'lyrics', text: '[Everyone liked that]' })).toBe(false)
	})

	it('text starting with HTML tags is still a lyric (HTML not stripped at parse time)', () => {
		// HTML tags are stripped at rendering time, not parse time
		expect(isMidiVocalLyric({ type: 'lyrics', text: '<sub><i>[REIMAGINED]</i>' })).toBe(true)
	})
})

// ---------------------------------------------------------------------------
// extractMidiLyrics
// ---------------------------------------------------------------------------

describe('extractMidiLyrics', () => {
	it('extracts lyrics from lyric events', () => {
		const events = [
			{ deltaTime: 0, type: 'trackName' as const, text: 'PART VOCALS' },
			{ deltaTime: 480, type: 'lyrics' as const, text: 'Hel+' },
			{ deltaTime: 960, type: 'lyrics' as const, text: 'lo' },
		]
		const lyrics = extractMidiLyrics(events as any)
		expect(lyrics).toHaveLength(2)
		expect(lyrics[0]).toEqual({ tick: 480, length: 0, text: 'Hel+' })
		expect(lyrics[1]).toEqual({ tick: 960, length: 0, text: 'lo' })
	})

	it('extracts lyrics from bare text events', () => {
		const events = [
			{ deltaTime: 0, type: 'trackName' as const, text: 'PART VOCALS' },
			{ deltaTime: 480, type: 'text' as const, text: 'Life' },
			{ deltaTime: 960, type: 'text' as const, text: 'is' },
		]
		const lyrics = extractMidiLyrics(events as any)
		expect(lyrics).toHaveLength(2)
		expect(lyrics[0]).toEqual({ tick: 480, length: 0, text: 'Life' })
	})

	it('filters out bracketed control events', () => {
		const events = [
			{ deltaTime: 0, type: 'text' as const, text: '[idle]' },
			{ deltaTime: 480, type: 'lyrics' as const, text: '[play]' },
			{ deltaTime: 960, type: 'lyrics' as const, text: 'Hello' },
		]
		const lyrics = extractMidiLyrics(events as any)
		expect(lyrics).toHaveLength(1)
		expect(lyrics[0]).toEqual({ tick: 960, length: 0, text: 'Hello' })
	})

	it('preserves original text including whitespace', () => {
		const events = [
			{ deltaTime: 480, type: 'lyrics' as const, text: ' hey^ ' },
		]
		const lyrics = extractMidiLyrics(events as any)
		expect(lyrics).toHaveLength(1)
		expect(lyrics[0].text).toBe(' hey^ ')
	})

	it('handles mixed lyrics and text events', () => {
		const events = [
			{ deltaTime: 0, type: 'text' as const, text: '[idle_realtime]' },
			{ deltaTime: 100, type: 'text' as const, text: '[idle]' },
			{ deltaTime: 200, type: 'text' as const, text: '[play]' },
			{ deltaTime: 480, type: 'text' as const, text: 'Life' },
			{ deltaTime: 960, type: 'lyrics' as const, text: 'is' },
			{ deltaTime: 1440, type: 'text' as const, text: '[idle]' },
		]
		const lyrics = extractMidiLyrics(events as any)
		expect(lyrics).toHaveLength(2)
		expect(lyrics[0]).toEqual({ tick: 480, length: 0, text: 'Life' })
		expect(lyrics[1]).toEqual({ tick: 960, length: 0, text: 'is' })
	})
})

// ---------------------------------------------------------------------------
// extractMidiVocalPhrases
// ---------------------------------------------------------------------------

describe('extractMidiVocalPhrases', () => {
	it('extracts note 105 phrases', () => {
		const events = [
			{ deltaTime: 480, type: 'noteOn' as const, channel: 0, noteNumber: 105, velocity: 100 },
			{ deltaTime: 1440, type: 'noteOff' as const, channel: 0, noteNumber: 105, velocity: 0 },
		]
		const phrases = extractMidiVocalPhrases(events as any)
		expect(phrases).toHaveLength(1)
		expect(phrases[0]).toEqual({ tick: 480, length: 960, noteNumber: 105 })
	})

	it('extracts note 106 phrases', () => {
		const events = [
			{ deltaTime: 480, type: 'noteOn' as const, channel: 0, noteNumber: 106, velocity: 100 },
			{ deltaTime: 960, type: 'noteOff' as const, channel: 0, noteNumber: 106, velocity: 0 },
		]
		const phrases = extractMidiVocalPhrases(events as any)
		expect(phrases).toHaveLength(1)
		expect(phrases[0]).toEqual({ tick: 480, length: 480, noteNumber: 106 })
	})

	it('handles velocity 0 noteOn as noteOff', () => {
		const events = [
			{ deltaTime: 480, type: 'noteOn' as const, channel: 0, noteNumber: 105, velocity: 100 },
			{ deltaTime: 960, type: 'noteOn' as const, channel: 0, noteNumber: 105, velocity: 0 },
		]
		const phrases = extractMidiVocalPhrases(events as any)
		expect(phrases).toHaveLength(1)
		expect(phrases[0]).toEqual({ tick: 480, length: 480, noteNumber: 105 })
	})

	it('handles overlapping 105 and 106', () => {
		const events = [
			{ deltaTime: 480, type: 'noteOn' as const, channel: 0, noteNumber: 105, velocity: 100 },
			{ deltaTime: 720, type: 'noteOn' as const, channel: 0, noteNumber: 106, velocity: 100 },
			{ deltaTime: 960, type: 'noteOff' as const, channel: 0, noteNumber: 105, velocity: 0 },
			{ deltaTime: 1200, type: 'noteOff' as const, channel: 0, noteNumber: 106, velocity: 0 },
		]
		const phrases = extractMidiVocalPhrases(events as any)
		expect(phrases).toHaveLength(2)
		expect(phrases[0]).toEqual({ tick: 480, length: 480, noteNumber: 105 })
		expect(phrases[1]).toEqual({ tick: 720, length: 480, noteNumber: 106 })
	})

	it('ignores duplicate noteOn (YARG behavior)', () => {
		// When 105 is already open, a second noteOn is ignored — first noteOff closes original
		const events = [
			{ deltaTime: 480, type: 'noteOn' as const, channel: 0, noteNumber: 105, velocity: 100 },
			{ deltaTime: 960, type: 'noteOn' as const, channel: 0, noteNumber: 105, velocity: 100 },  // duplicate, ignored
			{ deltaTime: 1440, type: 'noteOff' as const, channel: 0, noteNumber: 105, velocity: 0 },
		]
		const phrases = extractMidiVocalPhrases(events as any)
		expect(phrases).toHaveLength(1)
		expect(phrases[0]).toEqual({ tick: 480, length: 960, noteNumber: 105 })
	})

	it('ignores non-105/106 notes', () => {
		const events = [
			{ deltaTime: 480, type: 'noteOn' as const, channel: 0, noteNumber: 60, velocity: 100 },
			{ deltaTime: 960, type: 'noteOff' as const, channel: 0, noteNumber: 60, velocity: 0 },
		]
		const phrases = extractMidiVocalPhrases(events as any)
		expect(phrases).toHaveLength(0)
	})

	it('handles unpaired noteOn (ignored)', () => {
		const events = [
			{ deltaTime: 480, type: 'noteOn' as const, channel: 0, noteNumber: 105, velocity: 100 },
			// No noteOff
		]
		const phrases = extractMidiVocalPhrases(events as any)
		expect(phrases).toHaveLength(0)
	})
})

// ---------------------------------------------------------------------------
// Edge cases: dedup and whitespace
// ---------------------------------------------------------------------------

describe('extractMidiLyrics edge cases', () => {
	it('deduplicates lyrics at same tick with same text', () => {
		const events = [
			{ deltaTime: 480, type: 'lyrics' as const, text: '+' },
			{ deltaTime: 480, type: 'lyrics' as const, text: '+' },
		]
		const lyrics = extractMidiLyrics(events as any)
		expect(lyrics).toHaveLength(1)
	})

	it('filters tick-0 text event that duplicates track name', () => {
		const events = [
			{ deltaTime: 0, type: 'trackName' as const, text: 'PART VOCALS' },
			{ deltaTime: 0, type: 'text' as const, text: 'PART VOCALS' },
			{ deltaTime: 480, type: 'lyrics' as const, text: 'Hello' },
		]
		const lyrics = extractMidiLyrics(events as any)
		expect(lyrics).toHaveLength(1)
		expect(lyrics[0].text).toBe('Hello')
	})

	it('keeps tick-0 text event if it does NOT match track name', () => {
		const events = [
			{ deltaTime: 0, type: 'trackName' as const, text: 'PART VOCALS' },
			{ deltaTime: 0, type: 'text' as const, text: 'intro' },
			{ deltaTime: 480, type: 'lyrics' as const, text: 'Hello' },
		]
		const lyrics = extractMidiLyrics(events as any)
		expect(lyrics).toHaveLength(2)
		expect(lyrics[0].text).toBe('intro')
	})

	it('keeps tick-0 lyrics event even if it matches track name (only text type filtered)', () => {
		const events = [
			{ deltaTime: 0, type: 'trackName' as const, text: 'PART VOCALS' },
			{ deltaTime: 0, type: 'lyrics' as const, text: 'PART VOCALS' },
			{ deltaTime: 480, type: 'lyrics' as const, text: 'Hello' },
		]
		const lyrics = extractMidiLyrics(events as any)
		expect(lyrics).toHaveLength(2)
	})

	it('keeps non-zero tick text event even if it matches track name', () => {
		const events = [
			{ deltaTime: 0, type: 'trackName' as const, text: 'PART VOCALS' },
			{ deltaTime: 480, type: 'text' as const, text: 'PART VOCALS' },
			{ deltaTime: 960, type: 'lyrics' as const, text: 'Hello' },
		]
		const lyrics = extractMidiLyrics(events as any)
		expect(lyrics).toHaveLength(2)
		expect(lyrics[0].text).toBe('PART VOCALS')
	})

	it('keeps empty lyrics (YARG stores as "lyric ")', () => {
		const events = [
			{ deltaTime: 480, type: 'lyrics' as const, text: '' },
			{ deltaTime: 960, type: 'lyrics' as const, text: 'hello' },
		]
		const lyrics = extractMidiLyrics(events as any)
		expect(lyrics).toHaveLength(2)
		expect(lyrics[0].text).toBe('')
		expect(lyrics[1].text).toBe('hello')
	})

	it('keeps space-only lyrics (preserves original)', () => {
		const events = [
			{ deltaTime: 480, type: 'lyrics' as const, text: ' ' },
			{ deltaTime: 960, type: 'lyrics' as const, text: 'hello' },
		]
		const lyrics = extractMidiLyrics(events as any)
		expect(lyrics).toHaveLength(2)
		expect(lyrics[0].text).toBe(' ')
		expect(lyrics[1].text).toBe('hello')
	})

	it('keeps lyrics at same tick with different text', () => {
		const events = [
			{ deltaTime: 480, type: 'lyrics' as const, text: 'a' },
			{ deltaTime: 480, type: 'lyrics' as const, text: 'b' },
		]
		const lyrics = extractMidiLyrics(events as any)
		expect(lyrics).toHaveLength(2)
	})

	it('preserves trailing spaces in lyric text', () => {
		const events = [
			{ deltaTime: 480, type: 'lyrics' as const, text: 'hello ' },
		]
		const lyrics = extractMidiLyrics(events as any)
		expect(lyrics[0].text).toBe('hello ')
	})

	it('preserves leading spaces in lyric text', () => {
		const events = [
			{ deltaTime: 480, type: 'lyrics' as const, text: ' hey^' },
		]
		const lyrics = extractMidiLyrics(events as any)
		expect(lyrics[0].text).toBe(' hey^')
	})

	it('preserves internal spaces in lyric text', () => {
		const events = [
			{ deltaTime: 480, type: 'lyrics' as const, text: 'hello world' },
		]
		const lyrics = extractMidiLyrics(events as any)
		expect(lyrics[0].text).toBe('hello world')
	})
})

describe('normalizeLyricText', () => {
	it('preserves all whitespace (normalization only filters brackets)', () => {
		expect(normalizeLyricText(' hello ')).toBe(' hello ')
	})

	it('preserves control characters', () => {
		expect(normalizeLyricText('\x00hello\x1f')).toBe('\x00hello\x1f')
	})

	it('returns empty for entirely bracketed text', () => {
		expect(normalizeLyricText('[play]')).toBe('')
	})

	it('returns empty for bracketed annotation', () => {
		expect(normalizeLyricText('[Everyone liked that]')).toBe('')
	})

	it('returns empty for bracketed with leading whitespace', () => {
		expect(normalizeLyricText(' [idle] ')).toBe('')
	})

	it('preserves regular lyric text', () => {
		expect(normalizeLyricText('Cha#')).toBe('Cha#')
	})

	it('preserves lyric with special chars', () => {
		expect(normalizeLyricText('to-')).toBe('to-')
	})

	it('preserves internal spaces', () => {
		expect(normalizeLyricText('hello world')).toBe('hello world')
	})

	it('preserves whitespace-only text', () => {
		expect(normalizeLyricText('   ')).toBe('   ')
	})
})

describe('isMidiVocalLyric bracket and space filtering', () => {
	it('bracketed after trim is not a lyric', () => {
		expect(isMidiVocalLyric({ type: 'lyrics', text: ' [play] ' })).toBe(false)
	})

	it('text with only control chars is a lyric (non-empty, non-bracket)', () => {
		expect(isMidiVocalLyric({ type: 'lyrics', text: '\x00\x01' })).toBe(true)
	})

	it('space-only text event IS a lyric (TrimAscii → empty, not bracketed)', () => {
		expect(isMidiVocalLyric({ type: 'text', text: '   ' })).toBe(true)
	})

	// These are YARG bugs — YARG incorrectly skips lyrics containing brackets.
	// scan-chart correctly treats them as lyrics because they're real lyric content.
	it('MIDI lyric with emoticon bracket :=[ is a lyric (YARG bug skips these)', () => {
		expect(isMidiVocalLyric({ type: 'lyrics', text: ':=[' })).toBe(true)
	})

	it('MIDI lyric with featuring info in brackets is a lyric', () => {
		// Note: this is a MIDI lyric (FF 05), not a .chart event.
		// In MIDI, the bracket check uses TrimAscii'd text.startsWith('[').
		// "[feat. X]" starts with [ → filtered. But "Song [feat. X]" doesn't start with [.
		expect(isMidiVocalLyric({ type: 'lyrics', text: 'Song [feat. Mark]' })).toBe(true)
	})

	it('MIDI lyric starting with [ IS filtered (annotation/control)', () => {
		expect(isMidiVocalLyric({ type: 'lyrics', text: '[I Like It, Though]' })).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// MIDI text encoding: Latin-1 fallback via midi-file patch
// ---------------------------------------------------------------------------

/**
 * Build a minimal single-track MIDI buffer with a PART VOCALS track containing
 * one lyric event whose text is the raw `textBytes` (no re-encoding).
 * This lets us test Latin-1 vs UTF-8 decoding in midi-file's patched readString.
 */
function buildRawMidiWithLyric(textBytes: number[]): Uint8Array {
	// --- Header chunk ---
	// "MThd" + length(6) + format(1) + numTracks(2) + ticksPerBeat(480)
	const header = [
		0x4D, 0x54, 0x68, 0x64, // MThd
		0x00, 0x00, 0x00, 0x06, // length = 6
		0x00, 0x01, // format = 1
		0x00, 0x02, // numTracks = 2
		0x01, 0xE0, // ticksPerBeat = 480
	]

	// --- Track 0: tempo track (minimal) ---
	const track0Events = [
		0x00, 0xFF, 0x03, 0x00, // delta=0, trackName, length=0
		0x00, 0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20, // delta=0, setTempo 500000 (120 BPM)
		0x00, 0xFF, 0x2F, 0x00, // delta=0, endOfTrack
	]
	const track0 = [
		0x4D, 0x54, 0x72, 0x6B, // MTrk
		...int32be(track0Events.length),
		...track0Events,
	]

	// --- Track 1: PART VOCALS with one lyric ---
	const trackNameText = [0x50, 0x41, 0x52, 0x54, 0x20, 0x56, 0x4F, 0x43, 0x41, 0x4C, 0x53] // "PART VOCALS"
	const track1Events = [
		0x00, 0xFF, 0x03, trackNameText.length, ...trackNameText, // trackName "PART VOCALS"
		0x83, 0x60, // delta = 480 (varint: 0x83 0x60)
		0xFF, 0x05, textBytes.length, ...textBytes, // lyrics event with raw bytes
		0x00, 0xFF, 0x2F, 0x00, // endOfTrack
	]
	const track1 = [
		0x4D, 0x54, 0x72, 0x6B, // MTrk
		...int32be(track1Events.length),
		...track1Events,
	]

	return new Uint8Array([...header, ...track0, ...track1])
}

function int32be(n: number): number[] {
	return [(n >> 24) & 0xFF, (n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF]
}

describe('MIDI text encoding: Latin-1 fallback', () => {
	it('decodes valid UTF-8 multibyte text (ñ = C3 B1)', () => {
		// UTF-8 encoded "ñ" = bytes C3 B1
		const midi = buildRawMidiWithLyric([0xC3, 0xB1])
		const parsed = parseMidi(midi)
		const vocalsTrack = parsed.tracks[1]
		const lyricEvent = vocalsTrack.find(e => e.type === 'lyrics')
		expect(lyricEvent).toBeDefined()
		expect((lyricEvent as any).text).toBe('ñ')
	})

	it('decodes valid UTF-8 multibyte text (é = C3 A9)', () => {
		const midi = buildRawMidiWithLyric([0x74, 0xC3, 0xA9]) // "té"
		const parsed = parseMidi(midi)
		const vocalsTrack = parsed.tracks[1]
		const lyricEvent = vocalsTrack.find(e => e.type === 'lyrics')
		expect((lyricEvent as any).text).toBe('té')
	})

	it('falls back to Latin-1 for invalid UTF-8 (ó = F3 in Latin-1)', () => {
		// Byte F3 is "ó" in Latin-1 but starts a 4-byte UTF-8 sequence.
		// Without proper continuation bytes, UTF-8 decoding produces U+FFFD.
		// The patch should fall back to Latin-1.
		const midi = buildRawMidiWithLyric([0x53, 0xF3]) // "Só" in Latin-1
		const parsed = parseMidi(midi)
		const vocalsTrack = parsed.tracks[1]
		const lyricEvent = vocalsTrack.find(e => e.type === 'lyrics')
		expect((lyricEvent as any).text).toBe('Só')
	})

	it('falls back to Latin-1 for invalid UTF-8 (é = E9 in Latin-1)', () => {
		// Byte E9 is "é" in Latin-1 but starts a 3-byte UTF-8 sequence.
		const midi = buildRawMidiWithLyric([0x71, 0x75, 0xE9]) // "qué" in Latin-1
		const parsed = parseMidi(midi)
		const vocalsTrack = parsed.tracks[1]
		const lyricEvent = vocalsTrack.find(e => e.type === 'lyrics')
		expect((lyricEvent as any).text).toBe('qué')
	})

	it('falls back to Latin-1 for invalid UTF-8 (ë = EB in Latin-1)', () => {
		// Byte EB is "ë" in Latin-1 but starts a 3-byte UTF-8 sequence.
		const midi = buildRawMidiWithLyric([0x6E, 0x6A, 0xEB]) // "një" in Latin-1
		const parsed = parseMidi(midi)
		const vocalsTrack = parsed.tracks[1]
		const lyricEvent = vocalsTrack.find(e => e.type === 'lyrics')
		expect((lyricEvent as any).text).toBe('një')
	})

	it('Latin-1 lyrics pass through extractMidiLyrics correctly', () => {
		// Simulate what happens after midi-file decodes Latin-1 text
		const events = [
			{ deltaTime: 0, type: 'trackName' as const, text: 'PART VOCALS' },
			{ deltaTime: 480, type: 'lyrics' as const, text: 'Só' }, // Latin-1 decoded
		]
		const lyrics = extractMidiLyrics(events as any)
		expect(lyrics).toHaveLength(1)
		expect(lyrics[0].text).toBe('Só')
	})

	it('preserves ASCII-only text unchanged', () => {
		const midi = buildRawMidiWithLyric([0x48, 0x65, 0x6C, 0x6C, 0x6F]) // "Hello"
		const parsed = parseMidi(midi)
		const vocalsTrack = parsed.tracks[1]
		const lyricEvent = vocalsTrack.find(e => e.type === 'lyrics')
		expect((lyricEvent as any).text).toBe('Hello')
	})
})
