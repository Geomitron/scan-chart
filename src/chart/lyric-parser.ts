import type { MidiEvent, MidiTextEvent } from 'midi-file'

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
 * Filters out bracketed annotations (matching YARG NormalizeTextEvent behavior).
 * Deduplicates by tick+text (matching YARG MoonText InsertionEquals).
 */
export function extractChartLyrics(eventLines: string[]): { tick: number; length: number; text: string }[] {
	const lyrics: { tick: number; length: number; text: string }[] = []
	const seen = new Set<string>()
	for (const line of eventLines) {
		const result = parseChartLyricLine(line)
		if (result) {
			// YARG's NormalizeTextEvent runs on "lyric TEXT" and if brackets are found
			// ANYWHERE in the full text, it extracts bracket content and sets hadBrackets=true,
			// making it NOT a lyric. Check if the lyric text contains brackets.
			if (result.text.includes('[') && result.text.includes(']')) continue
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
			if (currentStart !== null) {
				phrases.push({ tick: currentStart, length: result.tick - currentStart })
				currentStart = null
			}
		}
	}

	return phrases
}

// ---------------------------------------------------------------------------
// MIDI lyric parsing
// ---------------------------------------------------------------------------

/**
 * Determine if a MIDI event on PART VOCALS is a lyric.
 *
 * Rules (matching YARG MoonSong behavior):
 * - FF 05 (lyrics type): always included (even if empty — YARG keeps empty lyrics)
 * - FF 01 (text type): only if text doesn't start with [ after trim
 * - Bracketed text [play], [idle], [annotation] are NOT lyrics
 * - Space-only text is NOT a lyric (YARG's NormalizeTextEvent trims it to empty)
 */
export function isMidiVocalLyric(event: { type: string; text?: string }): boolean {
	// YARG's ProcessTextEvent processes BaseTextEvent types (except trackName and copyrightNotice).
	// instrumentName (FF 04) contains the track name, not lyric content.
	const isTextLike = event.type === 'lyrics' || event.type === 'text' ||
		event.type === 'marker' || event.type === 'cuePoint'
	if (!isTextLike) return false

	const text = (event as MidiTextEvent).text
	if (text === undefined || text === null) return false

	const trimmed = text.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '') // TrimAscii
	// Bracketed text is a control/annotation event, not a lyric
	if (trimmed.startsWith('[')) return false
	return true
}

/**
 * Normalize lyric text for MIDI events.
 * Preserves original text including whitespace — YARG ChartDump preserves it.
 * Bracketed text returns empty (filtered by isMidiVocalLyric before reaching here).
 */
export function normalizeLyricText(text: string): string {
	const trimmed = text.trim()
	if (trimmed.startsWith('[')) return ''
	return text
}

/**
 * Extract the lyric text from a MIDI event.
 * Preserves original text — the MIDI file's raw text content.
 */
export function extractMidiLyricText(event: MidiTextEvent): string {
	return event.text
}

/**
 * Extract all lyrics from a PART VOCALS MIDI track's events.
 * Events must already be in absolute time (deltaTime = absolute tick).
 * Deduplicates by tick+text (matching MoonSong InsertionEquals).
 */
export function extractMidiLyrics(trackEvents: MidiEvent[]): { tick: number; length: number; text: string }[] {
	// Find the track name so we can skip tick-0 text events that duplicate it.
	// Some MIDI files have an FF 01 text event "PART VOCALS" at tick 0 which is
	// a duplicate of the FF 03 trackName — not a real lyric. YARG keeps these
	// (a YARG bug), but we filter them out.
	const trackNameEvent = trackEvents.find(e => e.type === 'trackName') as MidiTextEvent | undefined
	const trackName = trackNameEvent?.text

	const lyrics: { tick: number; length: number; text: string }[] = []
	const seen = new Set<string>()
	for (const event of trackEvents) {
		if (isMidiVocalLyric(event)) {
			const text = extractMidiLyricText(event as MidiTextEvent)
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

/**
 * Extract vocal phrase boundaries from MIDI notes 105/106 on PART VOCALS.
 * These notes define phrase regions as note-on/note-off pairs.
 * Events must already be in absolute time (deltaTime = absolute tick).
 */
export function extractMidiVocalPhrases(trackEvents: MidiEvent[]): { tick: number; length: number; noteNumber: number }[] {
	// Collect 105/106 note events, then sort so noteOffs come before noteOns at the same tick.
	// This matches YARG behavior: when noteOff and noteOn share a tick, the old phrase closes
	// before the new one starts, giving the new phrase a proper length.
	const noteEvents: { tick: number; type: 'noteOn' | 'noteOff'; noteNumber: number; velocity: number }[] = []
	for (const event of trackEvents) {
		if ((event.type === 'noteOn' || event.type === 'noteOff') && (event.noteNumber === 105 || event.noteNumber === 106)) {
			const isOff = event.type === 'noteOff' || (event.type === 'noteOn' && event.velocity === 0)
			noteEvents.push({
				tick: event.deltaTime,
				type: isOff ? 'noteOff' : 'noteOn',
				noteNumber: event.noteNumber,
				velocity: event.velocity,
			})
		}
	}
	// Stable sort: same tick → noteOff before noteOn
	noteEvents.sort((a, b) => {
		if (a.tick !== b.tick) return a.tick - b.tick
		// noteOff (0) before noteOn (1)
		const aOrd = a.type === 'noteOff' ? 0 : 1
		const bOrd = b.type === 'noteOff' ? 0 : 1
		return aOrd - bOrd
	})

	const phraseStarts: Map<number, number> = new Map()
	const phrases: { tick: number; length: number; noteNumber: number }[] = []

	for (const event of noteEvents) {
		if (event.type === 'noteOn') {
			// YARG ignores duplicate noteOns — if a note is already open, skip.
			// (MidReader.ProcessNoteEvent: TryFindMatchingNote → log duplicate, don't add)
			if (phraseStarts.has(event.noteNumber)) continue
			phraseStarts.set(event.noteNumber, event.tick)
		} else {
			const startTick = phraseStarts.get(event.noteNumber)
			if (startTick !== undefined) {
				phrases.push({ tick: startTick, length: event.tick - startTick, noteNumber: event.noteNumber })
				phraseStarts.delete(event.noteNumber)
			}
		}
	}

	phrases.sort((a, b) => a.tick - b.tick)
	return phrases
}
