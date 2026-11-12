import { decodeText } from './midi-tokens'
import { chartEventsEventText } from './song-events'

/** Minimal MIDI event shape for lyric/text extraction. */
export interface MidiTextLikeEvent {
	type: string
	deltaTime: number
	text?: string
	/** An unknown meta event's bytes and type byte, such as FF 08's and FF 09's. */
	data?: ArrayLike<number>
	metatypeByte?: number
}

/**
 * The text of an event a vocal track reads as a lyric or text event, or `undefined` when it isn't one. Every scanner
 * reads every type of text event so, except a copyright notice (FF 02) and a track name (FF 03): FF 01 and FF 04 to
 * FF 09 (`docs/mid/vocals.mdx`). The MIDI reader gives FF 08 and FF 09 as unknown meta events, so their text is
 * decoded here as the reader decodes text.
 */
export function vocalTrackEventText(event: MidiTextLikeEvent): string | undefined {
	switch (event.type) {
		case 'text':
		case 'instrumentName':
		case 'lyrics':
		case 'marker':
		case 'cuePoint':
			return event.text ?? undefined
		case 'unknownMeta':
			return (event.metatypeByte === 0x08 || event.metatypeByte === 0x09) && event.data !== undefined ? decodeText(Uint8Array.from(event.data)) : undefined
		default:
			return undefined
	}
}

/** Minimal MIDI event shape for note-based extraction (vocal phrases). */
export interface MidiNoteLikeEvent {
	type: string
	deltaTime: number
	noteNumber?: number
	velocity?: number
	channel?: number
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
 * .chart lyric format: `TICK = E "lyric TEXT"`, read by the bracket rule (`chartEventsEventText`), so `E "[lyric x]"`
 * is the lyric `x`. A lyric with no text is read with the text "", and grouping drops it.
 */
export function parseChartLyricLine(line: string): { tick: number; text: string } | null {
	// Use [^\n] instead of . to handle embedded \r characters. A line missing its closing quote is read to its end, as
	// YARG reads it.
	const match = /^(\d+) = E "([^\n]*?)"$/.exec(line) ?? /^(\d+) = E "([^\n]*)$/.exec(line)
	if (!match) return null
	const text = chartEventsEventText(match[2])
	if (text === null) return null
	if (text === 'lyric') return { tick: Number(match[1]), text: '' }
	return text.startsWith('lyric ') ? { tick: Number(match[1]), text: text.slice('lyric '.length) } : null
}

/**
 * Parse a single .chart [Events] line for a vocal phrase start/end event, read by the bracket rule
 * (`chartEventsEventText`). Returns { tick, type: 'start' | 'end' } or null.
 */
export function parseChartVocalPhraseLine(line: string): { tick: number; type: 'start' | 'end' } | null {
	const match = /^(\d+) = E "([^\r\n]*?)"$/.exec(line)
	if (!match) return null
	const text = chartEventsEventText(match[2])
	if (text === 'phrase_start') return { tick: Number(match[1]), type: 'start' }
	if (text === 'phrase_end') return { tick: Number(match[1]), type: 'end' }
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
 * - FF 01 and FF 04 to FF 09, every text event but a copyright notice and a track name: included
 * - Known bracketed control events ([play], [idle], etc.) are NOT lyrics
 * - Unknown bracketed text ([Everyone liked that]) IS a lyric
 * - Empty text is a valid lyric (empty lyrics show in game)
 */
export function isMidiVocalLyric(event: MidiTextLikeEvent): boolean {
	const text = vocalTrackEventText(event)
	if (text === undefined) return false

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

/**
 * Full classification of a MIDI vocal track — populated by one pass.
 *
 * The generic parameter `T` preserves the caller's event type in
 * `unrecognizedMidiEvents`. Real callers pass `MidiEvent[]` (from midi-file) and
 * get back `MidiEvent[]` for verbatim round-trip. Unit tests pass narrower
 * hand-crafted shapes (satisfying `MidiLyricEvent`) and get back the same
 * shape.
 */
export interface VocalTrackScanResult<T extends MidiLyricEvent = MidiLyricEvent> {
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
	/**
	 * MIDI events this scanner didn't consume — stray noteOn/noteOff outside
	 * the recognized vocal note ranges, plus any sysEx / meta / channel
	 * events that vocal tracks don't typically carry. Stored verbatim
	 * (deltaTime = absolute tick) so writers can re-emit them for round-trip.
	 * Events intentionally consumed elsewhere (`ENHANCED_OPENS`,
	 * `ENABLE_CHART_DYNAMICS`, disco flip) are dropped,
	 * not unrecognized. Structural events (`trackName`, `endOfTrack`) are
	 * also skipped — writers re-emit them independently.
	 */
	unrecognizedMidiEvents: T[]
}

/** Regex for disco flip markers (drum-track concept; skipped on vocal tracks). */
const discoFlipRegex = /^\s*\[?mix[ _][0-3][ _]drums[0-5](d|dnoflip|easy|easynokick|)\]?\s*$/

/**
 * Single-pass classification of a MIDI vocal track.
 *
 * One loop walks `trackEvents` once, routing each event to the appropriate
 * bucket:
 *
 * - **text-like events** (every type `vocalTrackEventText` reads) are split
 *   between `lyrics` and `textEvents`. Events consumed elsewhere
 *   (`ENHANCED_OPENS`, `ENABLE_CHART_DYNAMICS`, `[mix N drumsM]` disco flips)
 *   are dropped — they're not vocal content, just carried on this track.
 *   Bracketed events go into `textEvents` (MoonText round-trip);
 *   known control markers (`[play]`, `[idle]`, stance/percussion switches) are
 *   **not** lyrics, but unknown bracketed text like `[Everyone liked that]` is
 *   (YARG's ProcessLyric accepts it).
 *
 * - **note events** (`noteOn` / `noteOff`) pair as an instrument track's do
 *   (`docs/mid/note-pairing.mdx`): a note-off ends the latest open note of its
 *   number and channel, and a velocity-0 noteOn counts as a noteOff. They're
 *   routed: 0 → rangeShifts, 1 → lyricShifts, 105 → phrases105, 106 →
 *   phrases106, 116 → starPower, 36–84 / 96 / 97 → notes. Then overlapping
 *   notes of one pitch are trimmed as overlapping sustains are, and of two at
 *   one tick the longer is kept (`docs/mid/vocals.mdx`, "Overlapping notes of
 *   one part").
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
 * A note-off ends the latest open note, so pairs can end out of start order;
 * each bucket is sorted by start tick.
 */
export function scanVocalTrack<T extends MidiLyricEvent>(trackEvents: T[]): VocalTrackScanResult<T> {
	const lyrics: VocalTrackScanResult['lyrics'] = []
	const textEvents: VocalTrackScanResult['textEvents'] = []
	const phrases105: VocalTrackScanResult['phrases105'] = []
	const phrases106: VocalTrackScanResult['phrases106'] = []
	const notes: VocalNote[] = []
	const starPower: VocalTrackScanResult['starPower'] = []
	const rangeShifts: VocalTrackScanResult['rangeShifts'] = []
	const lyricShifts: VocalTrackScanResult['lyricShifts'] = []
	const unrecognizedMidiEvents: T[] = []

	const seenLyrics = new Set<string>()
	// The start ticks of the open notes of each note number and channel, latest last.
	const openNotes = new Map<number, number[]>()

	for (let i = 0; i < trackEvents.length; i++) {
		const event = trackEvents[i]

		// --- Note events ---
		if (event.type === 'noteOn' || event.type === 'noteOff') {
			const n = event.noteNumber
			if (n === undefined) continue
			const vocalType = noteNumberToVocalType(n)
			const isRelevantNote = n === 0 || n === 1 || n === 105 || n === 106 || n === 116 || vocalType !== null
			if (!isRelevantNote) {
				unrecognizedMidiEvents.push(event)
				continue
			}

			const isOff = event.type === 'noteOff' || (event.type === 'noteOn' && event.velocity === 0)
			const key = n * 16 + (event.channel ?? 0)
			let open = openNotes.get(key)
			if (!isOff) {
				if (open === undefined) openNotes.set(key, open = [])
				open.push(event.deltaTime)
			} else {
				const startTick = open?.pop()
				if (startTick === undefined) continue
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

		// Structural events — writers re-emit them independently.
		if (event.type === 'trackName' || event.type === 'endOfTrack') continue

		// YARG's "first event is the track name" skip: also covers stray tick-0
		// text duplicates of the track name that YARG silently drops.
		if (i === 0) continue

		// --- Text-like events (lyrics + textEvents) ---
		const text = vocalTrackEventText(event)
		if (text === undefined) {
			unrecognizedMidiEvents.push(event)
			continue
		}

		// Events consumed elsewhere — drop from all buckets (not unrecognized).
		if (text === 'ENHANCED_OPENS' || text === '[ENHANCED_OPENS]') continue
		if (text === 'ENABLE_CHART_DYNAMICS' || text === '[ENABLE_CHART_DYNAMICS]') continue
		if (discoFlipRegex.test(text)) continue

		const trimmed = text.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '')
		const isBracketed = trimmed.startsWith('[') && trimmed.endsWith(']')
		// YARG reads `[range_shift]` and `[range_shift <seconds>]` as range shifts, and no reader as a lyric.
		if (isBracketed && trimmed.startsWith('[range_shift')) {
			textEvents.push({ tick: event.deltaTime, text })
			continue
		}

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

	const byTick = (a: { tick: number }, b: { tick: number }) => a.tick - b.tick
	for (const bucket of [phrases105, phrases106, starPower, rangeShifts, lyricShifts]) bucket.sort(byTick)

	return {
		lyrics, textEvents, phrases105, phrases106, notes: trimOverlappingNotes(notes).sort(byTick), starPower, rangeShifts, lyricShifts,
		unrecognizedMidiEvents,
	}
}

/**
 * Trims overlapping vocal notes of one pitch as overlapping sustains are trimmed (`docs/mid/vocals.mdx`, "Overlapping
 * notes of one part"): of two notes at one tick, the longer is kept, and otherwise the earlier note ends where the
 * later starts, and the later runs to whichever end is later. Returns the notes kept, in their order.
 */
function trimOverlappingNotes(notes: VocalNote[]): VocalNote[] {
	const removed = new Set<VocalNote>()
	const byPitch = new Map<number, VocalNote[]>()
	for (const note of notes) {
		const ofPitch = byPitch.get(note.pitch)
		if (ofPitch === undefined) byPitch.set(note.pitch, [note])
		else ofPitch.push(note)
	}
	for (const ofPitch of byPitch.values()) {
		if (ofPitch.length < 2) continue
		ofPitch.sort((a, b) => a.tick - b.tick || a.length - b.length)
		// The longest note of each tick, in tick order.
		const kept = ofPitch.filter((note, index) => {
			const isShorter = ofPitch[index + 1]?.tick === note.tick
			if (isShorter) removed.add(note)
			return !isShorter
		})
		for (let index = 1; index < kept.length; index++) {
			const [earlier, later] = [kept[index - 1], kept[index]]
			if (earlier.tick + earlier.length <= later.tick) continue
			later.length = Math.max(later.tick + later.length, earlier.tick + earlier.length) - later.tick
			earlier.length = later.tick - earlier.tick
		}
	}
	return removed.size === 0 ? notes : notes.filter(note => !removed.has(note))
}

// ---------------------------------------------------------------------------
// Lyric symbol parsing (for normalization)
// ---------------------------------------------------------------------------

import { lyricFlags } from './types'

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
 * Whether a lyric has a `-` or `+` that isn't at its end: outside the run of symbols that ends it, and outside a
 * formatting tag such as `<voffset=-1>`. Clone Hero joins the next syllable to a lyric with a `-` anywhere in it, and
 * a lyric that starts with `+` to the one before it; YARG and scan-chart take the symbols' meaning only from the end
 * (`docs/mid/vocals.mdx`, "A - or + that isn't at the end of a lyric").
 */
export function hasMisplacedJoinSymbol(text: string): boolean {
	let trailEnd = text.length
	while (trailEnd > 0 && trailingSymbolFlags[text[trailEnd - 1]] !== undefined) trailEnd--
	let insideTag = false
	for (let i = 0; i < trailEnd; i++) {
		const ch = text[i]
		if (ch === '<') insideTag = true
		else if (ch === '>') insideTag = false
		else if (!insideTag && (ch === '-' || ch === '+')) return true
	}
	return false
}

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
