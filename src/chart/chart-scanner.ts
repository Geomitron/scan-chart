import { blake3 } from '@noble/hashes/blake3'

import { md5 } from 'js-md5'
import * as _ from 'lodash'
import { base64url } from 'rfc4648'

import { defaultMetadata } from 'src/ini'
import { ChartIssueType, Difficulty, FolderIssueType, getInstrumentType, Instrument, instrumentTypes, NotesData } from '../interfaces'
import { getExtension, hasChartExtension, hasChartName, msToExactTime } from '../utils'
import { IniChartModifiers, NoteEvent, noteFlags, NoteType, noteTypes } from './note-parsing-interfaces'
import { parseChartFile, ParsedChart } from './notes-parser'
import { calculateTrackHash, pruneEmptyPhrases } from './track-hasher'

const LEADING_SILENCE_THRESHOLD_MS = 1000
const MIN_SUSTAIN_GAP_MS = 40
const MIN_SUSTAIN_MS = 100
const NPS_GROUP_SIZE_MS = 1000

export function scanChart(files: { fileName: string; data: Uint8Array }[], iniChartModifiers: IniChartModifiers, includeBTrack = false) {
	const { chartData, format, folderIssues } = findChartData(files)

	if (chartData) {
		try {
			const result = parseChartFile(chartData, format, iniChartModifiers)
			const trackHashes = result.trackData.map(t => {
				const hash = calculateTrackHash(result, t.instrument, t.difficulty)
				return {
					instrument: t.instrument,
					difficulty: t.difficulty,
					hash: hash.hash,
					btrack: includeBTrack ? hash.btrack : null,
				}
			})

			let [hasTapNotes, hasOpenNotes, has2xKick] = [false, false, false]
			for (const track of result.trackData) {
				for (const noteGroup of track.noteEventGroups) {
					for (const note of noteGroup) {
						if (note.flags & noteFlags.tap) {
							hasTapNotes = true
						}
						if (note.flags & noteFlags.doubleKick) {
							has2xKick = true
						}
						if (note.type === noteTypes.open) {
							hasOpenNotes = true
						}
					}
				}
			}

			return {
				chartHash: getChartHash(chartData, iniChartModifiers),
				notesData: {
					instruments: _.chain(result.trackData)
						.map(t => t.instrument)
						.uniq()
						.value(),
					drumType: result.drumType,
					hasSoloSections:
						_.chain(result.trackData)
							.map(t => t.soloSections.length)
							.max()
							.value() > 0,
					hasLyrics: result.hasLyrics,
					hasVocals: result.hasVocals,
					lyrics: result.lyrics.map(lyric => ({
						msTime: _.round(lyric.msTime, 3),
						msLength: _.round(lyric.msLength, 3),
						text: lyric.text,
					})),
					hasForcedNotes: result.hasForcedNotes,
					hasTapNotes,
					hasOpenNotes,
					has2xKick,
					hasFlexLanes:
						_.chain(result.trackData)
							.map(t => t.flexLanes.length)
							.max()
							.value() > 0,
					chartIssues: findChartIssues(result, iniChartModifiers.song_length, trackHashes),
					noteCounts: result.trackData.map(t => ({
						instrument: t.instrument,
						difficulty: t.difficulty,
						count: t.instrument === 'drums' ? _.sumBy(t.noteEventGroups, 'length') : t.noteEventGroups.length,
					})),
					maxNps: result.trackData.map(t => ({
						instrument: t.instrument,
						difficulty: t.difficulty,
						...findMaxNps(t.noteEventGroups),
					})),
					trackHashes,
					tempoMapHash: md5
						.create()
						.update(result.tempos.map(t => `${t.tick}_${t.beatsPerMinute * 1000}`).join(':'))
						.update(result.timeSignatures.map(t => `${t.tick}_${t.numerator}_${t.denominator}`).join(':'))
						.hex(),
					tempoMarkerCount: result.tempos.length,
					effectiveLength: _.chain(result.trackData)
						.thru(tracks => ({
							min: _.min(tracks.map(track => _.first(track.noteEventGroups)?.[0]?.msTime)),
							max: _.max(tracks.map(track => _.last(track.noteEventGroups)?.[0]?.msTime)),
						}))
						.thru(({ min, max }) => (min !== undefined && max !== undefined ? _.round(max - min, 3) : iniChartModifiers.song_length))
						.value(),
				},
				metadata: result.metadata,
				folderIssues,
			}
		} catch (err) {
			folderIssues.push({ folderIssue: 'badChart', description: typeof err === 'string' ? err : (err?.message ?? JSON.stringify(err)) })
		}
	}

	return { chartHash: null, notesData: null, metadata: null, folderIssues }
}

function findChartData(files: { fileName: string; data: Uint8Array }[]) {
	const folderIssues: { folderIssue: FolderIssueType; description: string }[] = []

	const chartFiles = _.chain(files)
		.filter(f => hasChartExtension(f.fileName))
		.orderBy([f => hasChartName(f.fileName), f => getExtension(f.fileName).toLowerCase() === 'mid'], ['desc', 'desc'])
		.value()

	for (const file of chartFiles) {
		if (!hasChartName(file.fileName)) {
			folderIssues.push({
				folderIssue: 'invalidChart',
				description: `"${file.fileName}" is not named "notes.${getExtension(file.fileName).toLowerCase()}".`,
			})
		}
	}

	if (chartFiles.length > 1) {
		folderIssues.push({ folderIssue: 'multipleChart', description: 'This chart has multiple .chart/.mid files.' })
	}

	if (chartFiles.length === 0) {
		folderIssues.push({ folderIssue: 'noChart', description: 'This chart doesn\'t have "notes.chart"/"notes.mid".' })
		return { chartData: null, format: null, folderIssues }
	} else {
		return {
			chartData: chartFiles[0].data,
			format: (getExtension(chartFiles[0].fileName).toLowerCase() === 'mid' ? 'mid' : 'chart') as 'mid' | 'chart',
			folderIssues,
		}
	}
}

function findMaxNps(notes: NoteEvent[][]) {
	if (notes.length === 0) {
		return { nps: 0, time: 0 }
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

	return { nps: (1000 * maxNotesInWindow) / NPS_GROUP_SIZE_MS, time: _.round(notes[maxWindowStartIndex][0].msTime, 3) }
}

const chartIssueDescriptions: { [issue in ChartIssueType]: string } = {
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
	smallLeadingSilence: 'This track has a note that is less than 2000ms after the start of the track.',
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
} as const

function findChartIssues(
	chartData: ParsedChart,
	songLength: number,
	trackHashes: { instrument: Instrument; difficulty: Difficulty; hash: string }[],
): { instrument: Instrument | null; difficulty: Difficulty | null; noteIssue: ChartIssueType; description: string }[] {
	const chartIssues: NotesData['chartIssues'] = []
	const addIssue = (instrument: Instrument | null, difficulty: Difficulty | null, issue: ChartIssueType, msTime?: number) =>
		chartIssues.push({
			instrument,
			difficulty,
			noteIssue: issue,
			description: msTime !== undefined ? `[${msToExactTime(msTime)}]: ${chartIssueDescriptions[issue]}` : chartIssueDescriptions[issue],
		})

	// misalignedTimeSignature
	{
		const timeSignatures = _.clone(chartData.timeSignatures)
		let lastBeatlineTick = 0
		for (let i = 0; i < timeSignatures.length; i++) {
			if (lastBeatlineTick !== timeSignatures[i].tick) {
				addIssue(null, null, 'misalignedTimeSignature', timeSignatures[i].msTime)
				_.pullAt(timeSignatures, i) // Treat misaligned time signature like it was removed to discover future misaligned time signatures
				i--
			}
			while (timeSignatures[i + 1] && lastBeatlineTick < timeSignatures[i + 1].tick) {
				lastBeatlineTick += chartData.resolution * 4 * (timeSignatures[i].numerator / timeSignatures[i].denominator)
			}
		}
	}

	// noNotes
	{
		if (chartData.trackData.every(track => track.noteEventGroups.length === 0) && !chartData.hasVocals) {
			addIssue(null, null, 'noNotes')
		}
	}

	// noExpert, difficultyNotReduced
	{
		for (const instrumentGroup of _.chain(chartData.trackData)
			.groupBy(track => track.instrument)
			.values()
			.value()) {
			if (instrumentGroup.every(track => track.difficulty !== 'expert')) {
				addIssue(instrumentGroup[0].instrument, null, 'noExpert')
			} else {
				const expertHash = trackHashes.find(t => t.instrument === instrumentGroup[0].instrument && t.difficulty === 'expert')!.hash
				for (const track of instrumentGroup.filter(t => t.difficulty !== 'expert')) {
					if (
						expertHash === trackHashes.find(t => t.instrument === track.instrument && t.difficulty === track.difficulty)!.hash &&
						track.noteEventGroups.length > 20
					) {
						addIssue(track.instrument, track.difficulty, 'difficultyNotReduced')
					}
				}
			}
		}
	}

	// isDefaultBPM
	{
		const isDefaultTempo = chartData.tempos.length === 1 && _.round(chartData.tempos[0].beatsPerMinute, 12) === 120
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
				addIssue(null, null, 'badEndEvent', endEvent.msTime)
			}
		}
		const lastNoteTick = _.max(chartData.trackData.map(track => _.last(track.noteEventGroups)?.[0]?.tick))
		if (lastNoteTick && chartData.endEvents[0] && chartData.endEvents[0].tick < lastNoteTick) {
			addIssue(null, null, 'badEndEvent', chartData.endEvents[0].msTime)
		}
	}

	for (const track of chartData.trackData) {
		const instrumentType = getInstrumentType(track.instrument)
		const addIssue = (issue: ChartIssueType, msTime?: number) =>
			chartIssues.push({
				instrument: track.instrument,
				difficulty: track.difficulty,
				noteIssue: issue,
				description: msTime !== undefined ? `[${msToExactTime(msTime)}]: ${chartIssueDescriptions[issue]}` : chartIssueDescriptions[issue],
			})

		// smallLeadingSilence
		{
			if (track.noteEventGroups[0]?.[0]?.msTime !== undefined && track.noteEventGroups[0][0].msTime < LEADING_SILENCE_THRESHOLD_MS) {
				addIssue('smallLeadingSilence')
			}
		}

		// noStarPower
		{
			if (
				track.starPowerSections.length === 0 &&
				track.instrument !== 'drums' &&
				track.noteEventGroups.length > 50 &&
				_.last(track.noteEventGroups)![0].msTime - _.first(track.noteEventGroups)![0].msTime > 60000
			) {
				addIssue('noStarPower')
			}
		}

		// emptyStarPower
		{
			const emptyStarPowerSections = _.difference(track.starPowerSections, pruneEmptyPhrases(track.starPowerSections, track.noteEventGroups))
			for (const emptyStarPowerSection of emptyStarPowerSections) {
				addIssue('emptyStarPower', emptyStarPowerSection.msTime)
			}
		}

		// badStarPower
		{
			for (const rejectedStarPower of track.rejectedStarPowerSections) {
				addIssue('badStarPower', rejectedStarPower.msTime)
			}
		}

		// emptySoloSection
		{
			const emptySoloSections = _.difference(track.soloSections, pruneEmptyPhrases(track.soloSections, track.noteEventGroups))
			for (const emptySoloSection of emptySoloSections) {
				addIssue('emptySoloSection', emptySoloSection.msTime)
			}
		}

		// noDrumActivationLanes
		{
			if (
				track.instrument === 'drums' &&
				track.drumFreestyleSections.length === 0 &&
				track.starPowerSections.length > 0 &&
				track.noteEventGroups.length > 50 &&
				_.last(track.noteEventGroups)![0].msTime - _.first(track.noteEventGroups)![0].msTime > 60000
			) {
				addIssue('noDrumActivationLanes')
			}
		}

		// emptyFlexLane
		{
			const emptyFlexLanes = _.difference(track.flexLanes, pruneEmptyPhrases(track.flexLanes, track.noteEventGroups))
			for (const emptyFlexLane of emptyFlexLanes) {
				addIssue('emptyFlexLane', emptyFlexLane.msTime)
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
								addIssue('difficultyForbiddenNote', noteGroup[0].msTime)
							}
						}
					}
					if (track.difficulty === 'easy') {
						if (typeCount(noteGroup, nonKickDrumNoteTypes) === 2 && typeCount(noteGroup, kickDrumNoteTypes) > 0) {
							addIssue('difficultyForbiddenNote', noteGroup[0].msTime)
						}
					}
				}

				// invalidChord
				{
					if (typeCount(noteGroup, nonKickDrumNoteTypes) >= 3) {
						addIssue('invalidChord', noteGroup[0].msTime)
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
							addIssue('difficultyForbiddenNote', noteGroup[0].msTime)
						}
					} else if (track.difficulty === 'medium') {
						if (typeCount(noteGroup, orangeType) > 0) {
							addIssue('difficultyForbiddenNote', noteGroup[0].msTime)
						} else if (typeCount(noteGroup, greenBlueChordTypes) === 2) {
							addIssue('difficultyForbiddenNote', noteGroup[0].msTime)
						}
					} else if (track.difficulty === 'easy') {
						if (typeCount(noteGroup, orangeBlueTypes) > 0) {
							addIssue('difficultyForbiddenNote', noteGroup[0].msTime)
						}
					}
				}

				// invalidChord
				{
					if (typeCount(noteGroup, fiveNoteChordTypes) === 5) {
						addIssue('invalidChord', noteGroup[0].msTime)
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
							addIssue('difficultyForbiddenNote', noteGroup[0].msTime) // No 3-note chords that mix white/black
						}
					} else if (track.difficulty === 'medium') {
						if (noteGroup.length === 3) {
							addIssue('difficultyForbiddenNote', noteGroup[0].msTime)
						} else if (noteGroup.length === 2 && typeCount(noteGroup, blackTypes) > 0 && typeCount(noteGroup, whiteTypes) > 0) {
							if (typeCount(noteGroup, oneTypes) < 2 && typeCount(noteGroup, twoTypes) < 2 && typeCount(noteGroup, threeTypes) < 2) {
								addIssue('difficultyForbiddenNote', noteGroup[0].msTime) // No chords that mix white/black, except barre chords are ok
							}
						}
					} else if (track.difficulty === 'easy') {
						if (noteGroup.length === 3) {
							addIssue('difficultyForbiddenNote', noteGroup[0].msTime)
						} else if (noteGroup.length === 2 && !(typeCount(noteGroup, white12Type) === 2 || typeCount(noteGroup, white23Type) === 2)) {
							addIssue('difficultyForbiddenNote', noteGroup[0].msTime)
						}
					}
				}

				// invalidChord
				{
					if (noteGroup.length > 3) {
						addIssue('invalidChord', noteGroup[0].msTime)
					} else if (typeCount(noteGroup, twoTypes) === 2 && typeCount(noteGroup, oneTypes) > 0) {
						addIssue('invalidChord', noteGroup[0].msTime)
					} else if (typeCount(noteGroup, threeTypes) === 2 && typeCount(noteGroup, oneTypes) + typeCount(noteGroup, twoTypes) > 0) {
						addIssue('invalidChord', noteGroup[0].msTime)
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
					addIssue('brokenNote', track.noteEventGroups[i][0].msTime)
				}
			}
		}

		if (instrumentType !== instrumentTypes.drums) {
			// badSustainGap, babySustain
			{
				/** Sustain gaps at the end of notes already checked in the for loop. `startTime` is inclusive, `endTime` is exclusive. */
				const futureSustainGaps: { startTime: number; endTime: number }[] = []
				for (let i = 0; i < track.noteEventGroups.length; i++) {
					const noteGroup = track.noteEventGroups[i]

					_.remove(futureSustainGaps, r => r.endTime <= noteGroup[0].msTime)
					if (futureSustainGaps.some(r => noteGroup[0].msTime >= r.startTime && noteGroup[0].msTime < r.endTime)) {
						addIssue('badSustainGap', noteGroup[0].msTime)
					}

					for (const note of noteGroup) {
						if (note.msLength > 0 && note.type !== noteTypes.open) {
							// ignore gaps of open sustains
							futureSustainGaps.push({
								startTime: note.msTime + note.msLength,
								endTime: note.msTime + note.msLength + MIN_SUSTAIN_GAP_MS,
							})
						}

						if (note.msLength > 0 && note.msLength < MIN_SUSTAIN_MS) {
							const nextNoteGroupOpen = track.noteEventGroups[i + 1]?.find(n => n.type === noteTypes.open)
							if (
								nextNoteGroupOpen &&
								nextNoteGroupOpen.tick < note.tick + note.length &&
								nextNoteGroupOpen.flags & (noteFlags.hopo | noteFlags.tap)
							) {
								continue // Ignore baby sustains before hopo opens and tap opens
							}

							addIssue('babySustain', note.msTime)
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

function getChartHash(chartBytes: Uint8Array, iniChartModifiers: IniChartModifiers) {
	const hashedIniModifiers = (
		[
			{ name: 'hopo_frequency', value: iniChartModifiers.hopo_frequency },
			{ name: 'eighthnote_hopo', value: iniChartModifiers.eighthnote_hopo },
			{ name: 'multiplier_note', value: iniChartModifiers.multiplier_note },
			{ name: 'sustain_cutoff_threshold', value: iniChartModifiers.sustain_cutoff_threshold },
			{ name: 'chord_snap_threshold', value: iniChartModifiers.chord_snap_threshold },
			{ name: 'five_lane_drums', value: iniChartModifiers.five_lane_drums },
			{ name: 'pro_drums', value: iniChartModifiers.pro_drums },
		] as const
	)
		.filter(modifier => modifier.value !== defaultMetadata[modifier.name])
		.map(modifier => ({
			name: new TextEncoder().encode(modifier.name),
			value: int32ToUint8Array(
				typeof modifier.value === 'number' ? modifier.value
				: modifier.value === true ? 1
				: 0,
			),
		}))

	const hashedIniModifiersLength = _.sumBy(hashedIniModifiers, modifier => modifier.name.length + modifier.value.length)
	const buffer = new ArrayBuffer(chartBytes.length + hashedIniModifiersLength)
	const uint8Array = new Uint8Array(buffer)
	uint8Array.set(chartBytes)

	let offset = chartBytes.length
	for (const modifier of hashedIniModifiers) {
		uint8Array.set(modifier.name, offset)
		offset += modifier.name.length
		uint8Array.set(modifier.value, offset)
		offset += modifier.value.length
	}

	return base64url.stringify(blake3(uint8Array))
}

function int32ToUint8Array(num: number) {
	const buffer = new ArrayBuffer(4)
	const view = new DataView(buffer)
	view.setInt32(0, num, true)

	return new Uint8Array(buffer)
}

/**
 * Included for legacy testing purposes
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function legacyGetChartHash(chartBytes: Uint8Array, iniChartModifiers: IniChartModifiers) {
	const iniChartModifierSize = 4 + 1 + 4 + 4 + 1 + 1
	const buffer = new ArrayBuffer(chartBytes.length + iniChartModifierSize)
	const uint8Array = new Uint8Array(buffer)
	uint8Array.set(chartBytes)
	const view = new DataView(buffer, chartBytes.length)

	view.setInt32(0, iniChartModifiers.hopo_frequency, true)
	view.setInt8(4, iniChartModifiers.eighthnote_hopo ? 1 : 0)
	view.setInt32(5, iniChartModifiers.multiplier_note, true)
	view.setInt32(9, iniChartModifiers.sustain_cutoff_threshold, true)
	view.setInt8(13, iniChartModifiers.five_lane_drums ? 1 : 0)
	view.setInt8(14, iniChartModifiers.pro_drums ? 1 : 0)

	return base64url.stringify(blake3(uint8Array))
}
