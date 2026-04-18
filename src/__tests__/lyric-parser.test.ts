import { describe, it, expect } from 'vitest'
import { parseMidi } from 'midi-file'
import {
	parseChartLyricLine,
	parseChartVocalPhraseLine,
	extractChartLyrics,
	extractChartVocalPhrases,
	extractChartOrphanPhraseEnds,
	isMidiVocalLyric,
	isBracketedControlEvent,
	normalizeLyricText,
	extractMidiLyricText,
	scanVocalTrack,
	parseLyricFlags,
	stripLyricSymbols,
} from '../chart/lyric-parser'
import { lyricFlags } from '../chart/note-parsing-interfaces'

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

	it('keeps lyrics with brackets (they are real lyric content)', () => {
		const lines = [
			'480 = E "lyric Hello"',
			'960 = E "lyric [Everyone liked that]"',
			'1440 = E "lyric World"',
		]
		const lyrics = extractChartLyrics(lines)
		expect(lyrics).toHaveLength(3)
		expect(lyrics[0].text).toBe('Hello')
		expect(lyrics[1].text).toBe('[Everyone liked that]')
		expect(lyrics[2].text).toBe('World')
	})

	it('keeps lyrics with brackets mid-text', () => {
		const lines = [
			'480 = E "lyric [screams for eight seconds]"',
		]
		const lyrics = extractChartLyrics(lines)
		expect(lyrics).toHaveLength(1)
		expect(lyrics[0].text).toBe('[screams for eight seconds]')
	})

	it('keeps lyrics with featuring annotation in brackets', () => {
		const lines = [
			'480 = E "lyric Single: December (again) [feat. Mark Hoppus]"',
		]
		const lyrics = extractChartLyrics(lines)
		expect(lyrics).toHaveLength(1)
		expect(lyrics[0].text).toBe('Single: December (again) [feat. Mark Hoppus]')
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

	it('skips orphaned phrase_end from extractChartVocalPhrases (preserved separately)', () => {
		const lines = [
			'480 = E "phrase_end"',
			'960 = E "phrase_start"',
			'1440 = E "phrase_end"',
		]
		const phrases = extractChartVocalPhrases(lines)
		expect(phrases).toHaveLength(1)
		expect(phrases[0]).toEqual({ tick: 960, length: 480 })
		// Orphan phrase_ends are surfaced via extractChartOrphanPhraseEnds.
		expect(extractChartOrphanPhraseEnds(lines)).toEqual([{ tick: 480 }])
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

	it('bracketed lyrics with unknown content ARE lyrics (not control events)', () => {
		expect(isMidiVocalLyric({ type: 'lyrics', text: '[Everyone liked that]' })).toBe(true)
	})

	it('text starting with HTML tags is still a lyric (HTML not stripped at parse time)', () => {
		// HTML tags are stripped at rendering time, not parse time
		expect(isMidiVocalLyric({ type: 'lyrics', text: '<sub><i>[REIMAGINED]</i>' })).toBe(true)
	})
})

// ---------------------------------------------------------------------------
// scanVocalTrack — lyrics bucket
// ---------------------------------------------------------------------------

describe('scanVocalTrack (lyrics)', () => {
	it('extracts lyrics from lyric events', () => {
		const events = [
			{ deltaTime: 0, type: 'trackName' as const, text: 'PART VOCALS' },
			{ deltaTime: 480, type: 'lyrics' as const, text: 'Hel+' },
			{ deltaTime: 960, type: 'lyrics' as const, text: 'lo' },
		]
		const lyrics = scanVocalTrack(events).lyrics
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
		const lyrics = scanVocalTrack(events).lyrics
		expect(lyrics).toHaveLength(2)
		expect(lyrics[0]).toEqual({ tick: 480, length: 0, text: 'Life' })
	})

	it('filters out bracketed control events', () => {
		const events = [
			{ deltaTime: 0, type: 'text' as const, text: '[idle]' },
			{ deltaTime: 480, type: 'lyrics' as const, text: '[play]' },
			{ deltaTime: 960, type: 'lyrics' as const, text: 'Hello' },
		]
		const lyrics = scanVocalTrack(events).lyrics
		expect(lyrics).toHaveLength(1)
		expect(lyrics[0]).toEqual({ tick: 960, length: 0, text: 'Hello' })
	})

	it('preserves original text including whitespace', () => {
		const events = [
			{ deltaTime: 0, type: 'trackName' as const, text: 'PART VOCALS' },
			{ deltaTime: 480, type: 'lyrics' as const, text: ' hey^ ' },
		]
		const lyrics = scanVocalTrack(events).lyrics
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
		const lyrics = scanVocalTrack(events).lyrics
		expect(lyrics).toHaveLength(2)
		expect(lyrics[0]).toEqual({ tick: 480, length: 0, text: 'Life' })
		expect(lyrics[1]).toEqual({ tick: 960, length: 0, text: 'is' })
	})
})

// ---------------------------------------------------------------------------
// scanVocalTrack — phrases105 / phrases106
// ---------------------------------------------------------------------------

describe('scanVocalTrack (phrases)', () => {
	it('extracts note 105 phrases', () => {
		const events = [
			{ deltaTime: 480, type: 'noteOn' as const, channel: 0, noteNumber: 105, velocity: 100 },
			{ deltaTime: 1440, type: 'noteOff' as const, channel: 0, noteNumber: 105, velocity: 0 },
		]
		const result = scanVocalTrack(events)
		expect(result.phrases105).toEqual([{ tick: 480, length: 960 }])
		expect(result.phrases106).toEqual([])
	})

	it('extracts note 106 phrases', () => {
		const events = [
			{ deltaTime: 480, type: 'noteOn' as const, channel: 0, noteNumber: 106, velocity: 100 },
			{ deltaTime: 960, type: 'noteOff' as const, channel: 0, noteNumber: 106, velocity: 0 },
		]
		const result = scanVocalTrack(events)
		expect(result.phrases106).toEqual([{ tick: 480, length: 480 }])
		expect(result.phrases105).toEqual([])
	})

	it('handles velocity 0 noteOn as noteOff', () => {
		const events = [
			{ deltaTime: 480, type: 'noteOn' as const, channel: 0, noteNumber: 105, velocity: 100 },
			{ deltaTime: 960, type: 'noteOn' as const, channel: 0, noteNumber: 105, velocity: 0 },
		]
		expect(scanVocalTrack(events).phrases105).toEqual([{ tick: 480, length: 480 }])
	})

	it('handles overlapping 105 and 106', () => {
		const events = [
			{ deltaTime: 480, type: 'noteOn' as const, channel: 0, noteNumber: 105, velocity: 100 },
			{ deltaTime: 720, type: 'noteOn' as const, channel: 0, noteNumber: 106, velocity: 100 },
			{ deltaTime: 960, type: 'noteOff' as const, channel: 0, noteNumber: 105, velocity: 0 },
			{ deltaTime: 1200, type: 'noteOff' as const, channel: 0, noteNumber: 106, velocity: 0 },
		]
		const result = scanVocalTrack(events)
		expect(result.phrases105).toEqual([{ tick: 480, length: 480 }])
		expect(result.phrases106).toEqual([{ tick: 720, length: 480 }])
	})

	it('ignores duplicate noteOn (YARG behavior)', () => {
		// When 105 is already open, a second noteOn is ignored — first noteOff closes original
		const events = [
			{ deltaTime: 480, type: 'noteOn' as const, channel: 0, noteNumber: 105, velocity: 100 },
			{ deltaTime: 960, type: 'noteOn' as const, channel: 0, noteNumber: 105, velocity: 100 },  // duplicate, ignored
			{ deltaTime: 1440, type: 'noteOff' as const, channel: 0, noteNumber: 105, velocity: 0 },
		]
		expect(scanVocalTrack(events).phrases105).toEqual([{ tick: 480, length: 960 }])
	})

	it('does not route non-105/106 notes into phrase buckets', () => {
		const events = [
			{ deltaTime: 480, type: 'noteOn' as const, channel: 0, noteNumber: 60, velocity: 100 },
			{ deltaTime: 960, type: 'noteOff' as const, channel: 0, noteNumber: 60, velocity: 0 },
		]
		const result = scanVocalTrack(events)
		expect(result.phrases105).toEqual([])
		expect(result.phrases106).toEqual([])
	})

	it('handles unpaired noteOn (ignored)', () => {
		const events = [
			{ deltaTime: 480, type: 'noteOn' as const, channel: 0, noteNumber: 105, velocity: 100 },
			// No noteOff
		]
		expect(scanVocalTrack(events).phrases105).toEqual([])
	})
})

// ---------------------------------------------------------------------------
// Edge cases: dedup and whitespace
// ---------------------------------------------------------------------------

describe('scanVocalTrack edge cases', () => {
	it('deduplicates lyrics at same tick with same text', () => {
		const events = [
			{ deltaTime: 480, type: 'lyrics' as const, text: '+' },
			{ deltaTime: 480, type: 'lyrics' as const, text: '+' },
		]
		const lyrics = scanVocalTrack(events).lyrics
		expect(lyrics).toHaveLength(1)
	})

	it('does NOT filter tick-0 text events that duplicate the track name (caller responsibility)', () => {
		// scanVocalTrack doesn't take a track name parameter — the
		// duplicate filter lives in midi-parser.scanInstrumentTrack instead.
		// Verify that the classifier returns both lyrics; the integration filter
		// is covered by per-track-data.test.ts.
		const events = [
			{ deltaTime: 0, type: 'trackName' as const, text: 'PART VOCALS' },
			{ deltaTime: 0, type: 'text' as const, text: 'PART VOCALS' },
			{ deltaTime: 480, type: 'lyrics' as const, text: 'Hello' },
		]
		const lyrics = scanVocalTrack(events).lyrics
		expect(lyrics).toHaveLength(2)
		expect(lyrics.map(l => l.text)).toEqual(['PART VOCALS', 'Hello'])
	})

	it('keeps tick-0 text event if it does NOT match track name', () => {
		const events = [
			{ deltaTime: 0, type: 'trackName' as const, text: 'PART VOCALS' },
			{ deltaTime: 0, type: 'text' as const, text: 'intro' },
			{ deltaTime: 480, type: 'lyrics' as const, text: 'Hello' },
		]
		const lyrics = scanVocalTrack(events).lyrics
		expect(lyrics).toHaveLength(2)
		expect(lyrics[0].text).toBe('intro')
	})

	it('keeps tick-0 lyrics event even if it matches track name (only text type filtered)', () => {
		const events = [
			{ deltaTime: 0, type: 'trackName' as const, text: 'PART VOCALS' },
			{ deltaTime: 0, type: 'lyrics' as const, text: 'PART VOCALS' },
			{ deltaTime: 480, type: 'lyrics' as const, text: 'Hello' },
		]
		const lyrics = scanVocalTrack(events).lyrics
		expect(lyrics).toHaveLength(2)
	})

	it('keeps non-zero tick text event even if it matches track name', () => {
		const events = [
			{ deltaTime: 0, type: 'trackName' as const, text: 'PART VOCALS' },
			{ deltaTime: 480, type: 'text' as const, text: 'PART VOCALS' },
			{ deltaTime: 960, type: 'lyrics' as const, text: 'Hello' },
		]
		const lyrics = scanVocalTrack(events).lyrics
		expect(lyrics).toHaveLength(2)
		expect(lyrics[0].text).toBe('PART VOCALS')
	})

	it('keeps empty lyrics (YARG stores as "lyric ")', () => {
		const events = [
			{ deltaTime: 0, type: 'trackName' as const, text: 'PART VOCALS' },
			{ deltaTime: 480, type: 'lyrics' as const, text: '' },
			{ deltaTime: 960, type: 'lyrics' as const, text: 'hello' },
		]
		const lyrics = scanVocalTrack(events).lyrics
		expect(lyrics).toHaveLength(2)
		expect(lyrics[0].text).toBe('')
		expect(lyrics[1].text).toBe('hello')
	})

	it('keeps space-only lyrics (preserves original)', () => {
		const events = [
			{ deltaTime: 0, type: 'trackName' as const, text: 'PART VOCALS' },
			{ deltaTime: 480, type: 'lyrics' as const, text: ' ' },
			{ deltaTime: 960, type: 'lyrics' as const, text: 'hello' },
		]
		const lyrics = scanVocalTrack(events).lyrics
		expect(lyrics).toHaveLength(2)
		expect(lyrics[0].text).toBe(' ')
		expect(lyrics[1].text).toBe('hello')
	})

	it('keeps lyrics at same tick with different text', () => {
		const events = [
			{ deltaTime: 0, type: 'trackName' as const, text: 'PART VOCALS' },
			{ deltaTime: 480, type: 'lyrics' as const, text: 'a' },
			{ deltaTime: 480, type: 'lyrics' as const, text: 'b' },
		]
		const lyrics = scanVocalTrack(events).lyrics
		expect(lyrics).toHaveLength(2)
	})

	it('preserves trailing spaces in lyric text', () => {
		const events = [
			{ deltaTime: 0, type: 'trackName' as const, text: 'PART VOCALS' },
			{ deltaTime: 480, type: 'lyrics' as const, text: 'hello ' },
		]
		const lyrics = scanVocalTrack(events).lyrics
		expect(lyrics[0].text).toBe('hello ')
	})

	it('preserves leading spaces in lyric text', () => {
		const events = [
			{ deltaTime: 0, type: 'trackName' as const, text: 'PART VOCALS' },
			{ deltaTime: 480, type: 'lyrics' as const, text: ' hey^' },
		]
		const lyrics = scanVocalTrack(events).lyrics
		expect(lyrics[0].text).toBe(' hey^')
	})

	it('preserves internal spaces in lyric text', () => {
		const events = [
			{ deltaTime: 0, type: 'trackName' as const, text: 'PART VOCALS' },
			{ deltaTime: 480, type: 'lyrics' as const, text: 'hello world' },
		]
		const lyrics = scanVocalTrack(events).lyrics
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

	it('returns empty for known control event', () => {
		expect(normalizeLyricText('[play]')).toBe('')
	})

	it('preserves bracketed lyric content (not a control event)', () => {
		expect(normalizeLyricText('[Everyone liked that]')).toBe('[Everyone liked that]')
	})

	it('returns empty for known control event with leading whitespace', () => {
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
	it('known control event with whitespace is not a lyric', () => {
		expect(isMidiVocalLyric({ type: 'lyrics', text: ' [play] ' })).toBe(false)
	})

	it('text with only control chars is a lyric (non-empty, not a control event)', () => {
		expect(isMidiVocalLyric({ type: 'lyrics', text: '\x00\x01' })).toBe(true)
	})

	it('space-only text event IS a lyric (not a control event)', () => {
		expect(isMidiVocalLyric({ type: 'text', text: '   ' })).toBe(true)
	})

	it('MIDI lyric with emoticon bracket :=[ is a lyric', () => {
		expect(isMidiVocalLyric({ type: 'lyrics', text: ':=[' })).toBe(true)
	})

	it('MIDI lyric with featuring info in brackets is a lyric', () => {
		expect(isMidiVocalLyric({ type: 'lyrics', text: 'Song [feat. Mark]' })).toBe(true)
	})

	it('unknown bracketed text IS a lyric (not a known control event)', () => {
		expect(isMidiVocalLyric({ type: 'lyrics', text: '[I Like It, Though]' })).toBe(true)
	})
})

// ---------------------------------------------------------------------------
// MIDI text encoding: Latin-1 fallback via midi-file patch
// ---------------------------------------------------------------------------
// isBracketedControlEvent
// ---------------------------------------------------------------------------

describe('isBracketedControlEvent', () => {
	it('recognizes known control events', () => {
		expect(isBracketedControlEvent('[play]')).toBe(true)
		expect(isBracketedControlEvent('[idle]')).toBe(true)
		expect(isBracketedControlEvent('[idle_realtime]')).toBe(true)
		expect(isBracketedControlEvent('[idle_intense]')).toBe(true)
		expect(isBracketedControlEvent('[play_solo]')).toBe(true)
		expect(isBracketedControlEvent('[mellow]')).toBe(true)
		expect(isBracketedControlEvent('[intense]')).toBe(true)
		expect(isBracketedControlEvent('[tambourine_start]')).toBe(true)
		expect(isBracketedControlEvent('[tambourine_end]')).toBe(true)
		expect(isBracketedControlEvent('[cowbell_start]')).toBe(true)
		expect(isBracketedControlEvent('[cowbell_end]')).toBe(true)
		expect(isBracketedControlEvent('[clap_start]')).toBe(true)
		expect(isBracketedControlEvent('[clap_end]')).toBe(true)
	})

	it('rejects unknown bracketed text', () => {
		expect(isBracketedControlEvent('[Everyone liked that]')).toBe(false)
		expect(isBracketedControlEvent('[screams for eight seconds]')).toBe(false)
		expect(isBracketedControlEvent('[I Like It, Though]')).toBe(false)
		expect(isBracketedControlEvent('[feat. Mark Hoppus]')).toBe(false)
		expect(isBracketedControlEvent('[REIMAGINED]')).toBe(false)
	})

	it('rejects non-bracketed text', () => {
		expect(isBracketedControlEvent('play')).toBe(false)
		expect(isBracketedControlEvent('hello')).toBe(false)
		expect(isBracketedControlEvent(':=[')).toBe(false)
	})

	it('handles whitespace around brackets (TrimAscii)', () => {
		expect(isBracketedControlEvent(' [play] ')).toBe(true)
		expect(isBracketedControlEvent(' [Everyone liked that] ')).toBe(false)
	})
})

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
		expect((lyricEvent ).text).toBe('ñ')
	})

	it('decodes valid UTF-8 multibyte text (é = C3 A9)', () => {
		const midi = buildRawMidiWithLyric([0x74, 0xC3, 0xA9]) // "té"
		const parsed = parseMidi(midi)
		const vocalsTrack = parsed.tracks[1]
		const lyricEvent = vocalsTrack.find(e => e.type === 'lyrics')
		expect((lyricEvent ).text).toBe('té')
	})

	it('falls back to Latin-1 for invalid UTF-8 (ó = F3 in Latin-1)', () => {
		// Byte F3 is "ó" in Latin-1 but starts a 4-byte UTF-8 sequence.
		// Without proper continuation bytes, UTF-8 decoding produces U+FFFD.
		// The patch should fall back to Latin-1.
		const midi = buildRawMidiWithLyric([0x53, 0xF3]) // "Só" in Latin-1
		const parsed = parseMidi(midi)
		const vocalsTrack = parsed.tracks[1]
		const lyricEvent = vocalsTrack.find(e => e.type === 'lyrics')
		expect((lyricEvent ).text).toBe('Só')
	})

	it('falls back to Latin-1 for invalid UTF-8 (é = E9 in Latin-1)', () => {
		// Byte E9 is "é" in Latin-1 but starts a 3-byte UTF-8 sequence.
		const midi = buildRawMidiWithLyric([0x71, 0x75, 0xE9]) // "qué" in Latin-1
		const parsed = parseMidi(midi)
		const vocalsTrack = parsed.tracks[1]
		const lyricEvent = vocalsTrack.find(e => e.type === 'lyrics')
		expect((lyricEvent ).text).toBe('qué')
	})

	it('falls back to Latin-1 for invalid UTF-8 (ë = EB in Latin-1)', () => {
		// Byte EB is "ë" in Latin-1 but starts a 3-byte UTF-8 sequence.
		const midi = buildRawMidiWithLyric([0x6E, 0x6A, 0xEB]) // "një" in Latin-1
		const parsed = parseMidi(midi)
		const vocalsTrack = parsed.tracks[1]
		const lyricEvent = vocalsTrack.find(e => e.type === 'lyrics')
		expect((lyricEvent ).text).toBe('një')
	})

	it('Latin-1 lyrics pass through scanVocalTrack correctly', () => {
		// Simulate what happens after midi-file decodes Latin-1 text
		const events = [
			{ deltaTime: 0, type: 'trackName' as const, text: 'PART VOCALS' },
			{ deltaTime: 480, type: 'lyrics' as const, text: 'Só' }, // Latin-1 decoded
		]
		const lyrics = scanVocalTrack(events).lyrics
		expect(lyrics).toHaveLength(1)
		expect(lyrics[0].text).toBe('Só')
	})

	it('preserves ASCII-only text unchanged', () => {
		const midi = buildRawMidiWithLyric([0x48, 0x65, 0x6C, 0x6C, 0x6F]) // "Hello"
		const parsed = parseMidi(midi)
		const vocalsTrack = parsed.tracks[1]
		const lyricEvent = vocalsTrack.find(e => e.type === 'lyrics')
		expect((lyricEvent ).text).toBe('Hello')
	})
})

// ---------------------------------------------------------------------------
// scanVocalTrack — notes (pitched / percussion)
// ---------------------------------------------------------------------------

describe('scanVocalTrack (notes)', () => {
	it('extracts pitched notes (36-84)', () => {
		const events = [
			{ deltaTime: 480, type: 'noteOn' as const, noteNumber: 60, velocity: 100 },
			{ deltaTime: 720, type: 'noteOff' as const, noteNumber: 60, velocity: 0 },
			{ deltaTime: 960, type: 'noteOn' as const, noteNumber: 72, velocity: 100 },
			{ deltaTime: 1200, type: 'noteOff' as const, noteNumber: 72, velocity: 0 },
		]
		const notes = scanVocalTrack(events).notes
		expect(notes).toHaveLength(2)
		expect(notes[0]).toEqual({ tick: 480, length: 240, pitch: 60, type: 'pitched' })
		expect(notes[1]).toEqual({ tick: 960, length: 240, pitch: 72, type: 'pitched' })
	})

	it('extracts displayed percussion (note 96)', () => {
		const events = [
			{ deltaTime: 480, type: 'noteOn' as const, noteNumber: 96, velocity: 100 },
			{ deltaTime: 720, type: 'noteOff' as const, noteNumber: 96, velocity: 0 },
		]
		const notes = scanVocalTrack(events).notes
		expect(notes).toHaveLength(1)
		expect(notes[0]).toEqual({ tick: 480, length: 240, pitch: 96, type: 'percussion' })
	})

	it('extracts hidden percussion (note 97)', () => {
		const events = [
			{ deltaTime: 480, type: 'noteOn' as const, noteNumber: 97, velocity: 100 },
			{ deltaTime: 720, type: 'noteOff' as const, noteNumber: 97, velocity: 0 },
		]
		const notes = scanVocalTrack(events).notes
		expect(notes).toHaveLength(1)
		expect(notes[0]).toEqual({ tick: 480, length: 240, pitch: 97, type: 'percussionHidden' })
	})

	it('ignores notes outside vocal range (35, 85, 105, 106)', () => {
		const events = [
			{ deltaTime: 480, type: 'noteOn' as const, noteNumber: 35, velocity: 100 },
			{ deltaTime: 720, type: 'noteOff' as const, noteNumber: 35, velocity: 0 },
			{ deltaTime: 960, type: 'noteOn' as const, noteNumber: 85, velocity: 100 },
			{ deltaTime: 1200, type: 'noteOff' as const, noteNumber: 85, velocity: 0 },
			{ deltaTime: 1440, type: 'noteOn' as const, noteNumber: 105, velocity: 100 },
			{ deltaTime: 1680, type: 'noteOff' as const, noteNumber: 105, velocity: 0 },
		]
		expect(scanVocalTrack(events).notes).toHaveLength(0)
	})

	it('handles velocity-0 noteOn as noteOff', () => {
		const events = [
			{ deltaTime: 480, type: 'noteOn' as const, noteNumber: 60, velocity: 100 },
			{ deltaTime: 720, type: 'noteOn' as const, noteNumber: 60, velocity: 0 },
		]
		const notes = scanVocalTrack(events).notes
		expect(notes).toHaveLength(1)
		expect(notes[0]).toEqual({ tick: 480, length: 240, pitch: 60, type: 'pitched' })
	})

	it('extracts consecutive same-pitch notes (noteOff then noteOn)', () => {
		// Real case: "The Lumineers - Ho Hey" has two note-60 back-to-back:
		// noteOn 60 at 54880, noteOff 60 at 55080, noteOn 60 at 55120
		const events = [
			{ deltaTime: 480, type: 'noteOn' as const, noteNumber: 60, velocity: 100 },
			{ deltaTime: 680, type: 'noteOff' as const, noteNumber: 60, velocity: 100 },
			{ deltaTime: 720, type: 'noteOn' as const, noteNumber: 60, velocity: 100 },
			{ deltaTime: 960, type: 'noteOff' as const, noteNumber: 60, velocity: 0 },
		]
		const notes = scanVocalTrack(events).notes
		expect(notes).toHaveLength(2)
		expect(notes[0]).toEqual({ tick: 480, length: 200, pitch: 60, type: 'pitched' })
		expect(notes[1]).toEqual({ tick: 720, length: 240, pitch: 60, type: 'pitched' })
	})

	it('handles zero-length note (noteOn+noteOff at same tick) followed by new note', () => {
		// Real case: "The Lumineers - Ho Hey" has noteOn+noteOff at tick 49840 (zero-length),
		// then a real noteOn at 54880. YARG ignores the duplicate noteOn at 49840 (already open
		// from earlier), then the noteOff closes the note. The noteOn at 54880 opens a new note.
		// With incorrect noteOff-before-noteOn sorting, the zero-length note steals the noteOff
		// at 55080, causing the noteOn at 54880 to be treated as a duplicate.
		const events = [
			{ deltaTime: 480, type: 'noteOn' as const, noteNumber: 60, velocity: 100 },
			// Zero-length note at tick 680: noteOn then noteOff at same tick
			{ deltaTime: 680, type: 'noteOn' as const, noteNumber: 60, velocity: 100 },
			{ deltaTime: 680, type: 'noteOff' as const, noteNumber: 60, velocity: 100 },
			// New note at tick 960
			{ deltaTime: 960, type: 'noteOn' as const, noteNumber: 60, velocity: 100 },
			{ deltaTime: 1200, type: 'noteOff' as const, noteNumber: 60, velocity: 0 },
		]
		const notes = scanVocalTrack(events).notes
		// Should produce 2 notes: 480-680 and 960-1200
		// (zero-length noteOn at 680 is duplicate → ignored; noteOff at 680 closes note at 480)
		expect(notes).toHaveLength(2)
		expect(notes[0]).toMatchObject({ tick: 480, length: 200 })
		expect(notes[1]).toMatchObject({ tick: 960, length: 240 })
	})

	it('extracts same-pitch notes with noteOff velocity > 0', () => {
		// FreeStyleGames charts use noteOff with velocity > 0 (e.g. vel=100)
		const events = [
			{ deltaTime: 480, type: 'noteOn' as const, noteNumber: 60, velocity: 100 },
			{ deltaTime: 680, type: 'noteOff' as const, noteNumber: 60, velocity: 100 },  // vel > 0
			{ deltaTime: 720, type: 'noteOn' as const, noteNumber: 60, velocity: 100 },
			{ deltaTime: 960, type: 'noteOff' as const, noteNumber: 60, velocity: 100 },
		]
		const notes = scanVocalTrack(events).notes
		expect(notes).toHaveLength(2)
	})

	it('handles mixed pitched and percussion notes', () => {
		const events = [
			{ deltaTime: 480, type: 'noteOn' as const, noteNumber: 60, velocity: 100 },
			{ deltaTime: 480, type: 'noteOn' as const, noteNumber: 96, velocity: 100 },
			{ deltaTime: 720, type: 'noteOff' as const, noteNumber: 60, velocity: 0 },
			{ deltaTime: 720, type: 'noteOff' as const, noteNumber: 96, velocity: 0 },
		]
		const notes = scanVocalTrack(events).notes
		expect(notes).toHaveLength(2)
	})

	it('extracts boundary pitches (36 and 84)', () => {
		const events = [
			{ deltaTime: 480, type: 'noteOn' as const, noteNumber: 36, velocity: 100 },
			{ deltaTime: 720, type: 'noteOff' as const, noteNumber: 36, velocity: 0 },
			{ deltaTime: 960, type: 'noteOn' as const, noteNumber: 84, velocity: 100 },
			{ deltaTime: 1200, type: 'noteOff' as const, noteNumber: 84, velocity: 0 },
		]
		const notes = scanVocalTrack(events).notes
		expect(notes).toHaveLength(2)
		expect(notes[0].type).toBe('pitched')
		expect(notes[1].type).toBe('pitched')
	})
})

// ---------------------------------------------------------------------------
// scanVocalTrack — starPower
// ---------------------------------------------------------------------------

describe('scanVocalTrack (starPower)', () => {
	it('extracts star power from note 116', () => {
		const events = [
			{ deltaTime: 480, type: 'noteOn' as const, noteNumber: 116, velocity: 100 },
			{ deltaTime: 1440, type: 'noteOff' as const, noteNumber: 116, velocity: 0 },
		]
		const sp = scanVocalTrack(events).starPower
		expect(sp).toHaveLength(1)
		expect(sp[0]).toMatchObject({ tick: 480, length: 960 })
	})

	it('extracts multiple star power sections', () => {
		const events = [
			{ deltaTime: 480, type: 'noteOn' as const, noteNumber: 116, velocity: 100 },
			{ deltaTime: 960, type: 'noteOff' as const, noteNumber: 116, velocity: 0 },
			{ deltaTime: 1920, type: 'noteOn' as const, noteNumber: 116, velocity: 100 },
			{ deltaTime: 2880, type: 'noteOff' as const, noteNumber: 116, velocity: 0 },
		]
		const sp = scanVocalTrack(events).starPower
		expect(sp).toHaveLength(2)
	})

	it('ignores non-116 notes', () => {
		const events = [
			{ deltaTime: 480, type: 'noteOn' as const, noteNumber: 60, velocity: 100 },
			{ deltaTime: 720, type: 'noteOff' as const, noteNumber: 60, velocity: 0 },
		]
		expect(scanVocalTrack(events).starPower).toHaveLength(0)
	})
})

// ---------------------------------------------------------------------------
// scanVocalTrack — rangeShifts / lyricShifts
// ---------------------------------------------------------------------------

describe('scanVocalTrack (rangeShifts)', () => {
	it('extracts range shift from note 0', () => {
		const events = [
			{ deltaTime: 480, type: 'noteOn' as const, noteNumber: 0, velocity: 100 },
			{ deltaTime: 960, type: 'noteOff' as const, noteNumber: 0, velocity: 0 },
		]
		const shifts = scanVocalTrack(events).rangeShifts
		expect(shifts).toHaveLength(1)
		expect(shifts[0]).toMatchObject({ tick: 480, length: 480 })
	})

	it('ignores non-zero notes', () => {
		const events = [
			{ deltaTime: 480, type: 'noteOn' as const, noteNumber: 1, velocity: 100 },
			{ deltaTime: 960, type: 'noteOff' as const, noteNumber: 1, velocity: 0 },
		]
		expect(scanVocalTrack(events).rangeShifts).toHaveLength(0)
	})
})

describe('scanVocalTrack (lyricShifts)', () => {
	it('extracts lyric shift from note 1', () => {
		const events = [
			{ deltaTime: 480, type: 'noteOn' as const, noteNumber: 1, velocity: 100 },
			{ deltaTime: 960, type: 'noteOff' as const, noteNumber: 1, velocity: 0 },
		]
		const shifts = scanVocalTrack(events).lyricShifts
		expect(shifts).toHaveLength(1)
		expect(shifts[0]).toMatchObject({ tick: 480, length: 480 })
	})

	it('ignores note 0', () => {
		const events = [
			{ deltaTime: 480, type: 'noteOn' as const, noteNumber: 0, velocity: 100 },
			{ deltaTime: 960, type: 'noteOff' as const, noteNumber: 0, velocity: 0 },
		]
		expect(scanVocalTrack(events).lyricShifts).toHaveLength(0)
	})
})

// ---------------------------------------------------------------------------
// parseLyricFlags
// ---------------------------------------------------------------------------

describe('parseLyricFlags', () => {
	it('returns none for plain text', () => {
		expect(parseLyricFlags('Hello')).toBe(lyricFlags.none)
	})

	it('detects pitch slide (+)', () => {
		expect(parseLyricFlags('Hel+')).toBe(lyricFlags.pitchSlide)
	})

	it('detects join with next (-)', () => {
		expect(parseLyricFlags('to-')).toBe(lyricFlags.joinWithNext)
	})

	it('detects hyphenate with next (=)', () => {
		expect(parseLyricFlags('word=')).toBe(lyricFlags.hyphenateWithNext)
	})

	it('detects non-pitched (#)', () => {
		expect(parseLyricFlags('Cha#')).toBe(lyricFlags.nonPitched)
	})

	it('detects non-pitched lenient (^)', () => {
		expect(parseLyricFlags('oh^')).toBe(lyricFlags.nonPitched | lyricFlags.lenientScoring)
	})

	it('detects non-pitched unknown (*)', () => {
		expect(parseLyricFlags('hm*')).toBe(lyricFlags.nonPitched)
	})

	it('detects range shift (%)', () => {
		expect(parseLyricFlags('go%')).toBe(lyricFlags.rangeShift)
	})

	it('detects static shift (/)', () => {
		expect(parseLyricFlags('hey/')).toBe(lyricFlags.staticShift)
	})

	it('detects harmony hidden ($) at start', () => {
		expect(parseLyricFlags('$hey')).toBe(lyricFlags.harmonyHidden)
	})

	it('detects multiple trailing flags', () => {
		expect(parseLyricFlags('+-')).toBe(lyricFlags.pitchSlide | lyricFlags.joinWithNext)
	})

	it('detects $ prefix combined with trailing flags', () => {
		expect(parseLyricFlags('$oh+')).toBe(lyricFlags.harmonyHidden | lyricFlags.pitchSlide)
	})

	it('returns none for empty string', () => {
		expect(parseLyricFlags('')).toBe(lyricFlags.none)
	})

	it('handles symbol-only string (+)', () => {
		expect(parseLyricFlags('+')).toBe(lyricFlags.pitchSlide)
	})

	it('does not treat mid-text symbols as flags', () => {
		// '_' and '§' are not flag symbols
		expect(parseLyricFlags('wor_ld')).toBe(lyricFlags.none)
		expect(parseLyricFlags('a§b')).toBe(lyricFlags.none)
	})
})

// ---------------------------------------------------------------------------
// stripLyricSymbols
// ---------------------------------------------------------------------------

describe('stripLyricSymbols', () => {
	it('returns plain text unchanged', () => {
		expect(stripLyricSymbols('Hello')).toBe('Hello')
	})

	it('strips trailing + (pitch slide)', () => {
		expect(stripLyricSymbols('Hel+')).toBe('Hel')
	})

	it('keeps trailing - (join flag, but displayed as-is)', () => {
		expect(stripLyricSymbols('to-')).toBe('to-')
	})

	it('replaces trailing = with - (hyphenate)', () => {
		expect(stripLyricSymbols('word=')).toBe('word-')
	})

	it('strips trailing # (non-pitched)', () => {
		expect(stripLyricSymbols('Cha#')).toBe('Cha')
	})

	it('strips trailing ^ (non-pitched lenient)', () => {
		expect(stripLyricSymbols('oh^')).toBe('oh')
	})

	it('strips trailing % (range shift)', () => {
		expect(stripLyricSymbols('go%')).toBe('go')
	})

	it('strips $ prefix (harmony hidden)', () => {
		expect(stripLyricSymbols('$hey')).toBe('hey')
	})

	it('strips + but keeps - in multiple trailing flags', () => {
		expect(stripLyricSymbols('+-')).toBe('-')
	})

	it('strips " from text', () => {
		expect(stripLyricSymbols('"Hello"')).toBe('Hello')
	})

	it('returns empty for symbol-only string', () => {
		expect(stripLyricSymbols('+')).toBe('')
	})

	it('returns empty for empty string', () => {
		expect(stripLyricSymbols('')).toBe('')
	})

	// '_' is kept as-is. YARG replaces '_' → ' ' but that's lossy —
	// real charts use '_' as an apostrophe substitute (e.g. "it_s", "can_t").
	it('keeps _ as-is (YARG replaces with space, but that is lossy)', () => {
		expect(stripLyricSymbols('wor_ld')).toBe('wor_ld')
		expect(stripLyricSymbols('it_s')).toBe('it_s')
	})

	// '§' is kept as-is. YARG replaces '§' → '‿' (joined syllable display).
	it('keeps § as-is (YARG replaces with ‿, but that is lossy)', () => {
		expect(stripLyricSymbols('a§b')).toBe('a§b')
	})

	it('strips $ prefix and trailing + but keeps content', () => {
		expect(stripLyricSymbols('$oh+')).toBe('oh')
	})

	it('strips $ and keeps trailing -', () => {
		expect(stripLyricSymbols('$hid-')).toBe('hid-')
	})

	it('replaces = with - even in middle of text (matching YARG StripForVocals)', () => {
		expect(stripLyricSymbols('a=b')).toBe('a-b')
	})

	it('preserves rich text tags for the consumer to render or strip', () => {
		// Unlike YARG, we keep rich text tags in the stored data. Consumers that
		// render lyrics decide whether to honor or strip them at render time.
		expect(stripLyricSymbols('<i>Back')).toBe('<i>Back')
		expect(stripLyricSymbols('<b>loud</b>')).toBe('<b>loud</b>')
		expect(stripLyricSymbols('<color=#FF0000>red</color>')).toBe('<color=#FF0000>red</color>')
		expect(stripLyricSymbols('<sub><i>REIMAGINED</i>')).toBe('<sub><i>REIMAGINED</i>')
	})

	it('keeps arbitrary angle-bracket content (known tags and custom markup)', () => {
		// All bracketed content is preserved, including unknown tags like <scatting>.
		expect(stripLyricSymbols('<scatting>')).toBe('<scatting>')
		expect(stripLyricSymbols('hello<world>')).toBe('hello<world>')
	})

	it('preserves trailing whitespace (StripForVocals does not trim)', () => {
		expect(stripLyricSymbols('hello ')).toBe('hello ')
		expect(stripLyricSymbols('hello  ')).toBe('hello  ')
	})

	it('preserves tags and trailing whitespace together', () => {
		expect(stripLyricSymbols('<sub><i>REIMAGINED</i> ')).toBe('<sub><i>REIMAGINED</i> ')
	})
})
