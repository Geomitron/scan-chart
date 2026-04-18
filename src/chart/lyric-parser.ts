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

/** Full classification of a MIDI vocal track — populated by one pass. */
export interface VocalTrackScanResult {
	/** Non-control text-like events (deduped by tick+text). */
	lyrics: { tick: number; length: number; text: string }[]
	/** Bracketed text events YARG preserves as MoonText ([play], [idle], etc.). */
	textEvents: { tick: number; text: string }[]
	/** Scoring phrase boundaries from note 105. */
	phrases105: { tick: number; length: number }[]
	/** Static lyric / player-2 phrase boundaries from note 106. */
	phrases106: { tick: number; length: number }[]
	/** Vocal notes: pitched 36–84, percussion 96 (displayed), 97 (hidden). */
	notes: VocalNote[]
	/** Star power sections from note 116. */
	starPower: { tick: number; length: number }[]
	/** Range shift markers from note 0 (length = transition speed). */
	rangeShifts: { tick: number; length: number }[]
	/** Lyric shift markers from note 1 (for static lyric scrolling). */
	lyricShifts: { tick: number; length: number }[]
}

/** Regex for disco flip markers (drum-track concept; skipped on vocal tracks). */
const discoFlipRegex = /^\s*\[?mix[ _][0-3][ _]drums[0-5](d|dnoflip|easy|easynokick|)\]?\s*$/

/**
 * Single-pass classification of a MIDI vocal track.
 *
 * One loop walks `trackEvents` once, routing each event to the appropriate
 * bucket:
 *
 * - **text-like events** (`lyrics`, `text`, `marker`, `cuePoint`) are split
 *   between `lyrics` and `textEvents`. Events consumed elsewhere
 *   (`ENHANCED_OPENS`, `ENABLE_CHART_DYNAMICS`, `[mix N drumsM]` disco flips,
 *   `[range_shift ...]`) are dropped — they're not vocal content, just carried
 *   on this track. Bracketed events go into `textEvents` (MoonText round-trip);
 *   known control markers (`[play]`, `[idle]`, stance/percussion switches) are
 *   **not** lyrics, but unknown bracketed text like `[Everyone liked that]` is
 *   (YARG's ProcessLyric accepts it).
 *
 * - **note events** (`noteOn` / `noteOff`) are paired by `noteNumber` and
 *   routed: 0 → rangeShifts, 1 → lyricShifts, 105 → phrases105, 106 →
 *   phrases106, 116 → starPower, 36–84 / 96 / 97 → notes. Velocity-0 noteOn
 *   counts as noteOff. Duplicate noteOn while a note is already open is
 *   ignored (matches YARG's `MidReader.ProcessNoteEvent`).
 *
 * Requires tick-sorted input — `trackEvents` must already be in absolute time
 * (deltaTime = absolute tick). MIDI files are monotonic after
 * `convertToAbsoluteTime`, so this holds by construction.
 *
 * Track-name skip: YARG.Core's `MidReader.ReadNotes` starts iteration at
 * `i = 1` to skip the conventional track-name event at index 0. Some MIDI
 * files have a stray FF 01 text duplicate of the track name at index 0 —
 * YARG silently drops it, so we skip text classification for index 0 too.
 *
 * Single-pitch buckets (0, 1, 105, 106, 116) emit pairs in start-tick order
 * automatically because a noteNumber can't overlap itself. `notes` holds
 * multiple pitches (e.g. 60 and 72 can overlap), so a small bucket-local sort
 * by start tick reorders the `notes` output. "The Lumineers - Ho Hey" is the
 * canonical test case: zero-length note 60 at tick 49840 must not steal the
 * noteOff at 55080 from the real note at 54880 — preserved by the
 * first-matching-noteOff rule.
 */
export function scanVocalTrack(trackEvents: MidiLyricEvent[]): VocalTrackScanResult {
	const lyrics: VocalTrackScanResult['lyrics'] = []
	const textEvents: VocalTrackScanResult['textEvents'] = []
	const phrases105: VocalTrackScanResult['phrases105'] = []
	const phrases106: VocalTrackScanResult['phrases106'] = []
	const notes: VocalNote[] = []
	const starPower: VocalTrackScanResult['starPower'] = []
	const rangeShifts: VocalTrackScanResult['rangeShifts'] = []
	const lyricShifts: VocalTrackScanResult['lyricShifts'] = []

	const seenLyrics = new Set<string>()
	const openNotes = new Map<number, number>() // noteNumber → open tick

	for (let i = 0; i < trackEvents.length; i++) {
		const event = trackEvents[i]

		// --- Note events (all buckets except lyrics/textEvents) ---
		if (event.type === 'noteOn' || event.type === 'noteOff') {
			const n = event.noteNumber
			if (n === undefined) continue
			const vocalType = noteNumberToVocalType(n)
			const isRelevantNote = n === 0 || n === 1 || n === 105 || n === 106 || n === 116 || vocalType !== null
			if (!isRelevantNote) continue

			const isOff = event.type === 'noteOff' || (event.type === 'noteOn' && event.velocity === 0)
			if (!isOff) {
				// YARG ignores duplicate noteOns — if already open, skip.
				if (!openNotes.has(n)) openNotes.set(n, event.deltaTime)
			} else {
				const startTick = openNotes.get(n)
				if (startTick === undefined) continue
				openNotes.delete(n)
				const length = event.deltaTime - startTick
				switch (n) {
					case 0:   rangeShifts.push({ tick: startTick, length }); break
					case 1:   lyricShifts.push({ tick: startTick, length }); break
					case 105: phrases105.push({ tick: startTick, length }); break
					case 106: phrases106.push({ tick: startTick, length }); break
					case 116: starPower.push({ tick: startTick, length }); break
					default:
						notes.push({ tick: startTick, length, pitch: n, type: vocalType! })
				}
			}
			continue
		}

		// --- Text-like events (lyrics + textEvents). Skip index 0. ---
		if (i === 0) continue
		const isTextLike = event.type === 'lyrics' || event.type === 'text' ||
			event.type === 'marker' || event.type === 'cuePoint'
		if (!isTextLike) continue
		const text = event.text
		if (text === undefined || text === null) continue

		// Events consumed elsewhere — drop from both buckets.
		if (text === 'ENHANCED_OPENS' || text === '[ENHANCED_OPENS]') continue
		if (text === 'ENABLE_CHART_DYNAMICS' || text === '[ENABLE_CHART_DYNAMICS]') continue
		if (discoFlipRegex.test(text)) continue

		const trimmed = text.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '')
		const isBracketed = trimmed.startsWith('[') && trimmed.endsWith(']')
		if (isBracketed && trimmed.startsWith('[range_shift')) continue

		// Bracketed events round-trip as MoonText textEvents. Known control
		// markers are never lyrics; unknown bracketed text is also kept as a
		// textEvent (YARG emits it via both the lyric and MoonText paths).
		if (isBracketed) {
			textEvents.push({ tick: event.deltaTime, text })
		}

		const isKnownControlEvent = isBracketed && knownVocalControlEvents.has(trimmed.slice(1, -1))
		if (isKnownControlEvent) continue

		const key = `${event.deltaTime}:${text}`
		if (seenLyrics.has(key)) continue
		seenLyrics.add(key)
		lyrics.push({ tick: event.deltaTime, length: 0, text })
	}

	// Only `notes` can have overlapping pitches emitting out of start-tick order.
	notes.sort((a, b) => a.tick - b.tick)

	return { lyrics, textEvents, phrases105, phrases106, notes, starPower, rangeShifts, lyricShifts }
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
