import { blake3 } from '@noble/hashes/blake3'

import * as _ from 'lodash'
import { base64url } from 'rfc4648'

import { Difficulty, Instrument } from 'src/interfaces'
import { ParsedChart } from './notes-parser'

export function calculateTrackHash(parsedChart: ParsedChart, instrument: Instrument, difficulty: Difficulty) {
	const trackData = parsedChart.trackData.find(t => t.instrument === instrument && t.difficulty === difficulty)
	if (!trackData) {
		throw 'Track with specified instrument or difficulty was not found.'
	}

	// Only include the last tempo defined on each tick
	const tempoData = _.chain(parsedChart.tempos)
		.sortBy(t => t.tick)
		.reverse()
		.sortedUniqBy(t => t.tick)
		.reverse()
		.value()

	// Only include the last time signature defined on each tick
	const timeSignatureData = _.chain(parsedChart.timeSignatures)
		.sortBy(t => t.tick)
		.reverse()
		.sortedUniqBy(t => t.tick)
		.reverse()
		.value()

	const starPowerData = pruneEmptyPhrases(trackData.starPowerSections, trackData.noteEventGroups)
	const soloSectionData = pruneEmptyPhrases(trackData.soloSections, trackData.noteEventGroups)
	const flexLanesData = pruneEmptyPhrases(trackData.flexLanes, trackData.noteEventGroups)
	const drumFreestyleSectionData = trackData.drumFreestyleSections
	const notesData = _.flatten(trackData.noteEventGroups)

	const headerSize = 4 + 4 + 4
	const tempoSize = 4 + (8 + 8) * tempoData.length
	const timeSignatureSize = 4 + (8 + 4 + 4) * timeSignatureData.length
	const starPowerSize = 4 + (8 + 8) * starPowerData.length
	const soloSectionSize = 4 + (8 + 8) * soloSectionData.length
	const flexLanesSize = 4 + (8 + 8 + 1) * flexLanesData.length
	const drumFreestyleSectionSize = 4 + (8 + 8 + 1) * drumFreestyleSectionData.length
	const notesSize = 4 + (8 + 8 + 4 + 4) * notesData.length
	const totalSize =
		headerSize + tempoSize + timeSignatureSize + starPowerSize + soloSectionSize + flexLanesSize + drumFreestyleSectionSize + notesSize

	const buffer = new ArrayBuffer(totalSize)
	const uint8Array = new Uint8Array(buffer)
	const view = new DataView(buffer, 0)

	view.setUint32(0, 0x43484e46, false) // Big endian for format header, little endian for everything else
	view.setUint32(4, 20240320, true)
	view.setUint32(8, parsedChart.resolution, true)
	let i = 12
	view.setUint32(i, tempoData.length, true)
	i += 4
	for (const tempo of tempoData) {
		view.setBigInt64(i, BigInt(tempo.tick), true)
		view.setFloat64(i + 8, tempo.beatsPerMinute, true)
		i += 16
	}
	view.setUint32(i, timeSignatureData.length, true)
	i += 4
	for (const timeSignature of timeSignatureData) {
		view.setBigInt64(i, BigInt(timeSignature.tick), true)
		view.setUint32(i + 8, timeSignature.numerator, true)
		view.setUint32(i + 12, timeSignature.denominator, true)
		i += 16
	}
	view.setUint32(i, starPowerData.length, true)
	i += 4
	for (const starPower of starPowerData) {
		view.setBigInt64(i, BigInt(starPower.tick), true)
		view.setBigInt64(i + 8, BigInt(starPower.length), true)
		i += 16
	}
	view.setUint32(i, soloSectionData.length, true)
	i += 4
	for (const soloSection of soloSectionData) {
		view.setBigInt64(i, BigInt(soloSection.tick), true)
		view.setBigInt64(i + 8, BigInt(soloSection.length), true)
		i += 16
	}
	view.setUint32(i, flexLanesData.length, true)
	i += 4
	for (const flexLane of flexLanesData) {
		view.setBigInt64(i, BigInt(flexLane.tick), true)
		view.setBigInt64(i + 8, BigInt(flexLane.length), true)
		view.setUint8(i + 16, flexLane.isDouble ? 1 : 0)
		i += 17
	}
	view.setInt32(i, drumFreestyleSectionData.length, true)
	i += 4
	for (const drumFreestyleSection of drumFreestyleSectionData) {
		view.setBigInt64(i, BigInt(drumFreestyleSection.tick), true)
		view.setBigInt64(i + 8, BigInt(drumFreestyleSection.length), true)
		view.setUint8(i + 16, drumFreestyleSection.isCoda ? 1 : 0)
		i += 17
	}
	view.setInt32(i, notesData.length, true)
	i += 4
	for (const note of notesData) {
		view.setBigInt64(i, BigInt(note.tick), true)
		view.setBigInt64(i + 8, BigInt(note.length), true)
		view.setUint32(i + 16, note.type, true)
		view.setUint32(i + 20, note.flags, true)
		i += 24
	}

	return { hash: base64url.stringify(blake3(uint8Array)), btrack: uint8Array }
}

export function pruneEmptyPhrases<T extends { tick: number; length: number }>(
	phrases: T[],
	notes: ParsedChart['trackData'][number]['noteEventGroups'],
) {
	const nonemptyPhrases: T[] = []

	let noteIndex = 0
	for (const phrase of phrases) {
		while (noteIndex < notes.length && notes[noteIndex][0].tick < phrase.tick) {
			noteIndex++
		}

		if (noteIndex < notes.length && notes[noteIndex][0].tick < phrase.tick + (phrase.length || 1)) {
			nonemptyPhrases.push(phrase)
		}
	}

	return nonemptyPhrases
}
