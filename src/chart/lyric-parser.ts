/** Minimal MIDI event shape for lyric/text extraction. */
export interface MidiTextLikeEvent {
	type: string
	deltaTime: number
	text?: string
}

/** Minimal MIDI event shape for note-based extraction (vocal phrases). */
export interface MidiNoteLikeEvent {
	type: string
	deltaTime: number
	noteNumber?: number
	velocity?: number
}

/** Union of fields used by all MIDI lyric/phrase functions. */
export type MidiLyricEvent = MidiTextLikeEvent & MidiNoteLikeEvent

// ---------------------------------------------------------------------------
// .chart lyric parsing
// ---------------------------------------------------------------------------

/**
 * Parse a single .chart [Events] line for a lyric event.
 * Returns { tick, text } if the line is a lyric event, null otherwise.
 *
 * .chart lyric format: `TICK = E "lyric TEXT"`
 */
export function parseChartLyricLine(line: string): { tick: number; text: string } | null {
	// Standard format: TICK = E "lyric TEXT"
	// Use [^\n] instead of . to handle embedded \r characters
	// Allow optional leading space before "lyric" (some charts have " lyric X")
	const match = /^(\d+) = E "\s*lyric ([^\n]+?)"$/.exec(line)
	if (match) return { tick: Number(match[1]), text: match[2] }
	// Empty lyric: TICK = E "lyric " (space-only between "lyric " and closing quote)
	const emptyMatch = /^(\d+) = E "\s*lyric\s*"$/.exec(line)
	if (emptyMatch) return { tick: Number(emptyMatch[1]), text: '' }
	// Malformed: missing closing quote — YARG parses these leniently
	const lenient = /^(\d+) = E "\s*lyric ([^\n]+)$/.exec(line)
	if (lenient) return { tick: Number(lenient[1]), text: lenient[2] }
	return null
}

/**
 * Parse a single .chart [Events] line for a vocal phrase start/end event.
 * Returns { tick, type: 'start' | 'end' } or null.
 */
export function parseChartVocalPhraseLine(line: string): { tick: number; type: 'start' | 'end' } | null {
	const startMatch = /^(\d+) = E "phrase_start"$/.exec(line)
	if (startMatch) return { tick: Number(startMatch[1]), type: 'start' }
	const endMatch = /^(\d+) = E "phrase_end"$/.exec(line)
	if (endMatch) return { tick: Number(endMatch[1]), type: 'end' }
	return null
}

/**
 * Extract all lyrics from .chart [Events] lines.
 * The "lyric" prefix is definitive — all lyric events are real lyrics, even if
 * they contain brackets (e.g. "[Everyone liked that]" is a Fallout reference).
 * Deduplicates by tick+text (matching YARG MoonText InsertionEquals).
 */
export function extractChartLyrics(eventLines: string[]): { tick: number; length: number; text: string }[] {
	const lyrics: { tick: number; length: number; text: string }[] = []
	const seen = new Set<string>()
	for (const line of eventLines) {
		const result = parseChartLyricLine(line)
		if (result) {
			// Dedup by tick + normalized text (YARG's InsertionEquals compares tick + text,
			// and NormalizeTextEvent applies TrimAscii, so "_ " and "_" are equivalent)
			const normalizedText = result.text.replace(/[\x00-\x20]+$/, '')
			const key = `${result.tick}:${normalizedText}`
			if (seen.has(key)) continue
			seen.add(key)
			lyrics.push({ tick: result.tick, length: 0, text: result.text })
		}
	}
	return lyrics
}

/**
 * Extract vocal phrase boundaries from .chart [Events] phrase_start/phrase_end pairs.
 */
export function extractChartVocalPhrases(eventLines: string[]): { tick: number; length: number }[] {
	const phrases: { tick: number; length: number }[] = []
	let currentStart: number | null = null

	for (const line of eventLines) {
		const result = parseChartVocalPhraseLine(line)
		if (!result) continue
		if (result.type === 'start') {
			// If there's already an open phrase, close it at this tick
			if (currentStart !== null) {
				phrases.push({ tick: currentStart, length: result.tick - currentStart })
			}
			currentStart = result.tick
		} else {
			// If no phrase_start is open, treat as starting from tick 0.
			// Orphaned phrase_ends are kept so editors can surface them for manual fixing.
			if (currentStart === null) {
				currentStart = 0
			}
			phrases.push({ tick: currentStart, length: result.tick - currentStart })
			currentStart = null
		}
	}

	return phrases
}

// ---------------------------------------------------------------------------
// MIDI lyric parsing
// ---------------------------------------------------------------------------

/**
 * Known bracketed control events on PART VOCALS that are NOT lyrics.
 * These control character animation and percussion instrument switching.
 */
export const knownVocalControlEvents = new Set([
	'idle', 'idle_realtime', 'idle_intense',
	'play', 'play_solo',
	'mellow', 'intense',
	'tambourine_start', 'tambourine_end',
	'cowbell_start', 'cowbell_end',
	'clap_start', 'clap_end',
])

/**
 * Check if text is a known bracketed control event (e.g. "[play]", "[idle]").
 * Only filters known control events — unknown bracketed text like "[Everyone liked that]"
 * is treated as real lyric content.
 */
export function isBracketedControlEvent(text: string): boolean {
	const trimmed = text.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '') // TrimAscii
	if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return false
	const inner = trimmed.slice(1, -1)
	return knownVocalControlEvents.has(inner)
}

/**
 * Determine if a MIDI event on PART VOCALS is a lyric.
 *
 * Rules:
 * - FF 05 (lyrics), FF 01 (text), FF 06 (marker), FF 07 (cuePoint): included
 * - Known bracketed control events ([play], [idle], etc.) are NOT lyrics
 * - Unknown bracketed text ([Everyone liked that]) IS a lyric
 * - Empty text is a valid lyric (empty lyrics show in game)
 */
export function isMidiVocalLyric(event: MidiTextLikeEvent): boolean {
	// YARG's ProcessTextEvent processes BaseTextEvent types (except trackName and copyrightNotice).
	// instrumentName (FF 04) contains the track name, not lyric content.
	const isTextLike = event.type === 'lyrics' || event.type === 'text' ||
		event.type === 'marker' || event.type === 'cuePoint'
	if (!isTextLike) return false

	const text = event.text
	if (text === undefined || text === null) return false

	// Only filter known control events, not arbitrary bracketed text
	if (isBracketedControlEvent(text)) return false
	return true
}

/**
 * Normalize lyric text for MIDI events.
 * Preserves original text including whitespace — YARG ChartDump preserves it.
 * Known control events return empty (filtered by isMidiVocalLyric before reaching here).
 */
export function normalizeLyricText(text: string): string {
	if (isBracketedControlEvent(text)) return ''
	return text
}

/**
 * Extract the lyric text from a MIDI event.
 * Preserves original text — the MIDI file's raw text content.
 */
export function extractMidiLyricText(event: MidiTextLikeEvent): string {
	return event.text ?? ''
}

/**
 * Extract all lyrics from a PART VOCALS MIDI track's events.
 * Events must already be in absolute time (deltaTime = absolute tick).
 * Deduplicates by tick+text (matching MoonSong InsertionEquals).
 */
export function extractMidiLyrics(trackEvents: MidiLyricEvent[]): { tick: number; length: number; text: string }[] {
	// Find the track name so we can skip tick-0 text events that duplicate it.
	// Some MIDI files have an FF 01 text event "PART VOCALS" at tick 0 which is
	// a duplicate of the FF 03 trackName — not a real lyric. YARG keeps these
	// (a YARG bug), but we filter them out.
	const trackNameEvent = trackEvents.find(e => e.type === 'trackName')
	const trackName = trackNameEvent?.text

	const lyrics: { tick: number; length: number; text: string }[] = []
	const seen = new Set<string>()
	for (const event of trackEvents) {
		if (isMidiVocalLyric(event)) {
			const text = extractMidiLyricText(event)
			// Skip tick-0 text events that match the track name (instrumentName duplicate)
			if (event.deltaTime === 0 && text === trackName && event.type === 'text') continue
			const key = `${event.deltaTime}:${text}`
			if (seen.has(key)) continue
			seen.add(key)
			lyrics.push({ tick: event.deltaTime, length: 0, text })
		}
	}
	return lyrics
}

// ---------------------------------------------------------------------------
// Generic MIDI note-on/note-off pair extraction
// ---------------------------------------------------------------------------

/**
 * Extract note-on/note-off pairs for the given MIDI note numbers.
 * Handles: velocity-0 noteOn as noteOff, noteOff-before-noteOn sort at same tick,
 * duplicate noteOn skip (matching YARG's ProcessNoteEvent).
 * Events must already be in absolute time (deltaTime = absolute tick).
 */
function extractMidiNotePairs(
	trackEvents: MidiLyricEvent[],
	noteFilter: (noteNumber: number) => boolean,
	/** If true, preserve MIDI event order at the same tick (noteOn before noteOff).
	 *  If false (default), sort noteOff before noteOn at the same tick.
	 *  Vocal notes need MIDI order to handle zero-length notes correctly (matching YARG). */
	preserveMidiOrder = false,
): { tick: number; length: number; noteNumber: number }[] {
	const noteEvents: { tick: number; type: 'noteOn' | 'noteOff'; noteNumber: number }[] = []
	for (const event of trackEvents) {
		if ((event.type === 'noteOn' || event.type === 'noteOff') && event.noteNumber !== undefined && noteFilter(event.noteNumber)) {
			const isOff = event.type === 'noteOff' || (event.type === 'noteOn' && event.velocity === 0)
			noteEvents.push({
				tick: event.deltaTime,
				type: isOff ? 'noteOff' : 'noteOn',
				noteNumber: event.noteNumber,
			})
		}
	}
	if (preserveMidiOrder) {
		// Sort by tick only, preserving original order within same tick
		noteEvents.sort((a, b) => a.tick - b.tick)
	} else {
		// Sort: same tick → noteOff before noteOn (for phrase boundaries)
		noteEvents.sort((a, b) => {
			if (a.tick !== b.tick) return a.tick - b.tick
			return (a.type === 'noteOff' ? 0 : 1) - (b.type === 'noteOff' ? 0 : 1)
		})
	}

	const phraseStarts: Map<number, number> = new Map()
	const results: { tick: number; length: number; noteNumber: number }[] = []

	for (const event of noteEvents) {
		if (event.type === 'noteOn') {
			// YARG ignores duplicate noteOns — if a note is already open, skip.
			if (phraseStarts.has(event.noteNumber)) continue
			phraseStarts.set(event.noteNumber, event.tick)
		} else {
			const startTick = phraseStarts.get(event.noteNumber)
			if (startTick !== undefined) {
				results.push({ tick: startTick, length: event.tick - startTick, noteNumber: event.noteNumber })
				phraseStarts.delete(event.noteNumber)
			}
		}
	}

	results.sort((a, b) => a.tick - b.tick)
	return results
}

// ---------------------------------------------------------------------------
// MIDI vocal phrase extraction
// ---------------------------------------------------------------------------

/**
 * Extract vocal phrase boundaries from MIDI notes 105/106 on PART VOCALS.
 * Events must already be in absolute time (deltaTime = absolute tick).
 */
export function extractMidiVocalPhrases(trackEvents: MidiLyricEvent[]): { tick: number; length: number; noteNumber: number }[] {
	return extractMidiNotePairs(trackEvents, n => n === 105 || n === 106)
}

// ---------------------------------------------------------------------------
// MIDI vocal notes (pitch 36-84, percussion 96/97)
// ---------------------------------------------------------------------------

export type VocalNoteType = 'pitched' | 'percussion' | 'percussionHidden'

export interface VocalNote {
	tick: number
	length: number
	pitch: number
	type: VocalNoteType
}

function noteNumberToVocalType(noteNumber: number): VocalNoteType | null {
	if (noteNumber >= 36 && noteNumber <= 84) return 'pitched'
	if (noteNumber === 96) return 'percussion'
	if (noteNumber === 97) return 'percussionHidden'
	return null
}

/**
 * Extract vocal notes (pitched 36-84, percussion 96/97) from a MIDI vocal track.
 * Events must already be in absolute time (deltaTime = absolute tick).
 */
export function extractMidiVocalNotes(trackEvents: MidiLyricEvent[]): VocalNote[] {
	const pairs = extractMidiNotePairs(
		trackEvents,
		n => (n >= 36 && n <= 84) || n === 96 || n === 97,
		true, // preserve MIDI order for correct zero-length note handling (matching YARG)
	)
	return pairs.map(p => ({
		tick: p.tick,
		length: p.length,
		pitch: p.noteNumber,
		type: noteNumberToVocalType(p.noteNumber)!,
	}))
}

// ---------------------------------------------------------------------------
// MIDI vocal star power, range shifts, lyric shifts
// ---------------------------------------------------------------------------

/**
 * Extract star power sections from note 116 on a MIDI vocal track.
 */
export function extractMidiVocalStarPower(trackEvents: MidiLyricEvent[]): { tick: number; length: number }[] {
	return extractMidiNotePairs(trackEvents, n => n === 116)
}

/**
 * Extract range shift markers from note 0 on a MIDI vocal track.
 * Length determines the shift speed (gradual transition).
 */
export function extractMidiRangeShifts(trackEvents: MidiLyricEvent[]): { tick: number; length: number }[] {
	return extractMidiNotePairs(trackEvents, n => n === 0)
}

/**
 * Extract lyric shift markers from note 1 on a MIDI vocal track.
 * Used for static lyric display scrolling within a phrase.
 */
export function extractMidiLyricShifts(trackEvents: MidiLyricEvent[]): { tick: number; length: number }[] {
	return extractMidiNotePairs(trackEvents, n => n === 1)
}

// ---------------------------------------------------------------------------
// Lyric symbol parsing (for normalization)
// ---------------------------------------------------------------------------

import { lyricFlags } from './note-parsing-interfaces'

/** Symbols that set flags when found at the end of a lyric (scanned right-to-left). */
const trailingSymbolFlags: Record<string, number> = {
	'-': lyricFlags.joinWithNext,
	'=': lyricFlags.hyphenateWithNext,
	'+': lyricFlags.pitchSlide,
	'#': lyricFlags.nonPitched,
	'^': lyricFlags.nonPitched | lyricFlags.lenientScoring,
	'*': lyricFlags.nonPitched,
	'%': lyricFlags.rangeShift,
	'/': lyricFlags.staticShift,
	'$': lyricFlags.harmonyHidden,
}

/** Symbols stripped from display text everywhere they appear. */
const stripSymbols = new Set(['+', '#', '^', '*', '%', '/', '$', '"'])

/** Trailing flag symbols that are stripped from display (YARG VOCALS_STRIP_SYMBOLS).
 *  '-' and '=' are NOT in this set — '-' is kept, '=' is replaced with '-'. */
const trailingStripSymbols = new Set(['+', '#', '^', '*', '%', '/', '$'])

/** Known rich text tag names (matching YARG RichTextUtils.RICH_TEXT_TAGS). */
const richTextTagNames = [
	'align', 'allcaps', 'alpha', 'b', 'br', 'color', 'cspace', 'font', 'font-weight',
	'gradient', 'i', 'indent', 'line-height', 'line-indent', 'link', 'lowercase',
	'margin', 'mark', 'mspace', 'noparse', 'nobr', 'page', 'pos', 'rotate', 'size',
	'smallcaps', 'space', 'sprite', 's', 'style', 'sub', 'sup', 'u', 'uppercase', 'voffset', 'width',
]
/** Regex matching opening and closing rich text tags: <tag>, </tag>, <tag=value>, etc. */
const richTextTagRegex = new RegExp(
	`<\\/?(${richTextTagNames.join('|')})(=[^>]*)?>`, 'gi',
)

/**
 * Parse lyric symbol flags from a lyric text string.
 * Matches YARG's LyricSymbols.GetLyricFlags(): scans from end consuming flag symbols,
 * and checks start for '$' (harmony hidden).
 */
export function parseLyricFlags(text: string): number {
	let flags = 0
	if (text.length === 0) return flags

	// '$' at start = harmony hidden
	if (text[0] === '$') flags |= lyricFlags.harmonyHidden

	// Scan trailing symbols right-to-left
	let i = text.length - 1
	while (i >= 0) {
		const flag = trailingSymbolFlags[text[i]]
		if (flag === undefined) break
		flags |= flag
		i--
	}

	return flags
}

/**
 * Strip lyric symbols from text for display.
 * Matches YARG's StripForVocals: strips VOCALS_STRIP_SYMBOLS (+, #, ^, *, %, /, $, "),
 * removes known rich text tags, and trims leading ASCII whitespace.
 * Trailing '-' is kept (it's a display character). Trailing '=' is replaced with '-'.
 * Keeps '_' and '§' as-is (consumer decides display replacement).
 */
export function stripLyricSymbols(text: string): string {
	// Strip known rich text tags (matching YARG's RichTextUtils.StripRichTextTags).
	// Only strips recognized tags — unknown tags like <scatting> are preserved.
	text = text.replace(richTextTagRegex, '')
	// Trim leading ASCII whitespace (matching YARG's TrimStartAscii in ProcessLyric)
	text = text.replace(/^[\x00-\x20]+/, '')
	// Find the boundary between content and trailing flag symbols.
	// Trailing flags are consumed right-to-left by parseLyricFlags.
	let trailEnd = text.length
	while (trailEnd > 0 && trailingSymbolFlags[text[trailEnd - 1]] !== undefined) {
		trailEnd--
	}

	let result = ''
	// Process non-trailing portion: strip symbols that are in VOCALS_STRIP_SYMBOLS
	for (let i = 0; i < trailEnd; i++) {
		const ch = text[i]
		if (stripSymbols.has(ch)) continue
		if (ch === '=') { result += '-'; continue }
		result += ch
	}
	// Process trailing portion: only strip the ones YARG strips, keep '-', replace '='
	for (let i = trailEnd; i < text.length; i++) {
		const ch = text[i]
		if (trailingStripSymbols.has(ch)) continue
		if (ch === '=') { result += '-'; continue }
		result += ch // only '-' reaches here
	}
	return result
}
