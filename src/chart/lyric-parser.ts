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
 * Returns normal paired phrases. Orphan phrase_end events (no preceding
 * phrase_start) are NOT included here; use `extractChartOrphanPhraseEnds` to
 * retrieve them separately.
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
			// phrase_end: only push if a phrase_start is open. Orphan phrase_ends
			// (no preceding phrase_start) are skipped here — a synthetic (0, endTick)
			// phrase would corrupt lyric grouping by "stealing" lyrics from earlier
			// real phrases via the shared lyricIdx. Orphans are preserved via
			// `extractChartOrphanPhraseEnds` so writers can re-emit them verbatim.
			if (currentStart !== null) {
				phrases.push({ tick: currentStart, length: result.tick - currentStart })
				currentStart = null
			}
		}
	}

	return phrases
}

/**
 * Extract orphan `phrase_end` events from .chart [Events] — a `phrase_end`
 * whose most recent predecessor is NOT a matching `phrase_start`. These are
 * malformed but exist in some charts; YARG preserves them as text events in
 * its globalEvents output, so we keep them here for round-trip fidelity.
 */
export function extractChartOrphanPhraseEnds(eventLines: string[]): { tick: number }[] {
	const orphans: { tick: number }[] = []
	let currentStart: number | null = null
	for (const line of eventLines) {
		const result = parseChartVocalPhraseLine(line)
		if (!result) continue
		if (result.type === 'start') {
			currentStart = result.tick
		} else {
			if (currentStart === null) {
				orphans.push({ tick: result.tick })
			} else {
				currentStart = null
			}
		}
	}
	return orphans
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
 * Extract bracketed control-event text events on a vocal track (stance markers,
 * facial anim, etc.). These aren't lyrics but YARG's ProcessTextEvent still
 * adds them to the chart's text events via MoonText, and VocalsPart.IsEmpty
 * returns `false` iff there's any such event — so dropping them causes a vocal
 * track with only stance markers to be hidden in ChartDump.
 *
 * We intentionally exclude:
 *   - real lyrics (see `extractMidiLyrics`)
 *   - disco flip events `[mix N drumsM]` (drum-specific; shouldn't be on vocals)
 *   - `ENHANCED_OPENS` / `ENABLE_CHART_DYNAMICS` (instrument-wide consumables)
 *   - `range_shift` (handled via the rangeShifts path on its own)
 */
export function extractMidiVocalTextEvents(trackEvents: MidiLyricEvent[]): { tick: number; text: string }[] {
	const out: { tick: number; text: string }[] = []
	// Match YARG.Core's MidReader.ReadNotes: it starts iteration at `i = 1`
	// with the comment "First event is the track name event, which gets
	// skipped". Some MIDI files have a stray FF 01 text duplicate of the
	// track name at index 0 — YARG silently drops it, so scan-chart should
	// too, otherwise we capture a phantom "PART VOCALS" text that appears
	// as a lyric on re-parse.
	for (let i = 1; i < trackEvents.length; i++) {
		const event = trackEvents[i]
		const isTextLike = event.type === 'lyrics' || event.type === 'text' ||
			event.type === 'marker' || event.type === 'cuePoint'
		if (!isTextLike) continue
		const text = event.text
		if (text === undefined || text === null) continue
		const trimmed = text.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '')
		const isBracketed = trimmed.startsWith('[') && trimmed.endsWith(']')
		// We capture text-like events that YARG would preserve as MoonText but
		// scan-chart otherwise drops from `data.lyrics` (via normalizeVocalPart's
		// bracketed-control-event filter). Lyrics themselves live in `data.lyrics`
		// and are handled separately.
		if (!isBracketed) continue
		// Skip events scan-chart consumes internally
		if (text === 'ENHANCED_OPENS' || text === '[ENHANCED_OPENS]') continue
		if (text === 'ENABLE_CHART_DYNAMICS' || text === '[ENABLE_CHART_DYNAMICS]') continue
		// Skip disco flip markers (drum-track concept; shouldn't appear on vocals)
		if (/^\s*\[?mix[ _][0-3][ _]drums[0-5](d|dnoflip|easy|easynokick|)\]?\s*$/.test(text)) continue
		if (trimmed.startsWith('[range_shift')) continue
		out.push({ tick: event.deltaTime, text })
	}
	return out
}

/**
 * Extract all lyrics from a PART VOCALS MIDI track's events.
 * Events must already be in absolute time (deltaTime = absolute tick).
 * Deduplicates by tick+text (matching MoonSong InsertionEquals).
 */
export function extractMidiLyrics(trackEvents: MidiLyricEvent[]): { tick: number; length: number; text: string }[] {
	const lyrics: { tick: number; length: number; text: string }[] = []
	const seen = new Set<string>()
	// Match YARG.Core's MidReader.ReadNotes: skip the first event (which is
	// conventionally the trackName and lost by "for (int i = 1; ...)"). Charts
	// like "Andrew Prahlow - Travelers' Encore" have an FF 01 text event
	// "PART VOCALS" AS the first event — YARG drops it silently. Skipping it
	// here matches that behavior.
	for (let i = 1; i < trackEvents.length; i++) {
		const event = trackEvents[i]
		if (isMidiVocalLyric(event)) {
			const text = extractMidiLyricText(event)
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
 * Extract note-on/note-off pairs for the given MIDI note numbers. Processes
 * events in MIDI file order (sorted stably by tick), matching YARG.Core's
 * `MidReader.ProcessNoteEvent`: velocity-0 noteOn is treated as noteOff,
 * duplicate noteOn while a note is already open is ignored.
 *
 * MIDI file order correctly handles zero-length notes (noteOn + noteOff at the
 * same tick for the same pitch): the noteOn opens the note and the following
 * noteOff closes it immediately. Without preserving order, sorting noteOff
 * before noteOn at the same tick would steal the close from a later real note
 * (real example: "The Lumineers - Ho Hey" has a zero-length note 60 at tick
 * 49840 that would otherwise steal the noteOff at tick 55080 from the real
 * note at tick 54880).
 *
 * Events must already be in absolute time (deltaTime = absolute tick).
 */
function extractMidiNotePairs(
	trackEvents: MidiLyricEvent[],
	noteFilter: (noteNumber: number) => boolean,
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
	// Stable sort by tick only, preserving MIDI file order at the same tick.
	noteEvents.sort((a, b) => a.tick - b.tick)

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
 * Extract scoring phrase boundaries (note 105) from a MIDI vocal track.
 * Events must already be in absolute time (deltaTime = absolute tick).
 */
export function extractMidi105Phrases(trackEvents: MidiLyricEvent[]): { tick: number; length: number }[] {
	return extractMidiNotePairs(trackEvents, n => n === 105)
		.map(p => ({ tick: p.tick, length: p.length }))
}

/**
 * Extract static lyric display phrase boundaries (note 106) from a MIDI vocal track.
 * On HARM2/HARM3 these are the "static lyric" phrases that display lyrics
 * alongside HARM1's scoring phrases. On PART VOCALS this is the player-2 phrase.
 */
export function extractMidi106Phrases(trackEvents: MidiLyricEvent[]): { tick: number; length: number }[] {
	return extractMidiNotePairs(trackEvents, n => n === 106)
		.map(p => ({ tick: p.tick, length: p.length }))
}

/**
 * @deprecated Use `extractMidi105Phrases` and `extractMidi106Phrases` separately.
 * Kept for backward compatibility with scan-chart's own tests.
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
 * Strips VOCALS_STRIP_SYMBOLS (+, #, ^, *, %, /, $, ") and trims leading ASCII
 * whitespace. Trailing '-' is kept (it's a display character). Trailing '=' is
 * replaced with '-'. Keeps '_' and '§' as-is (consumer decides display replacement).
 *
 * Unlike YARG's `StripForVocals`, rich text tags (<i>, <b>, <color>, etc.) are
 * preserved in the output — consumers that render lyrics can decide whether to
 * honor or strip them at render time. To avoid breaking tag syntax, characters
 * inside `<...>` are passed through verbatim.
 */
export function stripLyricSymbols(text: string): string {
	// Trim leading ASCII whitespace (matching YARG's TrimStartAscii in ProcessLyric)
	text = text.replace(/^[\x00-\x20]+/, '')
	// Find the boundary between content and trailing flag symbols.
	// Trailing flags are consumed right-to-left by parseLyricFlags.
	let trailEnd = text.length
	while (trailEnd > 0 && trailingSymbolFlags[text[trailEnd - 1]] !== undefined) {
		trailEnd--
	}

	let result = ''
	let insideTag = false
	// Process non-trailing portion: strip symbols that are in VOCALS_STRIP_SYMBOLS,
	// except inside <...> where rich-text markup should be preserved verbatim.
	for (let i = 0; i < trailEnd; i++) {
		const ch = text[i]
		if (ch === '<') insideTag = true
		if (insideTag) {
			result += ch
			if (ch === '>') insideTag = false
			continue
		}
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
