import { difference, maxOf, minOf, removeWhere, roundTo, uniq } from '../shared/lodash-equivalents'

import { ChartIssueType, Difficulty, DrumType, getInstrumentType, Instrument, instrumentTypes } from '../types'
import type { CanonicalParsedChart } from './identity/canonical-source'
import { computeHopoThresholdTicks, isNaturalHopo } from './natural-hopo'
import type { ParsedChartFile } from './parse-chart-file'
import { pruneEmptyPhrases } from './track-hasher'
import { IniChartModifiers, NoteEvent, noteFlags, NoteType, noteTypes } from './types'

const LEADING_SILENCE_THRESHOLD_MS = 1000
const MIN_SUSTAIN_GAP_MS = 40
const MIN_SUSTAIN_MS = 100
// The Chorus Encore Application Guidelines' recommendations, reported at the `recommendation` severity: the first note
// at least 2 seconds in (or two measures of the starting tempo), sustain gaps of at least 60 ms, and sustains of at least
// 200 ms.
const RECOMMENDED_LEADING_SILENCE_MS = 2000
const RECOMMENDED_SUSTAIN_GAP_MS = 60
const RECOMMENDED_SUSTAIN_MS = 200
const NPS_GROUP_SIZE_MS = 1000

/** Statistics about a chart's gameplay. */
export interface ChartStats {
	/** The instruments that have a track. */
	readonly instruments: readonly Instrument[]
	/** The type of drums that are charted. `null` if drums are not charted. */
	readonly drumType: DrumType | null
	/** If a solo occurs in any track. */
	readonly hasSolos: boolean
	/** If the chart contains any lyric events. */
	readonly hasLyrics: boolean
	/** If the chart has a vocal part with a vocal note. */
	readonly hasVocals: boolean
	/** If a note in any track is forced to the other of HOPO or strum than it would naturally be. */
	readonly hasForcedNotes: boolean
	/** If a tap note occurs in any track. */
	readonly hasTapNotes: boolean
	/** If an open note occurs in any track. */
	readonly hasOpenNotes: boolean
	/** If a 2x kick note occurs in any drums track. */
	readonly has2xKick: boolean
	/** If a roll or trill lane occurs in any track. */
	readonly hasFlexLanes: boolean
	/** The number of notes in each track: drum notes counted one by one, fret note groups as one each. */
	readonly noteCounts: readonly { readonly instrument: Instrument; readonly difficulty: Difficulty; readonly count: number }[]
	/** The one-second window in each track where the notes per second are highest. */
	readonly maxNps: readonly {
		readonly instrument: Instrument
		readonly difficulty: Difficulty
		/** The time of the window's first note, in milliseconds, rounded to 3 decimal places. */
		readonly msTime: number
		readonly nps: number
	}[]
	/**
	 * The time between the first and the last note start across every track, in milliseconds, rounded to 3 decimal
	 * places. The song.ini `song_length` when the chart has no notes.
	 */
	readonly noteSpanMs: number
	/** The number of tempo markers. */
	readonly tempoMarkerCount: number
}

/** A chart issue as found: what and where. `tick` and `msTime` are `null` for an issue about a whole track or chart. */
export interface ChartIssueFinding {
	readonly code: ChartIssueType
	readonly instrument: Instrument | null
	readonly difficulty: Difficulty | null
	readonly tick: number | null
	readonly msTime: number | null
	/** Set for a check's recommendation-level finding, which has its own message in `chartRecommendationMessages`. */
	readonly recommendation?: true
}

/** The messages of the findings that only miss a charting recommendation. */
export const chartRecommendationMessages = {
	smallLeadingSilence: 'This track has a note less than 2 seconds, or two measures, after the start of the song. The first note should be at least that far in: add silence to the start of the audio.',
	badSustainGap: 'This note starts less than 60 ms after the previous sustain ends. A gap of 70 to 85 ms is recommended.',
	babySustain: 'The sustain on this note is shorter than 200 ms. A sustain should be at least 200 ms long.',
} as const satisfies { readonly [code in ChartIssueType]?: string }

export const chartIssueMessages: { readonly [issue in ChartIssueType]: string } = {
	misalignedTimeSignature:
		"This chart has a time signature marker that doesn't appear at the start of a measure. This can't be interpreted correctly in Clone Hero.",
	noNotes: 'This chart has no notes.',
	noExpert: 'This instrument has Easy, Medium, or Hard charted but not Expert.',
	difficultyNotReduced: 'The notes of this difficulty are identical to the notes of the expert chart.',
	isDefaultBPM:
		'This chart has only one 120 BPM marker and only one 4/4 time signature. This usually means the chart ' +
		"wasn't tempo-mapped, but you can ignore this if the song is a constant 120 BPM.",
	noSections: 'This chart has no sections.',
	badEndEvent: 'This end event is in an invalid location and will be ignored by most games.',
	smallLeadingSilence: 'This track has a note that is less than 1000ms after the start of the track.',
	noStarPower: 'This track has no star power.',
	emptyStarPower: 'This star power phrase contains no notes.',
	badStarPower: 'This star power is being ignored due to the .ini "multiplier_note" setting.',
	emptySoloSection: 'This solo section contains no notes.',
	noDrumActivationLanes: 'This drums track has no activation lanes.',
	emptyFlexLane: 'This flex lane contains no notes.',
	difficultyForbiddenNote: "This is a note that isn't allowed on the track's difficulty.",
	invalidChord: 'The use of this type of chord is strongly discouraged.',
	brokenNote: 'This note is so close to the previous note that this was likely a charting mistake.',
	badSustainGap: 'This note is not far enough ahead of the previous sustain.',
	babySustain: 'The sustain on this note is too short.',
	invalidLyric: 'This lyric is on the EVENTS track instead of PART VOCALS and will not be displayed.',
	invalidPhraseStart: 'This phrase_start is on the EVENTS track. Vocal phrase boundaries in .mid charts must be MIDI note 105 (player 1) or 106 (player 2) on PART VOCALS.',
	invalidPhraseEnd: 'This phrase_end is on the EVENTS track. Vocal phrase boundaries in .mid charts must be MIDI note 105 (player 1) or 106 (player 2) on PART VOCALS.',
}

/** The statistics of a chart parsed with `settings` from a file of `format`. */
export function chartStats(chartData: ParsedChartFile, settings: IniChartModifiers, format: 'chart' | 'mid'): ChartStats {
	// Walk every note group once to derive all state-dependent flags.
	// `hasForcedNotes` mirrors the old source-derived semantics: true iff the
	// chart contains a note whose resolved `hopo`/`strum` flag disagrees with
	// the natural HOPO state the parser would have picked without force events.
	// Notes that carry ONLY the `tap` flag are intentionally NOT counted —
	// matching the pre-consolidation definition that walked raw trackEvents for
	// `forceHopo` / `forceStrum` / `forceUnnatural` (tap was excluded even
	// though `forceTap` is a force event, per the original definition). That
	// decision keeps 78K-chart parity with the old flag for 94%+ of charts; the
	// remaining divergence is ~300 charts where the source had redundantly-
	// applied force events on naturally-matching notes (the force was a no-op,
	// so the state-derived flag correctly reports false).
	const hopoThreshold = computeHopoThresholdTicks(chartData.resolution, settings.hopo_frequency, settings.eighthnote_hopo, format)
	let [hasTapNotes, hasOpenNotes, has2xKick, hasForcedNotes] = [false, false, false, false]
	outer: for (const track of chartData.trackData) {
		const isFretInstrument = track.instrument !== 'drums'
		let lastGroup: NoteEvent[] | null = null
		for (const noteGroup of track.noteEventGroups) {
			for (const note of noteGroup) {
				if (note.flags & noteFlags.tap) hasTapNotes = true
				if (note.flags & noteFlags.doubleKick) has2xKick = true
				if (note.type === noteTypes.open) hasOpenNotes = true
			}
			if (isFretInstrument && !hasForcedNotes && noteGroup.length > 0) {
				const first = noteGroup[0]
				const natural = isNaturalHopo(noteGroup, lastGroup, hopoThreshold, format)
				const isHopo = (first.flags & noteFlags.hopo) !== 0
				const isStrum = (first.flags & noteFlags.strum) !== 0
				if ((isHopo && !natural) || (isStrum && natural)) hasForcedNotes = true
			}
			lastGroup = noteGroup.length > 0 ? noteGroup : lastGroup
			// Early-exit once all four flags are true.
			if (hasTapNotes && hasOpenNotes && has2xKick && hasForcedNotes) break outer
		}
	}

	// `hasVocals` means "there is a singable vocals part", so it requires a
	// vocal note inside a phrase. A phrase on its own is only a range marker: a
	// lyrics-only chart carries its lyrics inside phrases that hold no notes,
	// and that is a chart with lyrics, not a chart with vocals. The .chart
	// format cannot encode a vocal note at all, so `hasVocals` is always
	// false there.
	//
	// `phrase.notes` is the playable projection, not every note in the source:
	// the parser drops hidden percussion and notes that fall outside their
	// phrase range. A vocals chart built only from such notes reports false.
	let hasLyrics = false
	let hasVocals = false
	vocals: for (const part of Object.values(chartData.vocalTracks.parts)) {
		for (const phrase of part.notePhrases) {
			if (phrase.notes.length > 0) hasVocals = true
			if (phrase.lyrics.length > 0) hasLyrics = true
			if (hasLyrics && hasVocals) break vocals
		}
	}

	const first = minOf(chartData.trackData.map(track => track.noteEventGroups[0]?.[0]?.msTime))
	const last = maxOf(chartData.trackData.map(track => track.noteEventGroups[track.noteEventGroups.length - 1]?.[0]?.msTime))
	return {
		instruments: uniq(chartData.trackData.map(t => t.instrument)),
		drumType: chartData.drumType,
		hasSolos: (maxOf(chartData.trackData.map(t => t.soloSections.length)) ?? 0) > 0,
		hasLyrics,
		hasVocals,
		hasForcedNotes,
		hasTapNotes,
		hasOpenNotes,
		has2xKick,
		hasFlexLanes: (maxOf(chartData.trackData.map(t => t.flexLanes.length)) ?? 0) > 0,
		noteCounts: chartData.trackData.map(t => ({
			instrument: t.instrument,
			difficulty: t.difficulty,
			count: t.instrument === 'drums' ? t.noteEventGroups.reduce((count, group) => count + group.length, 0) : t.noteEventGroups.length,
		})),
		maxNps: chartData.trackData.map(t => ({ instrument: t.instrument, difficulty: t.difficulty, ...findMaxNps(t.noteEventGroups) })),
		noteSpanMs: first !== undefined && last !== undefined ? roundTo('round', last - first, 3) : settings.song_length,
		tempoMarkerCount: chartData.tempos.length,
	}
}

function findMaxNps(notes: NoteEvent[][]) {
	if (notes.length === 0) {
		return { nps: 0, msTime: 0 }
	}
	let notesInWindow = 0
	let maxNotesInWindow = 0
	let windowStartIndex = 0
	let maxWindowStartIndex = 0

	for (const noteGroup of notes) {
		notesInWindow++
		const windowStartTime = noteGroup[0].msTime - NPS_GROUP_SIZE_MS
		while (notes[windowStartIndex][0].msTime < windowStartTime) {
			windowStartIndex++
			notesInWindow--
		}
		if (notesInWindow > maxNotesInWindow) {
			maxNotesInWindow = notesInWindow
			maxWindowStartIndex = windowStartIndex
		}
	}

	return { nps: (1000 * maxNotesInWindow) / NPS_GROUP_SIZE_MS, msTime: roundTo('round', notes[maxWindowStartIndex][0].msTime, 3) }
}

/**
 * Whether a track's notes and phrases are the same as its instrument's Expert track's, as the canonical rules read
 * them: when they are, their TrackHashes are equal, since a song's tracks share its tempo map. Always `false` when
 * the canonical rules reject the chart.
 */
export function sameAsExpert(canonicalChart: CanonicalParsedChart | null): (instrument: Instrument, difficulty: Difficulty) => boolean {
	const semantics = (instrument: Instrument, difficulty: Difficulty) => {
		const track = canonicalChart?.tracks.find(t => t.key.instrument === instrument && t.key.difficulty === difficulty)
		if (track === undefined) return undefined
		const { resolution, notes, starPower, solos, flexLanes, drumFreestyle, rangeShifts } = track.semantics
		return { resolution, notes, starPower, solos, flexLanes, drumFreestyle, rangeShifts }
	}
	return (instrument, difficulty) => {
		const expert = semantics(instrument, 'expert')
		const other = semantics(instrument, difficulty)
		return expert !== undefined && other !== undefined && sameAsJson(expert, other)
	}
}

/**
 * Whether two values serialize to the same JSON, with BigInts as their digits, without serializing them: it stops at
 * the first difference, where serializing every note of two tracks took a sixth of a scan.
 */
export function sameAsJson(a: unknown, b: unknown): boolean {
	const [x, y] = [jsonValue(a), jsonValue(b)]
	if (x === y) return true
	if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) return false
	if (Array.isArray(x) !== Array.isArray(y)) return false
	if (Array.isArray(x) && Array.isArray(y)) {
		if (x.length !== y.length) return false
		for (let index = 0; index < x.length; index++) if (!sameAsJson(jsonElement(x[index]), jsonElement(y[index]))) return false
		return true
	}
	const [xEntries, yEntries] = [jsonEntries(x), jsonEntries(y)]
	if (xEntries.length !== yEntries.length) return false
	for (let index = 0; index < xEntries.length; index++) {
		if (xEntries[index][0] !== yEntries[index][0] || !sameAsJson(xEntries[index][1], yEntries[index][1])) return false
	}
	return true
}

/** JSON writes a number that isn't finite as null, and here a BigInt as its digits. */
function jsonValue(value: unknown) {
	return typeof value === 'number' && !Number.isFinite(value) ? null : typeof value === 'bigint' ? value.toString() : value
}

/** In an array, JSON writes an undefined element or a function as null. */
function jsonElement(element: unknown) {
	return element === undefined || typeof element === 'function' ? null : element
}

/** JSON leaves out a property that's undefined or a function. */
function jsonEntries(object: object) {
	return Object.entries(object).filter(([, value]) => value !== undefined && typeof value !== 'function')
}

/**
 * The chart issues of a parsed chart, in order: the parser's own, then the chart-wide ones, then each track's.
 * `isSameAsExpert` decides `difficultyNotReduced`. With `recommendations`, a check with a charting recommendation also
 * reports what misses it but passes the check's own threshold, as a finding marked `recommendation`.
 */
export function findChartIssues(
	chartData: ParsedChartFile,
	isSameAsExpert: (instrument: Instrument, difficulty: Difficulty) => boolean,
	{ recommendations = false }: { readonly recommendations?: boolean } = {},
): ChartIssueFinding[] {
	const chartIssues: ChartIssueFinding[] = []
	const addIssue = (instrument: Instrument | null, difficulty: Difficulty | null, code: ChartIssueType, at?: { tick: number; msTime: number }) =>
		chartIssues.push({ code, instrument, difficulty, tick: at?.tick ?? null, msTime: at?.msTime ?? null })

	// Parser-emitted issues (dedup, malformed events, etc.) run first so their
	// descriptions appear at the top of the issue list for consumers.
	for (const issue of chartData.parseIssues) {
		addIssue(issue.instrument, issue.difficulty, issue.noteIssue)
	}

	// misalignedTimeSignature
	{
		const timeSignatures = [...chartData.timeSignatures]
		let lastBeatlineTick = 0
		for (let i = 0; i < timeSignatures.length; i++) {
			if (lastBeatlineTick !== timeSignatures[i].tick) {
				addIssue(null, null, 'misalignedTimeSignature', timeSignatures[i])
				timeSignatures.splice(i, 1) // Treat misaligned time signature like it was removed to discover future misaligned time signatures
				i--
			}
			while (timeSignatures[i + 1] && lastBeatlineTick < timeSignatures[i + 1].tick) {
				lastBeatlineTick += chartData.resolution * 4 * (timeSignatures[i].numerator / timeSignatures[i].denominator)
			}
		}
	}

	// noNotes
	{
		// Deliberately broader than `hasVocals`: any vocal phrase is enough
		// content to keep a chart out of `noNotes`, even a lyrics-only phrase
		// that carries no vocal note.
		const hasVocalContent = Object.values(chartData.vocalTracks.parts).some(p => p.notePhrases.length > 0)
		if (chartData.trackData.every(track => track.noteEventGroups.length === 0) && !hasVocalContent) {
			addIssue(null, null, 'noNotes')
		}
	}

	// noExpert, difficultyNotReduced
	{
		const instrumentGroups = new Map<string, typeof chartData.trackData>()
		for (const track of chartData.trackData) instrumentGroups.set(track.instrument, [...(instrumentGroups.get(track.instrument) ?? []), track])
		for (const instrumentGroup of instrumentGroups.values()) {
			if (instrumentGroup.every(track => track.difficulty !== 'expert')) {
				addIssue(instrumentGroup[0].instrument, null, 'noExpert')
			} else {
				for (const track of instrumentGroup.filter(t => t.difficulty !== 'expert')) {
					if (track.noteEventGroups.length > 20 && isSameAsExpert(track.instrument, track.difficulty)) {
						addIssue(track.instrument, track.difficulty, 'difficultyNotReduced')
					}
				}
			}
		}
	}

	// isDefaultBPM
	{
		const isDefaultTempo = chartData.tempos.length === 1 && roundTo('round', chartData.tempos[0].beatsPerMinute, 12) === 120
		const isDefaultTimeSignature =
			chartData.timeSignatures.length === 1 && chartData.timeSignatures[0].numerator === 4 && chartData.timeSignatures[0].denominator === 4
		if (isDefaultTempo && isDefaultTimeSignature) {
			addIssue(null, null, 'isDefaultBPM')
		}
	}

	// noSections
	{
		if (chartData.sections.length === 0) {
			addIssue(null, null, 'noSections')
		}
	}

	// badEndEvent
	{
		if (chartData.endEvents.length > 1) {
			for (const endEvent of chartData.endEvents.slice(1)) {
				addIssue(null, null, 'badEndEvent', endEvent)
			}
		}
		const lastNoteTick = maxOf(chartData.trackData.map(track => track.noteEventGroups[track.noteEventGroups.length - 1]?.[0]?.tick))
		if (lastNoteTick && chartData.endEvents[0] && chartData.endEvents[0].tick < lastNoteTick) {
			addIssue(null, null, 'badEndEvent', chartData.endEvents[0])
		}
	}

	// The recommended leading silence: 2 seconds, or two measures of the starting tempo when those are shorter.
	const firstTempo = chartData.tempos[0]
	const firstTimeSignature = chartData.timeSignatures[0]
	const twoMeasuresMs = firstTempo && firstTimeSignature
		? 2 * firstTimeSignature.numerator * (4 / firstTimeSignature.denominator) * 60000 / firstTempo.beatsPerMinute
		: RECOMMENDED_LEADING_SILENCE_MS
	const recommendedLeadingSilenceMs = Math.min(RECOMMENDED_LEADING_SILENCE_MS, twoMeasuresMs)

	for (const track of chartData.trackData) {
		const instrumentType = getInstrumentType(track.instrument)
		const addIssue = (code: ChartIssueType, at?: { tick: number; msTime: number }, recommendation?: boolean) =>
			chartIssues.push({
				code,
				instrument: track.instrument,
				difficulty: track.difficulty,
				tick: at?.tick ?? null,
				msTime: at?.msTime ?? null,
				...(recommendation ? { recommendation: true as const } : {}),
			})

		// smallLeadingSilence
		{
			const firstNoteMs = track.noteEventGroups[0]?.[0]?.msTime
			if (firstNoteMs !== undefined && firstNoteMs < LEADING_SILENCE_THRESHOLD_MS) {
				addIssue('smallLeadingSilence')
			} else if (recommendations && firstNoteMs !== undefined && firstNoteMs < recommendedLeadingSilenceMs) {
				addIssue('smallLeadingSilence', undefined, true)
			}
		}

		// noStarPower
		{
			if (
				track.starPowerSections.length === 0 &&
				track.instrument !== 'drums' &&
				track.noteEventGroups.length > 50 &&
				track.noteEventGroups[track.noteEventGroups.length - 1][0].msTime - track.noteEventGroups[0][0].msTime > 60000
			) {
				addIssue('noStarPower')
			}
		}

		// emptyStarPower
		{
			const emptyStarPowerSections = difference(track.starPowerSections, pruneEmptyPhrases(track.starPowerSections, track.noteEventGroups))
			for (const emptyStarPowerSection of emptyStarPowerSections) {
				addIssue('emptyStarPower', emptyStarPowerSection)
			}
		}

		// badStarPower
		{
			for (const rejectedStarPower of track.rejectedStarPowerSections) {
				addIssue('badStarPower', rejectedStarPower)
			}
		}

		// emptySoloSection
		{
			const emptySoloSections = difference(track.soloSections, pruneEmptyPhrases(track.soloSections, track.noteEventGroups))
			for (const emptySoloSection of emptySoloSections) {
				addIssue('emptySoloSection', emptySoloSection)
			}
		}

		// noDrumActivationLanes
		{
			if (
				track.instrument === 'drums' &&
				track.drumFreestyleSections.length === 0 &&
				track.starPowerSections.length > 0 &&
				track.noteEventGroups.length > 50 &&
				track.noteEventGroups[track.noteEventGroups.length - 1][0].msTime - track.noteEventGroups[0][0].msTime > 60000
			) {
				addIssue('noDrumActivationLanes')
			}
		}

		// emptyFlexLane
		{
			const emptyFlexLanes = difference(track.flexLanes, pruneEmptyPhrases(track.flexLanes, track.noteEventGroups))
			for (const emptyFlexLane of emptyFlexLanes) {
				addIssue('emptyFlexLane', emptyFlexLane)
			}
		}

		if (instrumentType === instrumentTypes.drums) {
			const nonKickDrumNoteTypes = [noteTypes.greenDrum, noteTypes.redDrum, noteTypes.yellowDrum, noteTypes.blueDrum]
			const kickDrumNoteTypes = [noteTypes.kick]
			for (const noteGroup of track.noteEventGroups) {
				// difficultyForbiddenNote
				{
					if (track.difficulty !== 'expert') {
						for (const note of noteGroup) {
							if (note.flags & noteFlags.doubleKick) {
								addIssue('difficultyForbiddenNote', noteGroup[0])
							}
						}
					}
					if (track.difficulty === 'easy') {
						if (typeCount(noteGroup, nonKickDrumNoteTypes) === 2 && typeCount(noteGroup, kickDrumNoteTypes) > 0) {
							addIssue('difficultyForbiddenNote', noteGroup[0])
						}
					}
				}

				// invalidChord
				{
					if (typeCount(noteGroup, nonKickDrumNoteTypes) >= 3) {
						addIssue('invalidChord', noteGroup[0])
					}
				}
			}
		} else if (instrumentType === instrumentTypes.fiveFret) {
			const fiveNoteChordTypes = [noteTypes.green, noteTypes.red, noteTypes.yellow, noteTypes.blue, noteTypes.orange]
			const greenBlueChordTypes = [noteTypes.green, noteTypes.blue]
			const greenOrangeChordTypes = [noteTypes.green, noteTypes.orange]
			const orangeType = [noteTypes.orange]
			const orangeBlueTypes = [noteTypes.orange, noteTypes.blue]
			for (const noteGroup of track.noteEventGroups) {
				// difficultyForbiddenNote
				{
					if (track.difficulty === 'hard') {
						if (typeCount(noteGroup, greenOrangeChordTypes) === 2) {
							addIssue('difficultyForbiddenNote', noteGroup[0])
						}
					} else if (track.difficulty === 'medium') {
						if (typeCount(noteGroup, orangeType) > 0) {
							addIssue('difficultyForbiddenNote', noteGroup[0])
						} else if (typeCount(noteGroup, greenBlueChordTypes) === 2) {
							addIssue('difficultyForbiddenNote', noteGroup[0])
						}
					} else if (track.difficulty === 'easy') {
						if (typeCount(noteGroup, orangeBlueTypes) > 0) {
							addIssue('difficultyForbiddenNote', noteGroup[0])
						}
					}
				}

				// invalidChord
				{
					if (typeCount(noteGroup, fiveNoteChordTypes) === 5) {
						addIssue('invalidChord', noteGroup[0])
					}
				}
			}
		} else if (instrumentType === instrumentTypes.sixFret) {
			const blackTypes = [noteTypes.black1, noteTypes.black2, noteTypes.black3]
			const whiteTypes = [noteTypes.white1, noteTypes.white2, noteTypes.white3]
			const white12Type = [noteTypes.white1, noteTypes.white2]
			const white23Type = [noteTypes.white2, noteTypes.white3]
			const oneTypes = [noteTypes.black1, noteTypes.white1]
			const twoTypes = [noteTypes.black2, noteTypes.white2]
			const threeTypes = [noteTypes.black3, noteTypes.white3]
			for (const noteGroup of track.noteEventGroups) {
				// difficultyForbiddenNote
				{
					if (track.difficulty === 'hard') {
						if (noteGroup.length === 3 && (typeCount(noteGroup, blackTypes) < 3 || typeCount(noteGroup, whiteTypes) < 3)) {
							addIssue('difficultyForbiddenNote', noteGroup[0]) // No 3-note chords that mix white/black
						}
					} else if (track.difficulty === 'medium') {
						if (noteGroup.length === 3) {
							addIssue('difficultyForbiddenNote', noteGroup[0])
						} else if (noteGroup.length === 2 && typeCount(noteGroup, blackTypes) > 0 && typeCount(noteGroup, whiteTypes) > 0) {
							if (typeCount(noteGroup, oneTypes) < 2 && typeCount(noteGroup, twoTypes) < 2 && typeCount(noteGroup, threeTypes) < 2) {
								addIssue('difficultyForbiddenNote', noteGroup[0]) // No chords that mix white/black, except barre chords are ok
							}
						}
					} else if (track.difficulty === 'easy') {
						if (noteGroup.length === 3) {
							addIssue('difficultyForbiddenNote', noteGroup[0])
						} else if (noteGroup.length === 2 && !(typeCount(noteGroup, white12Type) === 2 || typeCount(noteGroup, white23Type) === 2)) {
							addIssue('difficultyForbiddenNote', noteGroup[0])
						}
					}
				}

				// invalidChord
				{
					if (noteGroup.length > 3) {
						addIssue('invalidChord', noteGroup[0])
					} else if (typeCount(noteGroup, twoTypes) === 2 && typeCount(noteGroup, oneTypes) > 0) {
						addIssue('invalidChord', noteGroup[0])
					} else if (typeCount(noteGroup, threeTypes) === 2 && typeCount(noteGroup, oneTypes) + typeCount(noteGroup, twoTypes) > 0) {
						addIssue('invalidChord', noteGroup[0])
					}
				}
			}
		}

		// brokenNote
		{
			for (let i = 1; i < track.noteEventGroups.length; i++) {
				const note = track.noteEventGroups[i]
				const previousNote = track.noteEventGroups[i - 1]
				const distance = note[0].msTime - previousNote[0].msTime
				if (distance > 0 && distance <= 15) {
					if (
						(typeCount(note, [noteTypes.open]) > 0 && typeCount(previousNote, [noteTypes.open]) === 0) ||
						(typeCount(note, [noteTypes.open]) === 0 && typeCount(previousNote, [noteTypes.open]) > 0)
					) {
						continue // Skip if non-open is next to an open
					}
					addIssue('brokenNote', track.noteEventGroups[i][0])
				}
			}
		}

		if (instrumentType !== instrumentTypes.drums) {
			// badSustainGap, babySustain
			{
				/** Sustain gaps at the end of notes already checked in the for loop. `startTime` is inclusive, `endTime` is exclusive. */
				const futureSustainGaps: { startTime: number; endTime: number }[] = []
				const sustainGapMs = recommendations ? RECOMMENDED_SUSTAIN_GAP_MS : MIN_SUSTAIN_GAP_MS
				const sustainMs = recommendations ? RECOMMENDED_SUSTAIN_MS : MIN_SUSTAIN_MS
				for (let i = 0; i < track.noteEventGroups.length; i++) {
					const noteGroup = track.noteEventGroups[i]

					removeWhere(futureSustainGaps, r => r.endTime <= noteGroup[0].msTime)
					const gaps = futureSustainGaps.filter(r => noteGroup[0].msTime >= r.startTime && noteGroup[0].msTime < r.endTime)
					if (gaps.length > 0) {
						// The gap that misses most decides: under the check's own threshold, it's a warning.
						const shortestGap = minOf(gaps.map(r => noteGroup[0].msTime - r.startTime))!
						addIssue('badSustainGap', noteGroup[0], shortestGap >= MIN_SUSTAIN_GAP_MS)
					}

					for (const note of noteGroup) {
						if (note.msLength > 0 && note.type !== noteTypes.open) {
							// ignore gaps of open sustains
							futureSustainGaps.push({
								startTime: note.msTime + note.msLength,
								endTime: note.msTime + note.msLength + sustainGapMs,
							})
						}

						if (note.msLength > 0 && note.msLength < sustainMs) {
							const nextNoteGroupOpen = track.noteEventGroups[i + 1]?.find(n => n.type === noteTypes.open)
							if (
								nextNoteGroupOpen &&
								nextNoteGroupOpen.tick < note.tick + note.length &&
								nextNoteGroupOpen.flags & (noteFlags.hopo | noteFlags.tap)
							) {
								continue // Ignore baby sustains before hopo opens and tap opens
							}

							addIssue('babySustain', note, note.msLength >= MIN_SUSTAIN_MS)
						}
					}
				}
			}
		}
	}

	return chartIssues
}

function typeCount(noteGroup: NoteEvent[], types: NoteType[]) {
	let count = 0
	for (const note of noteGroup) {
		if (types.includes(note.type)) {
			count++
		}
	}
	return count
}
