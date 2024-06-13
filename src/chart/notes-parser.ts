import * as _ from 'lodash'

import { DrumType, drumTypes } from 'src/interfaces'
import { parseNotesFromChart } from './chart-parser'
import { parseNotesFromMidi } from './midi-parser'
import { EventType, eventTypes, IniChartModifiers, NoteEvent, noteFlags, NoteType, noteTypes, RawChartData } from './note-parsing-interfaces'

type TimedTrackEvent = RawChartData['trackData'][number]['trackEvents'][number] & { msTime: number; msLength: number }

export type ParsedChart = ReturnType<typeof parseChartFile>

/**
 * Parses `buffer` as a chart in the .chart or .mid format.
 *
 * Throws an exception if `buffer` could not be parsed as a chart in the .chart or .mid format.
 */
export function parseChartFile(data: Uint8Array, format: 'chart' | 'mid', iniChartModifiers: IniChartModifiers) {
	const rawChartData = format === 'mid' ? parseNotesFromMidi(data, iniChartModifiers) : parseNotesFromChart(data)
	const timedTempos = getTimedTempos(rawChartData.tempos, rawChartData.chartTicksPerBeat)
	const drumTracks = rawChartData.trackData.filter(track => track.instrument === 'drums')
	const drumType =
		drumTracks.length === 0 ? null
		: iniChartModifiers.pro_drums ? drumTypes.fourLanePro
		: iniChartModifiers.five_lane_drums ? drumTypes.fiveLane
		: drumTracks.find(track => track.trackEvents.find(e => isCymbalOrTomMarker(e.type))) ? drumTypes.fourLanePro
		: drumTracks.find(track => track.trackEvents.find(e => e.type === eventTypes.fiveGreenDrum)) ? drumTypes.fiveLane
		: drumTypes.fourLane
	const hasForcedNotes = _.chain(rawChartData.trackData)
		.filter(track => track.instrument !== 'drums')
		.some(track =>
			_.some(track.trackEvents, e => {
				return e.type === eventTypes.forceUnnatural || e.type === eventTypes.forceHopo || e.type === eventTypes.forceStrum
			}),
		)
		.value()

	return {
		resolution: rawChartData.chartTicksPerBeat,
		drumType,
		metadata: rawChartData.metadata,
		hasLyrics: rawChartData.hasLyrics,
		hasVocals: rawChartData.hasVocals,
		hasForcedNotes,
		endEvents: getTimedEvents(rawChartData.endEvents, timedTempos, rawChartData.chartTicksPerBeat),
		tempos: timedTempos,
		timeSignatures: getTimedEvents(rawChartData.timeSignatures, timedTempos, rawChartData.chartTicksPerBeat),
		sections: getTimedEvents(rawChartData.sections, timedTempos, rawChartData.chartTicksPerBeat),
		trackData: _.chain(rawChartData.trackData)
			.map(track => ({
				instrument: track.instrument,
				difficulty: track.difficulty,
				starPowerSections: _.chain(track.starPowerSections)
					.thru(events => getTimedEvents(events, timedTempos, rawChartData.chartTicksPerBeat))
					.thru(events => sortAndFixInvalidEventOverlaps(events))
					.value(),
				rejectedStarPowerSections: _.chain(track.rejectedStarPowerSections)
					.thru(events => getTimedEvents(events, timedTempos, rawChartData.chartTicksPerBeat))
					.value(),
				soloSections: _.chain(track.soloSections)
					.thru(events => getTimedEvents(events, timedTempos, rawChartData.chartTicksPerBeat))
					.thru(events => sortAndFixInvalidEventOverlaps(events))
					.value(),
				flexLanes: _.chain(track.flexLanes)
					.thru(events => getTimedEvents(events, timedTempos, rawChartData.chartTicksPerBeat))
					.thru(events => sortAndFixInvalidFlexLaneOverlaps(events))
					.value(),
				drumFreestyleSections: getTimedEvents(track.drumFreestyleSections, timedTempos, rawChartData.chartTicksPerBeat),
				trackEventGroups: _.chain(track.trackEvents)
					.thru(events => getTimedEvents(events, timedTempos, rawChartData.chartTicksPerBeat))
					.thru(events => trimSustains(events, iniChartModifiers, rawChartData.chartTicksPerBeat, format))
					.groupBy(note => note.tick)
					.values()
					.value(),
			}))
			.map(track => ({
				...track,
				noteEventGroups:
					track.instrument === 'drums' ?
						resolveDrumModifiers(track.trackEventGroups, drumType!, format)
					:	resolveFretModifiers(track.trackEventGroups, iniChartModifiers, rawChartData.chartTicksPerBeat, format),
			}))
			.tap(tracks => tracks.forEach(track => sortAndFixInvalidNoteOverlaps(track.noteEventGroups)))
			.map(track => {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				delete (track as any).trackEventGroups // Save memory
				return track as Omit<typeof track, 'trackEventGroups'>
			})
			.value(),
	}
}

function getTimedTempos(
	tempos: { tick: number; millibeatsPerMinute: number }[],
	chartTicksPerBeat: number,
): { tick: number; millibeatsPerMinute: number; msTime: number }[] {
	const newTempos: { tick: number; millibeatsPerMinute: number; msTime: number }[] = [{ tick: 0, millibeatsPerMinute: 120000, msTime: 0 }]

	for (const tempo of tempos) {
		const newTempo = tempo as { tick: number; millibeatsPerMinute: number; msTime: number }
		const lastTempo = newTempos[newTempos.length - 1]

		newTempo.msTime = lastTempo.msTime + ((tempo.tick - lastTempo.tick) * 1000 * 60000) / (lastTempo.millibeatsPerMinute * chartTicksPerBeat)
		newTempos.push(newTempo)
	}

	if (newTempos[1] && newTempos[1].tick === 0) {
		newTempos.shift()
	}
	return newTempos
}

function isCymbalOrTomMarker(type: EventType) {
	switch (type) {
		case eventTypes.yellowCymbalMarker:
		case eventTypes.blueCymbalMarker:
		case eventTypes.greenCymbalMarker:
		case eventTypes.yellowTomMarker:
		case eventTypes.blueTomMarker:
		case eventTypes.greenTomMarker:
			return true
		default:
			return false
	}
}

function getTimedEvents<T extends { tick: number; length?: number }>(
	events: T[],
	tempos: { tick: number; millibeatsPerMinute: number; msTime: number }[],
	chartTicksPerBeat: number,
): (T & { msTime: number; msLength: number })[] {
	let lastTempoIndex = 0
	const newEvents: (T & { msTime: number; msLength: number })[] = []

	for (const event of events) {
		while (tempos[lastTempoIndex + 1] && tempos[lastTempoIndex + 1].tick <= event.tick) {
			lastTempoIndex++
		}

		const lastTempo = tempos[lastTempoIndex]
		const newEvent = event as T & { msTime: number; msLength: number }

		newEvent.msTime = lastTempo.msTime + ((event.tick - lastTempo.tick) * 1000 * 60000) / (lastTempo.millibeatsPerMinute * chartTicksPerBeat)

		if (event.length) {
			let endTempoIndex = lastTempoIndex
			while (tempos[endTempoIndex + 1] && tempos[endTempoIndex + 1].tick <= event.tick + event.length) {
				endTempoIndex++
			}
			const endTempo = tempos[endTempoIndex]
			newEvent.msLength =
				endTempo.msTime -
				newEvent.msTime +
				((event.tick + event.length - endTempo.tick) * 1000 * 60000) / (endTempo.millibeatsPerMinute * chartTicksPerBeat)
		} else {
			newEvent.msLength = 0
		}
		newEvents.push(newEvent)
	}

	return newEvents
}

function trimSustains(
	trackEvents: { tick: number; length: number; type: EventType; msTime: number; msLength: number }[],
	iniChartModifiers: IniChartModifiers,
	chartTicksPerBeat: number,
	format: 'chart' | 'mid',
) {
	const sustainThresholdTicks =
		iniChartModifiers.sustain_cutoff_threshold !== -1 ? iniChartModifiers.sustain_cutoff_threshold
		: format === 'mid' ? Math.floor(chartTicksPerBeat / 3) + 1
		: 0

	for (const event of trackEvents) {
		if (event.length <= sustainThresholdTicks) {
			event.length = 0
			event.msLength = 0
		}
	}

	return trackEvents
}

function resolveDrumModifiers(trackEventGroups: TimedTrackEvent[][], drumType: DrumType, format: 'chart' | 'mid'): NoteEvent[][] {
	const noteEventGroups: NoteEvent[][] = []
	const discoFlipEventTypes = [eventTypes.discoFlipOff, eventTypes.discoFlipOn, eventTypes.discoNoFlipOn] as const

	let activeDiscoFlip: (typeof discoFlipEventTypes)[number] = eventTypes.discoFlipOff
	for (const events of trackEventGroups) {
		const notes = events.filter(e => isDrumNote(e.type) && !isKickNote(e.type))
		const kicks = events.filter(e => isKickNote(e.type))
		const modifiers = events.filter(e => !isDrumNote(e.type)).map(m => m.type)
		const discoFlipModifier = _.chain(modifiers)
			.filter(e => discoFlipEventTypes.includes(e as (typeof discoFlipEventTypes)[number]))
			.min()
			.value()
		if (discoFlipModifier) {
			activeDiscoFlip = discoFlipModifier as 51 | 52 | 53 // Set before checked for this event (start inclusive, end exclusive)
		}
		if (notes.length + kicks.length === 0) {
			continue // Skip any event groups with only modifiers
		}

		const noteEventGroup: NoteEvent[] = []

		const flamFlag = modifiers.find(e => e === eventTypes.forceFlam) ? noteFlags.flam : noteFlags.none
		for (const kick of kicks) {
			const kickTypeFlag = kick.type === eventTypes.kick ? noteFlags.none : noteFlags.doubleKick
			noteEventGroup.push({
				tick: kick.tick,
				msTime: kick.msTime,
				length: kick.length,
				msLength: kick.msLength,
				type: noteTypes.kick,
				flags: flamFlag | kickTypeFlag | getGhostOrAccentFlags(kick.type, modifiers),
			})
		}

		const hasOrangeAndGreen =
			!!notes.find(e => e.type === eventTypes.fiveGreenDrum) && !!notes.find(e => e.type === eventTypes.fiveOrangeFourGreenDrum)

		for (const note of notes) {
			const type = getDrumNoteTypeFromEventType(note.type, hasOrangeAndGreen)!
			const canBeDisco = type === noteTypes.redDrum || type === noteTypes.yellowDrum
			const discoFlag =
				!canBeDisco || activeDiscoFlip === eventTypes.discoFlipOff ? noteFlags.none
				: activeDiscoFlip === eventTypes.discoFlipOn ? noteFlags.disco
				: noteFlags.discoNoflip
			const baseFlags = flamFlag | discoFlag
			noteEventGroup.push({
				tick: note.tick,
				msTime: note.msTime,
				length: note.length,
				msLength: note.msLength,
				type,
				flags: baseFlags | getTomOrCymbalFlags(note.type, modifiers, drumType, format) | getGhostOrAccentFlags(note.type, modifiers),
			})
		}

		noteEventGroups.push(noteEventGroup)
	}

	return noteEventGroups
}

function isDrumNote(eventType: EventType) {
	switch (eventType) {
		case eventTypes.kick:
		case eventTypes.kick2x:
		case eventTypes.redDrum:
		case eventTypes.yellowDrum:
		case eventTypes.blueDrum:
		case eventTypes.fiveOrangeFourGreenDrum:
		case eventTypes.fiveGreenDrum:
			return true
		default:
			return false
	}
}

function isKickNote(eventType: EventType) {
	switch (eventType) {
		case eventTypes.kick:
		case eventTypes.kick2x:
			return true
		default:
			return false
	}
}

function getDrumNoteTypeFromEventType(eventType: EventType, hasOrangeAndGreen: boolean): NoteType | null {
	switch (eventType) {
		case eventTypes.redDrum:
			return noteTypes.redDrum
		case eventTypes.yellowDrum:
			return noteTypes.yellowDrum
		case eventTypes.blueDrum:
			return noteTypes.blueDrum
		case eventTypes.fiveOrangeFourGreenDrum:
			return noteTypes.greenDrum
		case eventTypes.fiveGreenDrum:
			return hasOrangeAndGreen ? noteTypes.blueDrum : noteTypes.greenDrum
		default:
			return null
	}
}

function getTomOrCymbalFlags(eventType: EventType, modifiers: EventType[], drumType: DrumType, format: 'chart' | 'mid') {
	switch (drumType) {
		case drumTypes.fourLane:
			return noteFlags.tom
		case drumTypes.fourLanePro:
			switch (format) {
				case 'mid':
					switch (eventType) {
						case eventTypes.redDrum:
							return noteFlags.tom
						case eventTypes.yellowDrum:
							return modifiers.includes(eventTypes.yellowTomMarker) ? noteFlags.tom : noteFlags.cymbal
						case eventTypes.blueDrum:
							return modifiers.includes(eventTypes.blueTomMarker) ? noteFlags.tom : noteFlags.cymbal
						case eventTypes.fiveOrangeFourGreenDrum:
							return modifiers.includes(eventTypes.greenTomMarker) ? noteFlags.tom : noteFlags.cymbal
						case eventTypes.fiveGreenDrum:
							return noteFlags.tom
						default:
							return noteFlags.none
					}
				case 'chart':
					switch (eventType) {
						case eventTypes.redDrum:
							return noteFlags.tom
						case eventTypes.yellowDrum:
							return modifiers.includes(eventTypes.yellowCymbalMarker) ? noteFlags.cymbal : noteFlags.tom
						case eventTypes.blueDrum:
							return modifiers.includes(eventTypes.blueCymbalMarker) ? noteFlags.cymbal : noteFlags.tom
						case eventTypes.fiveOrangeFourGreenDrum:
							return modifiers.includes(eventTypes.greenCymbalMarker) ? noteFlags.cymbal : noteFlags.tom
						case eventTypes.fiveGreenDrum:
							return noteFlags.tom
						default:
							return noteFlags.none
					}
				default:
					return noteFlags.none
			}
		case drumTypes.fiveLane:
			switch (eventType) {
				case eventTypes.redDrum:
					return noteFlags.tom
				case eventTypes.yellowDrum:
					return noteFlags.cymbal
				case eventTypes.blueDrum:
					return noteFlags.tom
				case eventTypes.fiveOrangeFourGreenDrum:
					return noteFlags.cymbal
				case eventTypes.fiveGreenDrum:
					return noteFlags.tom
				default:
					return noteFlags.none
			}
		default:
			return noteFlags.none
	}
}

function getGhostOrAccentFlags(eventType: EventType, modifiers: EventType[]) {
	switch (eventType) {
		case eventTypes.redDrum:
			return (
				modifiers.includes(eventTypes.redAccent) ? noteFlags.accent
				: modifiers.includes(eventTypes.redGhost) ? noteFlags.ghost
				: noteFlags.none
			)
		case eventTypes.yellowDrum:
			return (
				modifiers.includes(eventTypes.yellowAccent) ? noteFlags.accent
				: modifiers.includes(eventTypes.yellowGhost) ? noteFlags.ghost
				: noteFlags.none
			)
		case eventTypes.blueDrum:
			return (
				modifiers.includes(eventTypes.blueAccent) ? noteFlags.accent
				: modifiers.includes(eventTypes.blueGhost) ? noteFlags.ghost
				: noteFlags.none
			)
		case eventTypes.fiveOrangeFourGreenDrum:
			return (
				modifiers.includes(eventTypes.fiveOrangeFourGreenAccent) ? noteFlags.accent
				: modifiers.includes(eventTypes.fiveOrangeFourGreenGhost) ? noteFlags.ghost
				: noteFlags.none
			)
		case eventTypes.fiveGreenDrum:
			return (
				modifiers.includes(eventTypes.fiveGreenAccent) ? noteFlags.accent
				: modifiers.includes(eventTypes.fiveGreenGhost) ? noteFlags.ghost
				: noteFlags.none
			)
		case eventTypes.kick:
			return (
				modifiers.includes(eventTypes.kickAccent) ? noteFlags.accent
				: modifiers.includes(eventTypes.kickGhost) ? noteFlags.ghost
				: noteFlags.none
			)
		case eventTypes.kick2x:
			return (
				modifiers.includes(eventTypes.kickAccent) ? noteFlags.accent
				: modifiers.includes(eventTypes.kickGhost) ? noteFlags.ghost
				: noteFlags.none
			)
		default:
			return noteFlags.none
	}
}

function resolveFretModifiers(
	trackEventGroups: TimedTrackEvent[][],
	iniChartModifiers: IniChartModifiers,
	chartTicksPerBeat: number,
	format: 'chart' | 'mid',
): NoteEvent[][] {
	const hopoThresholdTicks =
		iniChartModifiers.hopo_frequency ||
		(iniChartModifiers.eighthnote_hopo ?
			Math.floor(1 + chartTicksPerBeat / 2)
		:	Math.floor(format === 'mid' ? 1 + chartTicksPerBeat / 3 : (65 / 192) * chartTicksPerBeat))

	const noteEventGroups: NoteEvent[][] = []

	let lastNotes: TimedTrackEvent[] | null = null
	// trackEventGroups only contain notes and note modifiers
	for (let i = 0; i < trackEventGroups.length; i++) {
		const events = trackEventGroups[i]
		if (events.some(n => n.type === eventTypes.forceOpen)) {
			// Apply open modifier
			// Note: it's not possible for a forceOpen event to generate without there also being at least one playable note here
			const longestEvent = _.maxBy(
				events.filter(e => isFretNote(e.type)),
				e => e.length,
			)!
			_.remove(events, e => isFretNote(e.type) || e.type === eventTypes.forceOpen)
			longestEvent.type = eventTypes.open
			events.push(longestEvent)
		}
		const notes = events.filter(e => isFretNote(e.type))
		if (!notes.length) {
			continue // Skip any event groups with only modifiers
		}

		const isNaturalHopo =
			!!lastNotes &&
			notes[0].tick - lastNotes[0].tick <= hopoThresholdTicks &&
			!isFretChord(notes) &&
			!isSameFretNote(events, lastNotes) &&
			// This .mid exception is due to compatibility concerns with older games that primarily use .mid
			!(format === 'mid' && isFretChord(lastNotes) && isInFretNote(notes, lastNotes))
		const hasForceUnnatural = !!events.find(n => n.type === eventTypes.forceUnnatural)
		const forceResult =
			events.find(n => n.type === eventTypes.forceTap) ? noteFlags.tap
			: events.find(n => n.type === eventTypes.forceHopo) ? noteFlags.hopo
			: events.find(n => n.type === eventTypes.forceStrum) ? noteFlags.strum
			: (hasForceUnnatural && isNaturalHopo) || (!hasForceUnnatural && !isNaturalHopo) ? noteFlags.strum
			: noteFlags.hopo

		noteEventGroups.push(
			notes.map(n => ({
				tick: n.tick,
				msTime: n.msTime,
				length: n.length,
				msLength: n.msLength,
				type: getFretNoteTypeFromEventType(n.type)!, // Should be the only event types at this point
				flags: forceResult,
			})),
		)

		lastNotes = notes
	}

	return noteEventGroups
}

function isFretNote(type: EventType) {
	switch (type) {
		case eventTypes.open:
		case eventTypes.green:
		case eventTypes.red:
		case eventTypes.yellow:
		case eventTypes.blue:
		case eventTypes.orange:
		case eventTypes.black3:
		case eventTypes.black2:
		case eventTypes.black1:
		case eventTypes.white3:
		case eventTypes.white2:
		case eventTypes.white1:
			return true
		default:
			return false
	}
}

function isSameFretNote(note1: TimedTrackEvent[], note2: TimedTrackEvent[]) {
	for (const n1 of note1) {
		if (!isFretNote(n1.type)) {
			continue
		}

		for (const n2 of note2) {
			if (!isFretNote(n2.type)) {
				continue
			}

			if (n1.type !== n2.type) {
				return false
			}
		}
	}

	for (const n2 of note2) {
		if (!isFretNote(n2.type)) {
			continue
		}

		for (const n1 of note1) {
			if (!isFretNote(n1.type)) {
				continue
			}

			if (n2.type !== n1.type) {
				return false
			}
		}
	}

	return true
}

function isFretChord(note: TimedTrackEvent[]) {
	let firstNoteType: EventType | null = null
	for (const n of note) {
		if (isFretNote(n.type)) {
			if (firstNoteType === null) {
				firstNoteType = n.type
			} else if (firstNoteType !== n.type) {
				return true
			}
		}
	}
	return false
}

function isInFretNote(inNote: TimedTrackEvent[], outerNote: TimedTrackEvent[]) {
	return (
		_.differenceBy(
			inNote.filter(n => isFretNote(n.type)),
			outerNote.filter(n => isFretNote(n.type)),
			note => note.type,
		).length === 0
	)
}

function getFretNoteTypeFromEventType(eventType: EventType): NoteType | null {
	switch (eventType) {
		case eventTypes.open:
			return noteTypes.open
		case eventTypes.green:
			return noteTypes.green
		case eventTypes.red:
			return noteTypes.red
		case eventTypes.yellow:
			return noteTypes.yellow
		case eventTypes.blue:
			return noteTypes.blue
		case eventTypes.orange:
			return noteTypes.orange
		case eventTypes.black3:
			return noteTypes.black3
		case eventTypes.black2:
			return noteTypes.black2
		case eventTypes.black1:
			return noteTypes.black1
		case eventTypes.white3:
			return noteTypes.white3
		case eventTypes.white2:
			return noteTypes.white2
		case eventTypes.white1:
			return noteTypes.white1
		default:
			return null
	}
}

function sortAndFixInvalidFlexLaneOverlaps(events: { tick: number; length: number; isDouble: boolean; msTime: number; msLength: number }[]) {
	events.sort((a, b) => {
		if (a.tick !== b.tick) {
			return a.tick - b.tick
		}
		if (a.isDouble !== b.isDouble) {
			return (a.isDouble ? 1 : 0) - (b.isDouble ? 1 : 0) // false first
		}
		return b.length - a.length // length descending (longest lane is kept for duplicates)
	})
	let removedEvents: { tick: number; length: number; isDouble: boolean; msTime: number; msLength: number }[] | null = null
	for (let i = 1; i < events.length; i++) {
		if (events[i].tick === events[i - 1].tick && events[i].isDouble === events[i - 1].isDouble) {
			;(removedEvents ??= []).push(events[i])
		}
	}

	if (removedEvents) {
		_.pullAll(events, removedEvents)
	}

	return events
}

function sortAndFixInvalidEventOverlaps(events: { tick: number; length: number; msTime: number; msLength: number }[]) {
	events.sort((a, b) => a.tick - b.tick || b.length - a.length) // Longest event is kept for duplicates
	let removedEvents: { tick: number; length: number; msTime: number; msLength: number }[] | null = null
	for (let i = 1; i < events.length; i++) {
		if (events[i].tick === events[i - 1].tick) {
			;(removedEvents ??= []).push(events[i])
		}
	}

	if (removedEvents) {
		_.pullAll(events, removedEvents)
	}

	let previousEvent: { tick: number; length: number; msTime: number; msLength: number } | null = null
	for (const event of events) {
		if (previousEvent && previousEvent.tick + previousEvent.length > event.tick) {
			event.length = Math.max(event.length, previousEvent.length - (event.tick - previousEvent.tick))
			event.msLength = Math.max(event.msLength, previousEvent.msLength - (event.msTime - previousEvent.msTime))
			previousEvent.length = event.tick - previousEvent.tick
			previousEvent.msLength = event.msTime - previousEvent.msTime
		}
		previousEvent = event
	}

	return events
}

function sortAndFixInvalidNoteOverlaps(noteGroups: NoteEvent[][]) {
	for (const noteGroup of noteGroups) {
		noteGroup.sort((a, b) => a.type - b.type || b.length - a.length || b.flags - a.flags) // Longest sustain is kept for duplicates
		let removedNotes: NoteEvent[] | null = null
		for (let i = 1; i < noteGroup.length; i++) {
			if (noteGroup[i].type === noteGroup[i - 1].type) {
				;(removedNotes ??= []).push(noteGroup[i])
			}
		}

		if (removedNotes) {
			_.pullAll(noteGroup, removedNotes)
		}
	}

	const previousNotesOfType = new Map<NoteType, NoteEvent>()
	for (const noteGroup of noteGroups) {
		for (const note of noteGroup) {
			const previousNoteOfType = previousNotesOfType.get(note.type)
			previousNotesOfType.set(note.type, note)
			if (previousNoteOfType && previousNoteOfType.tick + previousNoteOfType.length > note.tick) {
				note.length = Math.max(note.length, previousNoteOfType.length - (note.tick - previousNoteOfType.tick))
				note.msLength = Math.max(note.msLength, previousNoteOfType.msLength - (note.msTime - previousNoteOfType.msTime))
				previousNoteOfType.length = note.tick - previousNoteOfType.tick
				previousNoteOfType.msLength = note.msTime - previousNoteOfType.msTime
			}
		}
	}
}
