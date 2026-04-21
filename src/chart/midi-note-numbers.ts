/**
 * MIDI note-number encoding constants — shared between the parser and the
 * writer.
 *
 * Instrument tracks in .mid files encode difficulty-specific note lanes at
 * fixed MIDI note ranges:
 *
 *   - Drums: base = 60/72/84/96 (easy/medium/hard/expert), lanes 0..4 offset
 *     from the base.
 *   - 5-fret: base = 59/71/83/95, lanes 0..7 offset (0 = ENHANCED_OPENS open,
 *     1..5 = green..orange, 6 = forceHopo, 7 = forceStrum).
 *   - 6-fret (GHL): base = 58/70/82/94, lanes 0..8 (0 = open, 1..3 = white,
 *     4..6 = black, 7 = forceHopo, 8 = forceStrum).
 *
 * The parser and writer agree on these offsets by convention — exposing them
 * as named constants keeps both sides using the same source of truth instead
 * of repeating the raw numbers.
 */

import type { Difficulty } from '../interfaces'

export const drumsDiffStarts: Record<Difficulty, number> = {
	easy: 60,
	medium: 72,
	hard: 84,
	expert: 96,
}

/**
 * Lane offsets from `drumsDiffStarts[difficulty]`. 2x-kick sits at -1 (the
 * only lane below the base).
 */
export const drumLaneOffsets = {
	kick2x: -1,
	kick: 0,
	red: 1,
	yellow: 2,
	blue: 3,
	fiveOrangeFourGreen: 4,
	fiveGreen: 5,
} as const
