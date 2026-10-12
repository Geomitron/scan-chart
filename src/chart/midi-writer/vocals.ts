/**
 * PART VOCALS / HARM1-3 emission for the `.mid` writer.
 */
import type { MidiEvent } from '@geomitron/midi-file'

import type { VocalPart, VocalTrack } from '../types'
import { addNoteOnOff, finalizeMidiTrack, lyricsEvent, metaTextEvent, noteOffEvent, noteOnEvent, trackNameEvent } from './shared'
import type { AbsoluteEvent } from './shared'


// ---------------------------------------------------------------------------
// Vocal tracks (PART VOCALS / HARM1 / HARM2 / HARM3)
// ---------------------------------------------------------------------------

/**
 * Build a PART VOCALS / HARM1-3 MIDI track from normalized vocal data.
 *
 * scan-chart separates note 105 (scoring phrases → `notePhrases`) from note 106
 * (static lyric phrases → `staticLyricPhrases`) at parse time. YARG's
 * CopyDownPhrases copies HARM1's `notePhrases` onto HARM2/HARM3 at parse
 * time — to avoid re-emitting those copies and double-counting on re-parse:
 *
 *   - PART VOCALS emits `notePhrases` at note 105 / 106 (player field decides)
 *   - HARM1 emits `notePhrases` as note 105, `staticLyricPhrases` as note 106
 *   - HARM2 emits only `staticLyricPhrases` as note 106 (note 105 comes from
 *     HARM1 via CopyDown on re-parse)
 *   - HARM3 emits no phrase markers at all
 *
 * Lyric and note events are union'd across both phrase sets (note 105 and
 * 106 can have different boundaries, so a lyric/note may appear in only one
 * set but still needs to be emitted).
 *
 * Zero-length vocal notes are preserved via per-event `seq` tags so
 * `finalizeMidiTrack` keeps noteOn immediately before its matching noteOff.
 *
 * Range shifts (note 0) and lyric shifts (note 1) are per-part for lossless
 * round-trip — PART VOCALS and HARM1 often have distinct marker sets.
 */
export function buildVocalPartTrack(
	partName: string,
	part: VocalPart,
	vocalTracks: VocalTrack,
	trackName: string,
): MidiEvent[] {
	const events: AbsoluteEvent[] = []

	events.push({
		tick: 0,
		event: trackNameEvent(trackName),
	})

	const isHarm3 = partName === 'harmony3'
	const isHarm2 = partName === 'harmony2'
	const isPartVocals = partName === 'vocals'

	// Phrase markers.
	if (isHarm3) {
		// no-op: all phrases come from CopyDown on re-parse.
	} else if (isHarm2) {
		for (const phrase of part.staticLyricPhrases) {
			addNoteOnOff(events, phrase.tick, Math.max(phrase.length, 1), 106, 100)
		}
	} else if (isPartVocals) {
		for (const phrase of part.notePhrases) {
			const noteNumber = phrase.player === 2 ? 106 : 105
			addNoteOnOff(events, phrase.tick, Math.max(phrase.length, 1), noteNumber, 100)
		}
	} else {
		// harmony1
		for (const phrase of part.notePhrases) {
			addNoteOnOff(events, phrase.tick, Math.max(phrase.length, 1), 105, 100)
		}
		for (const phrase of part.staticLyricPhrases) {
			addNoteOnOff(events, phrase.tick, Math.max(phrase.length, 1), 106, 100)
		}
	}

	// Union lyrics across notePhrases + staticLyricPhrases (different phrase
	// boundaries can place the same lyric in only one set — emitting the union
	// preserves all lyrics on the track).
	const seenLyricKeys = new Set<string>()
	const allLyrics: { tick: number; text: string }[] = []
	for (const phrases of [part.notePhrases, part.staticLyricPhrases]) {
		for (const phrase of phrases) {
			for (const lyric of phrase.lyrics) {
				const key = `${lyric.tick}:${lyric.text}`
				if (!seenLyricKeys.has(key)) {
					seenLyricKeys.add(key)
					allLyrics.push(lyric)
				}
			}
		}
	}
	allLyrics.sort((a, b) => a.tick - b.tick)
	for (const lyric of allLyrics) {
		events.push({
			tick: lyric.tick,
			event: lyricsEvent(lyric.text),
		})
	}

	// Union notes across the same two phrase sets.
	const seenNoteKeys = new Set<string>()
	const allNotes: { tick: number; length: number; pitch: number; type: 'pitched' | 'percussion' }[] = []
	for (const phrases of [part.notePhrases, part.staticLyricPhrases]) {
		for (const phrase of phrases) {
			for (const note of phrase.notes) {
				const key = `${note.tick}:${note.pitch}:${note.length}`
				if (!seenNoteKeys.has(key)) {
					seenNoteKeys.add(key)
					allNotes.push(note)
				}
			}
		}
	}
	allNotes.sort((a, b) => a.tick - b.tick)

	let vocalNoteSeq = 1_000_000
	for (const note of allNotes) {
		const midiPitch = note.type === 'pitched'
			? (note.pitch >= 36 && note.pitch <= 84 ? note.pitch : 60)
			: 96
		events.push({
			tick: note.tick,
			seq: vocalNoteSeq++,
			event: noteOnEvent(midiPitch, 100),
		})
		events.push({
			tick: note.tick + note.length,
			seq: vocalNoteSeq++,
			event: noteOffEvent(midiPitch),
		})
	}

	// Star power sections → note 116. HARM2/HARM3 starPowerSections are also
	// copied from HARM1 by CopyDown on re-parse, so only HARM1 / PART VOCALS
	// need to emit them.
	if (!isHarm2 && !isHarm3) {
		for (const sp of part.starPowerSections) {
			addNoteOnOff(events, sp.tick, Math.max(sp.length, 1), 116, 100)
		}
	}

	// Vocal-track text events (stance markers, Band_PlayFacialAnim, etc.).
	// YARG marks a VocalsPart non-empty iff it has phrases or text events, so
	// emitting these is required for round-tripping stance-only tracks.
	for (const te of part.textEvents) {
		events.push({
			tick: te.tick,
			event: metaTextEvent(te.text),
		})
	}

	// Per-part range shifts (note 0) and lyric shifts (note 1). Fall back to
	// the track-level arrays only if the per-part arrays are empty and this
	// part owns the track-level data (PART VOCALS, or HARM1 when PART VOCALS
	// is absent). YARG's GetRangeShifts reads these markers per-track.
	const partOwnsTrackLevel =
		partName === 'vocals' || (partName === 'harmony1' && !vocalTracks.parts.vocals)

	if (part.rangeShifts.length > 0) {
		for (const rs of part.rangeShifts) {
			addNoteOnOff(events, rs.tick, Math.max(rs.length, 1), 0, 100)
		}
	} else if (partOwnsTrackLevel) {
		for (const rs of vocalTracks.rangeShifts) {
			addNoteOnOff(events, rs.tick, Math.max(rs.length, 1), 0, 100)
		}
	}

	if (part.lyricShifts.length > 0) {
		for (const ls of part.lyricShifts) {
			addNoteOnOff(events, ls.tick, Math.max(ls.length, 1), 1, 100)
		}
	} else if (partOwnsTrackLevel) {
		for (const ls of vocalTracks.lyricShifts) {
			addNoteOnOff(events, ls.tick, Math.max(ls.length, 1), 1, 100)
		}
	}

	return finalizeMidiTrack(events)
}
