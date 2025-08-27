import * as _ from 'lodash'

import { Difficulty, Instrument } from 'src/interfaces'
import { getEncoding } from 'src/utils'
import { EventType, eventTypes, RawChartData } from './note-parsing-interfaces'

/* eslint-disable @typescript-eslint/naming-convention */
type TrackName = keyof typeof trackNameMap
const trackNameMap = {
	ExpertSingle: { instrument: 'guitar', difficulty: 'expert' },
	HardSingle: { instrument: 'guitar', difficulty: 'hard' },
	MediumSingle: { instrument: 'guitar', difficulty: 'medium' },
	EasySingle: { instrument: 'guitar', difficulty: 'easy' },

	ExpertDoubleGuitar: { instrument: 'guitarcoop', difficulty: 'expert' },
	HardDoubleGuitar: { instrument: 'guitarcoop', difficulty: 'hard' },
	MediumDoubleGuitar: { instrument: 'guitarcoop', difficulty: 'medium' },
	EasyDoubleGuitar: { instrument: 'guitarcoop', difficulty: 'easy' },

	ExpertDoubleRhythm: { instrument: 'rhythm', difficulty: 'expert' },
	HardDoubleRhythm: { instrument: 'rhythm', difficulty: 'hard' },
	MediumDoubleRhythm: { instrument: 'rhythm', difficulty: 'medium' },
	EasyDoubleRhythm: { instrument: 'rhythm', difficulty: 'easy' },

	ExpertDoubleBass: { instrument: 'bass', difficulty: 'expert' },
	HardDoubleBass: { instrument: 'bass', difficulty: 'hard' },
	MediumDoubleBass: { instrument: 'bass', difficulty: 'medium' },
	EasyDoubleBass: { instrument: 'bass', difficulty: 'easy' },

	ExpertDrums: { instrument: 'drums', difficulty: 'expert' },
	HardDrums: { instrument: 'drums', difficulty: 'hard' },
	MediumDrums: { instrument: 'drums', difficulty: 'medium' },
	EasyDrums: { instrument: 'drums', difficulty: 'easy' },

	ExpertKeyboard: { instrument: 'keys', difficulty: 'expert' },
	HardKeyboard: { instrument: 'keys', difficulty: 'hard' },
	MediumKeyboard: { instrument: 'keys', difficulty: 'medium' },
	EasyKeyboard: { instrument: 'keys', difficulty: 'easy' },

	ExpertGHLGuitar: { instrument: 'guitarghl', difficulty: 'expert' },
	HardGHLGuitar: { instrument: 'guitarghl', difficulty: 'hard' },
	MediumGHLGuitar: { instrument: 'guitarghl', difficulty: 'medium' },
	EasyGHLGuitar: { instrument: 'guitarghl', difficulty: 'easy' },

	ExpertGHLCoop: { instrument: 'guitarcoopghl', difficulty: 'expert' },
	HardGHLCoop: { instrument: 'guitarcoopghl', difficulty: 'hard' },
	MediumGHLCoop: { instrument: 'guitarcoopghl', difficulty: 'medium' },
	EasyGHLCoop: { instrument: 'guitarcoopghl', difficulty: 'easy' },

	ExpertGHLRhythm: { instrument: 'rhythmghl', difficulty: 'expert' },
	HardGHLRhythm: { instrument: 'rhythmghl', difficulty: 'hard' },
	MediumGHLRhythm: { instrument: 'rhythmghl', difficulty: 'medium' },
	EasyGHLRhythm: { instrument: 'rhythmghl', difficulty: 'easy' },

	ExpertGHLBass: { instrument: 'bassghl', difficulty: 'expert' },
	HardGHLBass: { instrument: 'bassghl', difficulty: 'hard' },
	MediumGHLBass: { instrument: 'bassghl', difficulty: 'medium' },
	EasyGHLBass: { instrument: 'bassghl', difficulty: 'easy' },
} as const
/* eslint-enable @typescript-eslint/naming-convention */

const discoFlipDifficultyMap = ['easy', 'medium', 'hard', 'expert'] as const

/**
 * Parses `buffer` as a chart in the .chart format. Returns all the note data in `RawChartData`, but any
 * chart format rules that apply to both .chart and .mid have not been applied. This is a partial result
 * that can be produced by both the .chart and .mid formats so that the remaining chart rules can be parsed
 * without code duplication.
 *
 * Throws an exception if `buffer` could not be parsed as a chart in the .chart format.
 *
 * Note: these features of .chart are ignored (for now)
 * Versus phrase markers
 * Tempo anchors
 * GH1 hand animation markers
 * Audio file paths in metadata
 */
export function parseNotesFromChart(data: Uint8Array): RawChartData {
	const encoding = getEncoding(data)
	const decoder = new TextDecoder(encoding)
	const chartText = decoder.decode(data)

	const fileSections = getFileSections(chartText)
	if (_.values(fileSections).length === 0) {
		throw 'Invalid .chart file: no sections were found.'
	}

	const metadata = _.chain(fileSections['Song'])
		.map(line => /^(.+?) = "?(.*?)"?$/.exec(line))
		.compact()
		.map(([, key, value]) => [key, value])
		.fromPairs()
		.value()

	const resolution = Number(metadata['Resolution'])
	if (!resolution) {
		throw 'Invalid .chart file: resolution not found.'
	}

	const codaEvents = _.chain(fileSections['Events'])
		.map(line => /^(\d+) = E "\s*\[?coda\]?\s*"$/.exec(line))
		.compact()
		.map(([, stringTick]) => ({ tick: Number(stringTick) }))
		.value()
	const firstCodaTick = codaEvents[0] ? codaEvents[0].tick : null

	return {
		chartTicksPerBeat: resolution,
		metadata: {
			name: metadata['Name'] || undefined,
			artist: metadata['Artist'] || undefined,
			album: metadata['Album'] || undefined,
			genre: metadata['Genre'] || undefined,
			year: metadata['Year']?.slice(2) || undefined, // Thank you GHTCP, very cool
			charter: metadata['Charter'] || undefined,
			diff_guitar: Number(metadata['Difficulty']) || undefined,
			// "Offset" and "PreviewStart" are in units of seconds
			delay: Number(metadata['Offset']) ? Number(metadata['Offset']) * 1000 : undefined,
			preview_start_time: Number(metadata['PreviewStart']) ? Number(metadata['PreviewStart']) * 1000 : undefined,
		},
		hasLyrics: !!fileSections['Events']?.find(line => line.includes('"lyric ')),
		hasVocals: false, // Vocals are unsupported in .chart
		tempos: _.chain(fileSections['SyncTrack'])
			.map(line => /^(\d+) = B (\d+)$/.exec(line))
			.compact()
			.map(([, stringTick, stringMillibeatsPerMinute]) => ({
				tick: Number(stringTick),
				beatsPerMinute: Number(stringMillibeatsPerMinute) / 1000,
			}))
			.tap(tempos => {
				const zeroTempo = tempos.find(tempo => tempo.beatsPerMinute === 0)
				if (zeroTempo) {
					throw `Invalid .chart file: Tempo at tick ${zeroTempo.tick} was zero.`
				}
				if (!tempos[0] || tempos[0].tick !== 0) {
					tempos.unshift({ tick: 0, beatsPerMinute: 120 })
				}
			})
			.value(),
		timeSignatures: _.chain(fileSections['SyncTrack'])
			.map(line => /^(\d+) = TS (\d+)(?: (\d+))?$/.exec(line))
			.compact()
			.map(([, stringTick, stringNumerator, stringDenominatorExp]) => ({
				tick: Number(stringTick),
				numerator: Number(stringNumerator),
				denominator: stringDenominatorExp ? Math.pow(2, Number(stringDenominatorExp)) : 4,
			}))
			.tap(timeSignatures => {
				const zeroTimeSignatureN = timeSignatures.find(timeSignature => timeSignature.numerator === 0)
				const zeroTimeSignatureD = timeSignatures.find(timeSignature => timeSignature.denominator === 0)
				if (zeroTimeSignatureN) {
					throw `Invalid .mid file: Time signature numerator at tick ${zeroTimeSignatureN.tick} was zero.`
				}
				if (zeroTimeSignatureD) {
					throw `Invalid .mid file: Time signature denominator at tick ${zeroTimeSignatureD.tick} was zero.`
				}
				if (!timeSignatures[0] || timeSignatures[0].tick !== 0) {
					timeSignatures.unshift({ tick: 0, numerator: 4, denominator: 4 })
				}
			})
			.value(),
		sections: _.chain(fileSections['Events'])
			.map(line => /^(\d+) = E "\[?(?:section|prc)[ _](.*?)\]?"$/.exec(line))
			.compact()
			.map(([, stringTick, stringName]) => ({
				tick: Number(stringTick),
				name: stringName,
			}))
			.value(),
		endEvents: _.chain(fileSections['Events'])
			.map(line => /^(\d+) = E "\[?end\]?"$/.exec(line))
			.compact()
			.map(([, stringTick]) => ({
				tick: Number(stringTick),
			}))
			.value(),
		trackData: _.chain(fileSections)
			.pick(_.keys(trackNameMap))
			.toPairs()
			.map(([trackName, lines]) => {
				const { instrument, difficulty } = trackNameMap[trackName as TrackName]
				const trackEvents = _.chain(lines)
					.map(line => /^(\d+) = ([A-Z]+) ([\w\s[\]]+?)( \d+)?$/.exec(line))
					.compact()
					.map(([, tickString, typeCode, value, lengthString]) => {
						const type = getEventType(typeCode, value, instrument, difficulty)
						return type !== null ? { tick: Number(tickString), type, length: Number(lengthString) || 0 } : null
					})
					.compact()
					.orderBy('tick') // Most parsers reject charts that aren't already sorted, but it's easier to just sort it here
					.thru(events => mergeSoloEvents(events))
					.value()
				const result: RawChartData['trackData'][number] = {
					instrument,
					difficulty,
					starPowerSections: [],
					rejectedStarPowerSections: [],
					soloSections: [],
					flexLanes: [],
					drumFreestyleSections: [],
					trackEvents: [],
				}

				for (const event of trackEvents) {
					if (event.type === eventTypes.starPower) {
						result.starPowerSections.push(event)
					} else if (event.type === eventTypes.rejectedStarPower) {
						result.rejectedStarPowerSections.push(event)
					} else if (event.type === eventTypes.soloSection) {
						result.soloSections.push(event)
					} else if (event.type === eventTypes.flexLaneSingle || event.type === eventTypes.flexLaneDouble) {
						result.flexLanes.push({
							tick: event.tick,
							length: event.length,
							isDouble: event.type === eventTypes.flexLaneDouble,
						})
					} else if (event.type === eventTypes.freestyleSection) {
						result.drumFreestyleSections.push({
							tick: event.tick,
							length: event.length,
							isCoda: firstCodaTick === null ? false : event.tick >= firstCodaTick,
						})
					} else {
						result.trackEvents.push(event)
					}
				}

				return result
			})
			.value(),
	}
}

function getFileSections(chartText: string) {
	const sections: { [sectionName: string]: string[] } = {}
	let skipLine = false
	let readStartIndex = 0
	let readingSection = false
	let thisSection: string | null = null
	for (let i = 0; i < chartText.length; i++) {
		if (readingSection) {
			if (chartText[i] === ']') {
				readingSection = false
				thisSection = chartText.slice(readStartIndex, i)
			}
			if (chartText[i] === '\n') {
				throw `Invalid .chart file: unexpected new line when parsing section at index ${i}`
			}
			continue // Keep reading section until it ends
		}

		if (chartText[i] === '=') {
			skipLine = true
		} // Skip all user-entered values
		if (chartText[i] === '\n') {
			skipLine = false
		}
		if (skipLine) {
			continue
		} // Keep skipping until '\n' is found

		if (chartText[i] === '{') {
			skipLine = true
			readStartIndex = i + 1
		} else if (chartText[i] === '}') {
			if (!thisSection) {
				throw `Invalid .chart file: end of section reached before a section name was found at index ${i}`
			}
			// Trim each line because of Windows \r\n shenanigans
			sections[thisSection] = chartText
				.slice(readStartIndex, i)
				.split('\n')
				.map(line => line.trim())
				.filter(line => line.length)
		} else if (chartText[i] === '[') {
			readStartIndex = i + 1
			readingSection = true
		}
	}

	return sections
}

function getEventType(typeCode: string, value: string, instrument: Instrument, difficulty: Difficulty): EventType | null {
	switch (typeCode) {
		case 'E': {
			switch (value) {
				case 'solo':
					return eventTypes.soloSectionStart
				case 'soloend':
					return eventTypes.soloSectionEnd
				default: {
					const match = value.match(/^\s*\[?mix[ _]([0-3])[ _]drums([0-5])(d|dnoflip|easy|easynokick|)\]?\s*$/)
					if (match) {
						const diff = discoFlipDifficultyMap[Number(match[1])]
						const flag = match[3] as 'd' | 'dnoflip' | 'easy' | 'easynokick' | ''
						if ((flag === '' || flag === 'd' || flag === 'dnoflip') && difficulty === diff) {
							return (
								flag === '' ? eventTypes.discoFlipOff
								: flag === 'd' ? eventTypes.discoFlipOn
								: eventTypes.discoNoFlipOn
							)
						}
					}
					return null
				}
			}
		}
		case 'S': {
			switch (value) {
				case '2':
					return eventTypes.starPower
				case '64':
					return eventTypes.freestyleSection
				case '65':
					return eventTypes.flexLaneSingle
				case '66':
					return eventTypes.flexLaneDouble
				default:
					return null
			}
		}
		case 'N': {
			switch (instrument) {
				case 'drums': {
					switch (value) {
						case '0':
							return eventTypes.kick
						case '1':
							return eventTypes.redDrum
						case '2':
							return eventTypes.yellowDrum
						case '3':
							return eventTypes.blueDrum
						case '4':
							return eventTypes.fiveOrangeFourGreenDrum
						case '5':
							return eventTypes.fiveGreenDrum
						case '32':
							return eventTypes.kick2x
						case '34':
							return eventTypes.redAccent
						case '35':
							return eventTypes.yellowAccent
						case '36':
							return eventTypes.blueAccent
						case '37':
							return eventTypes.fiveOrangeFourGreenAccent
						case '38':
							return eventTypes.fiveGreenAccent
						case '40':
							return eventTypes.redGhost
						case '41':
							return eventTypes.yellowGhost
						case '42':
							return eventTypes.blueGhost
						case '43':
							return eventTypes.fiveOrangeFourGreenGhost
						case '44':
							return eventTypes.fiveGreenGhost
						case '66':
							return eventTypes.yellowCymbalMarker
						case '67':
							return eventTypes.blueCymbalMarker
						case '68':
							return eventTypes.greenCymbalMarker
						default:
							return null
					}
				}
				case 'guitarghl':
				case 'guitarcoopghl':
				case 'rhythmghl':
				case 'bassghl': {
					switch (value) {
						case '0':
							return eventTypes.white1
						case '1':
							return eventTypes.white2
						case '2':
							return eventTypes.white3
						case '3':
							return eventTypes.black1
						case '4':
							return eventTypes.black2
						case '5':
							return eventTypes.forceUnnatural
						case '6':
							return eventTypes.forceTap
						case '7':
							return eventTypes.open
						case '8':
							return eventTypes.black3
						default:
							return null
					}
				}
				default: {
					switch (value) {
						case '0':
							return eventTypes.green
						case '1':
							return eventTypes.red
						case '2':
							return eventTypes.yellow
						case '3':
							return eventTypes.blue
						case '4':
							return eventTypes.orange
						case '5':
							return eventTypes.forceUnnatural
						case '6':
							return eventTypes.forceTap
						case '7':
							return eventTypes.open
						default:
							return null
					}
				}
			}
		}
		default:
			return null
	}
}

/**
 * Merge `solo` and `soloend` events into `EventType.soloSection`.
 *
 * Note: .chart specs say that notes in the last tick of the solo section are included, unlike most phrases.
 * This is normalized here by increasing the length by 1.
 */
function mergeSoloEvents(events: { tick: number; type: EventType; length: number }[]) {
	const soloSectionStartEvents: { tick: number; type: EventType; length: number }[] = []

	for (const event of events) {
		if (event.type === eventTypes.soloSectionStart) {
			soloSectionStartEvents.push(event)
		} else if (event.type === eventTypes.soloSectionEnd) {
			const lastSoloSectionStartEvent = soloSectionStartEvents.pop()
			if (lastSoloSectionStartEvent) {
				lastSoloSectionStartEvent.type = eventTypes.soloSection
				lastSoloSectionStartEvent.length = event.tick - lastSoloSectionStartEvent.tick + 1
			}
		}
	}

	_.remove(events, event => event.type === eventTypes.soloSectionStart || event.type === eventTypes.soloSectionEnd)

	return events
}
