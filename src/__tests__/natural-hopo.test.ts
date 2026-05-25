/**
 * Tests for the parser's natural-HOPO resolution in `resolveFretModifiers`.
 *
 * The natural-HOPO rules (see `src/chart/natural-hopo.ts`):
 *
 *   1. No previous group → not a natural HOPO.
 *   2. Gap from previous group > threshold → strum.
 *   3. Current is a chord → strum.
 *   4. Previous is a single note and current is the same single note → strum.
 *   5. `.mid` only: previous is a chord and current is a subset of it → strum.
 *   6. Otherwise → natural HOPO.
 *
 * The parser does its own inline check (different variable shape than the
 * NoteEvent-based wrapper). The cases below cover the duplicate-same-fret
 * variants that show up routinely in `.chart` text (e.g. `2304 = N 1 0`
 * listed twice): a duplicate-single resolves like its deduped form for both
 * the "is this a chord?" and "is this the same fret as the previous group?"
 * checks, so it doesn't masquerade as a real chord and rule 4 still fires
 * when both sides are the same fret regardless of duplicates on either side.
 */

import { describe, expect, it } from 'vitest'

import { parseChartFile } from '../chart/parse-chart-file'
import { defaultIniChartModifiers, noteFlags, noteTypes } from '../chart/types'

/**
 * Parse a `[ExpertGHLGuitar]` track body and return the resolved note groups
 * for the single track in it. The chart fixture uses GHL because the original
 * regression was found there (`Edge Case Test (chart)` in the ChartTests
 * corpus), but the parser's natural-HOPO logic is fret-instrument-agnostic, so
 * this exercises the same code path used by 5-fret instruments.
 */
function parseGhlTrack(trackBody: string) {
	const body = [
		'[Song]', '{', '  Resolution = 192', '}',
		'[SyncTrack]', '{', '  0 = B 120000', '}',
		'[Events]', '{', '}',
		'[ExpertGHLGuitar]', '{',
		trackBody,
		'}',
	].join('\r\n')
	const result = parseChartFile(new TextEncoder().encode(body), 'chart', defaultIniChartModifiers)
	expect(result.trackData.length).toBe(1)
	return result.trackData[0].noteEventGroups
}

describe('parser natural-HOPO: previous-chord guard for duplicate same-fret events', () => {
	it('resolves to HOPO when current is a single fret different from a preceding chord', () => {
		// Sanity baseline: no duplicate, just chord → single-fret follow-up. The
		// natural-HOPO rules say "previous chord, current single different fret"
		// is a natural HOPO (rules 4 and 5 don't apply: current isn't the same
		// single fret because previous isn't a single fret, and we're in .chart
		// format so the .mid-only subset rule doesn't apply).
		const groups = parseGhlTrack([
			'  0 = N 0 0', // white1 \
			'  0 = N 1 0', // white2  } chord at tick 0
			'  48 = N 2 0', // white3 — single note within HOPO threshold
		].join('\r\n'))

		expect(groups.length).toBe(2)
		expect(groups[1].length).toBe(1)
		expect(groups[1][0].type).toBe(noteTypes.white3)
		expect(groups[1][0].flags).toBe(noteFlags.hopo)
	})

	it('still resolves to HOPO when the current single fret is duplicated and is contained in the previous chord', () => {
		// Regression case: previous group is the chord [white1, white2], current
		// group at tick 48 is the SAME fret listed twice (`N 1 0` x2). After
		// dedup the current is a single white2. White2 is contained in the
		// previous chord, so a buggy `isSameFretNote` (set membership only)
		// would falsely fire rule 4 and pick strum. The correct answer is
		// natural HOPO because the previous group is a chord, not a single note.
		const groups = parseGhlTrack([
			'  0 = N 0 0', // white1 \
			'  0 = N 1 0', // white2  } chord at tick 0
			'  48 = N 1 0', // white2 — duplicated below
			'  48 = N 1 0', // duplicate white2 (real-world charts occasionally emit these)
		].join('\r\n'))

		expect(groups.length).toBe(2)
		// The duplicated event collapses to one note in the resolved group.
		expect(groups[1].length).toBe(1)
		expect(groups[1][0].type).toBe(noteTypes.white2)
		expect(groups[1][0].flags).toBe(noteFlags.hopo)
	})

	it('still resolves to strum when previous is a single note of the same fret (rule 4 fires correctly)', () => {
		// Rule 4 baseline: previous and current are both single white2 → strum.
		// Confirms the guard added in the regression case above didn't break
		// the legitimate same-single-note case.
		const groups = parseGhlTrack([
			'  0 = N 1 0', // white2 (single)
			'  48 = N 1 0', // white2 (single, same fret)
		].join('\r\n'))

		expect(groups.length).toBe(2)
		expect(groups[1].length).toBe(1)
		expect(groups[1][0].type).toBe(noteTypes.white2)
		expect(groups[1][0].flags).toBe(noteFlags.strum)
	})

	it('resolves to strum when the previous group is a duplicate single fret and current is the same single fret', () => {
		// Real-world: charters and editors (EOF, Moonscraper) regularly emit
		// duplicate `N <fret> <length>` lines for the same gameplay note. After
		// dedup, [white2, white2] is a single white2 — and the next single
		// white2 is "the same single note as previous" → rule 4 → strum. The
		// previous array-length-based `isSameFretNote` missed this.
		const groups = parseGhlTrack([
			'  0 = N 1 0', // white2 \
			'  0 = N 1 0', //         } same gameplay note (duplicate emit)
			'  48 = N 1 0', // white2 (single, same fret as deduped previous)
		].join('\r\n'))

		expect(groups.length).toBe(2)
		// Duplicates collapse to a single note in the resolved group.
		expect(groups[0].length).toBe(1)
		expect(groups[1].length).toBe(1)
		expect(groups[1][0].type).toBe(noteTypes.white2)
		expect(groups[1][0].flags).toBe(noteFlags.strum)
	})

	it('resolves to strum when the current group is a duplicate single fret matching a previous single', () => {
		// Mirror of the above: previous is a single white2, current is the same
		// fret duplicated. After dedup current is also a single white2 → rule 4
		// → strum.
		const groups = parseGhlTrack([
			'  0 = N 1 0', // white2 (single)
			'  48 = N 1 0', // white2 \
			'  48 = N 1 0', //         } duplicate single, same fret as previous
		].join('\r\n'))

		expect(groups.length).toBe(2)
		expect(groups[1].length).toBe(1)
		expect(groups[1][0].type).toBe(noteTypes.white2)
		expect(groups[1][0].flags).toBe(noteFlags.strum)
	})
})
