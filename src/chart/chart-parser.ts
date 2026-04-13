import * as _ from 'lodash'

import { Difficulty, Instrument } from 'src/interfaces'
import { getEncoding } from 'src/utils'
import { EventType, eventTypes, RawChartData } from './note-parsing-interfaces'
import { extractChartLyrics, extractChartVocalPhrases } from './lyric-parser'

/**
 * Resolve a .chart section name like "ExpertDoubleDrums" into an instrument
 * + difficulty pair. Matches YARG.Core's ChartReader logic: scan for a
 * difficulty prefix ("Expert", "Hard", "Medium", "Easy") then match the
 * suffix against the instrument suffix table (Single, DoubleGuitar,
 * DoubleBass, DoubleRhythm, Drums, Keyboard, GHL*). Returns null if no match.
 */
/**
 * Replicate YARG.Core's `FastInt32Parse`:
 * ```
 * int value = 0;
 * foreach (char c in text) value = value * 10 + (c - '0');
 * ```
 * This intentionally has no error handling — for a non-digit character, it
 * produces a negative "digit" (c - 48) that folds into the accumulator. YARG
 * then casts the result to `uint` for the tick value, which wraps negative
 * int32 values into their two's-complement uint32 equivalents. We match that
 * by applying `>>> 0` (unsigned right shift by 0) to the final value, which
 * JavaScript uses for int32 → uint32 conversion.
 */

/**
 * Parse a .chart [Events] event text as a section event, matching YARG's
 * TextEvents.NormalizeTextEvent → TryParseSectionEvent pipeline.
 * Returns the section name, or null if not a section.
 */
function parseChartSectionEventText(innerText: string): string | null {
	// NormalizeTextEvent: if there's both `[` and `]`, return content between
	// the FIRST `[` and FIRST `]` (trimmed). Otherwise trim.
	let text = innerText
	const openIdx = text.indexOf('[')
	const closeIdx = text.indexOf(']')
	if (openIdx >= 0 && closeIdx >= 0 && openIdx <= closeIdx) {
		text = text.slice(openIdx + 1, closeIdx)
	}
	text = text.replace(/^[\s\r\n]+|[\s\r\n]+$/g, '')

	// TryParseSectionEvent: strip "section" or "prc" prefix
	let name: string
	if (text.startsWith('section')) {
		name = text.slice('section'.length)
	} else if (text.startsWith('prc')) {
		name = text.slice('prc'.length)
	} else {
		return null
	}

	// TrimStart('_').Trim()
	while (name.length > 0 && name[0] === '_') name = name.slice(1)
	name = name.replace(/^[\s\r\n]+|[\s\r\n]+$/g, '')

	if (name.length === 0) return null
	return name
}

function resolveChartTrackName(sectionName: string): { instrument: Instrument; difficulty: Difficulty } | null {
	const difficulties: { prefix: string; difficulty: Difficulty }[] = [
		{ prefix: 'Expert', difficulty: 'expert' },
		{ prefix: 'Hard', difficulty: 'hard' },
		{ prefix: 'Medium', difficulty: 'medium' },
		{ prefix: 'Easy', difficulty: 'easy' },
	]
	const instruments: { suffix: string; instrument: Instrument }[] = [
		// Order matters: longer/more specific suffixes first so "DoubleGuitar"
		// doesn't get matched by plain "Guitar", etc.
		{ suffix: 'DoubleGuitar', instrument: 'guitarcoop' },
		{ suffix: 'DoubleBass', instrument: 'bass' },
		{ suffix: 'DoubleRhythm', instrument: 'rhythm' },
		{ suffix: 'GHLGuitar', instrument: 'guitarghl' },
		{ suffix: 'GHLBass', instrument: 'bassghl' },
		{ suffix: 'GHLRhythm', instrument: 'rhythmghl' },
		{ suffix: 'GHLCoop', instrument: 'guitarcoopghl' },
		{ suffix: 'Keyboard', instrument: 'keys' },
		{ suffix: 'Drums', instrument: 'drums' },
		{ suffix: 'Single', instrument: 'guitar' },
	]
	for (const { prefix, difficulty } of difficulties) {
		if (!sectionName.startsWith(prefix)) continue
		for (const { suffix, instrument } of instruments) {
			if (sectionName.endsWith(suffix)) {
				return { instrument, difficulty }
			}
		}
		return null
	}
	return null
}

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

	ExpertGHLKeys: { instrument: 'keysghl', difficulty: 'expert' },
	HardGHLKeys: { instrument: 'keysghl', difficulty: 'hard' },
	MediumGHLKeys: { instrument: 'keysghl', difficulty: 'medium' },
	EasyGHLKeys: { instrument: 'keysghl', difficulty: 'easy' },
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

	// Filter the [Events] section using YARG's strict-ordering + malformed-
	// line blackhole logic. YARG's ChartReader iterates [Events] line-by-line:
	// for each line, it calls FastInt32Parse on the tick text (the text
	// before '='), then throws "tick went backwards" if the new tick is
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
		vocalTracks: {
			vocals: {
				lyrics: extractChartLyrics(fileSections['Events'] ?? []),
				vocalPhrases: extractChartVocalPhrases(fileSections['Events'] ?? []),
				notes: [],
				starPowerSections: [],
				rangeShifts: [],
				lyricShifts: [],
				staticLyricPhrases: [],
				textEvents: [],
			},
		},
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
		// Two forms exist in the wild:
		//   0 = E "section Foo"              — unwrapped
		//   0 = E "[section Foo]"            — wrapped in outer brackets
		// The section name itself can ALSO contain brackets, e.g.
		//   0 = E "section Intro A [Hypnotherapist]"  ← NOT the outer-wrapped form
		// We must only strip a trailing `]` when we actually saw a leading `[`,
		// otherwise we eat the last character of sections whose name ends with `]`.
		// Section extraction. YARG's flow:
		//   1. SplitOnce('=') → tickText + remaining
		//   2. Skip whitespace, read `E`
		//   3. `remaining.TrimOnce('"').Trim()` → strips ONE leading and ONE
		//      trailing `"`, then trims ASCII whitespace (including `\r`)
		//   4. NormalizeTextEvent on the result
		//   5. TryParseSectionEvent → strip `section`/`prc` prefix + `_` + trim
		// We must replicate this to handle:
		//   - Sections whose names contain embedded `"` like `section "Verse"`
		//   - Embedded `\r` from Windows line endings
		//   - The full NormalizeTextEvent bracket-stripping logic
		sections: _.chain(fileSections['Events'])
			.map(line => {
				// Match the raw line: `<tick> = E "<content>"`. Use
				// `[\s\S]*` so `\r` inside the content doesn't break the
				// match (`.` doesn't match `\r` in JS regex).
				const m = /^(\d+) = E "([\s\S]*)"$/.exec(line)
				if (!m) return null
				const tick = m[1]
				// TrimOnce already stripped the outer quotes via our regex.
				// Apply trim (eats trailing `\r`) then NormalizeTextEvent +
				// TryParseSectionEvent to extract the section name.
				const inner = m[2].replace(/[\s\r\n]+$/, '').replace(/^[\s\r\n]+/, '')
				const name = parseChartSectionEventText(inner)
				return name !== null ? { tick, name } : null
			})
			.compact()
			.map(({ tick, name }) => ({
				tick: Number(tick),
				name,
			}))
			.value(),
		endEvents: _.chain(fileSections['Events'])
			.map(line => /^(\d+) = E "\[?end\]?"$/.exec(line))
			.compact()
			.map(([, stringTick]) => ({
				tick: Number(stringTick),
			}))
			.value(),
		globalEvents: extractChartGlobalEvents(fileSections['Events'] ?? []),
		venue: [], // VENUE is MIDI-only
		trackData: _.chain(fileSections)
			.pickBy((_lines, sectionName) =>
				// Match YARG.Core's ChartReader: accept any section whose name
				// starts with a difficulty ("Expert", "Hard", "Medium", "Easy")
				// AND ends with a known instrument string. This handles typos
				// and non-standard names like "ExpertDoubleDrums" (Megadeth -
				// Bite the Hand) which YARG parses as "Expert" + "Drums".
				resolveChartTrackName(sectionName) !== null,
			)
			.toPairs()
			.map(([trackName, lines]) => {
				const resolved = resolveChartTrackName(trackName)!
				const { instrument, difficulty } = resolved
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

				// Extract text events: E events not consumed by getEventType (solo, disco flip)
				const textEvents = extractChartTrackTextEvents(lines)

				// Extract versus phrases: S 0 (player 1), S 1 (player 2)
				const versusPhrases = extractChartVersusPhrases(lines)

				const result: RawChartData['trackData'][number] = {
					instrument,
					difficulty,
					starPowerSections: [],
					rejectedStarPowerSections: [],
					soloSections: [],
					glissandoSections: [],
					flexLanes: [],
					drumFreestyleSections: [],
					trackEvents: [],
					textEvents,
					handMaps: [],     // HandMap/StrumMap/CharacterState are rare in .chart
					strumMaps: [],
					characterStates: [],
					versusPhrases,
					animations: [],
					proKeysRangeShifts: [],
					rawNotes: [],
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
 * Matches YARG.Core's ChartReader solo handling: tracks at most one "next
 * start", so when a `soloend` closes the current solo, the outermost
 * currently-open `solo` wins. Multiple nested `solo` events inside an open
 * solo are treated as no-ops (only the first contributes to the resulting
 * phrase). `.chart` specs treat `soloend` as inclusive, so length is
 * soloendTick - startTick + 1 (except when a next `solo` lands on the same
 * tick as the `soloend`, in which case the existing solo closes exclusively
 * and the new one opens immediately).
 */
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

/** Regex for disco flip mix events consumed by getEventType. */
const chartDiscoFlipRegex = /^\s*\[?mix[ _][0-3][ _]drums[0-5](d|dnoflip|easy|easynokick|)\]?\s*$/

/**
 * Extract text events from .chart instrument section lines.
 * Captures E events that aren't consumed by getEventType (solo, soloend, disco flip)
 * or by other chart processing logic (ENABLE_CHART_DYNAMICS, ENHANCED_OPENS).
 */
function extractChartTrackTextEvents(lines: string[]): { tick: number; text: string }[] {
	const textEvents: { tick: number; text: string }[] = []
	for (const line of lines) {
		const match = /^(\d+) = E ([^\r\n]+?)$/.exec(line)
		if (!match) continue
		const text = match[2]
		// Skip events consumed by getEventType
		if (text === 'solo' || text === 'soloend') continue
		if (chartDiscoFlipRegex.test(text)) continue
		// Skip directives consumed by chart processing (not stored as text events)
		const stripped = text.replace(/^\[/, '').replace(/\]$/, '').trim()
		if (stripped === 'ENABLE_CHART_DYNAMICS' || stripped === 'ENHANCED_OPENS') continue
		textEvents.push({ tick: Number(match[1]), text })
	}
	return textEvents
}

/**
 * Extract versus phrases from .chart instrument section lines.
 * S 0 = player 1, S 1 = player 2.
 */
function extractChartVersusPhrases(lines: string[]): { tick: number; length: number; isPlayer2: boolean }[] {
	const phrases: { tick: number; length: number; isPlayer2: boolean }[] = []
	for (const line of lines) {
		const match = /^(\d+) = S ([01]) (\d+)$/.exec(line)
		if (!match) continue
		phrases.push({
			tick: Number(match[1]),
			length: Number(match[3]),
			isPlayer2: match[2] === '1',
		})
	}
	return phrases
}

/** Patterns for .chart [Events] lines already extracted into dedicated fields. */
const chartSectionRegex = /^(\d+) = E "\[?(?:section|prc)[ _]/
const chartEndRegex = /^(\d+) = E "\[?end\]?"$/
const chartCodaRegex = /^(\d+) = E "\s*\[?coda\]?\s*"$/
const chartLyricRegex = /^(\d+) = E "\s*lyric[ \t]/
const chartPhraseRegex = /^(\d+) = E "(?:phrase_start|phrase_end)"$/

/**
 * Extract global text events from .chart [Events] section, excluding events
 * already extracted into sections, endEvents, and vocalTracks (lyrics, phrases).
 * Coda events are included (consumers use them for gameplay and venue).
 *
 * Section filtering uses `parseChartSectionEventText` rather than a strict
 * regex so it matches exactly the same lines the section extractor accepts
 * (including typos like "sections Pre-Chorus 1" and "sectionwa Chorus 2B"
 * where YARG's `StartsWith("section")` happily strips the prefix and leaves
 * garbage in the name). Without this alignment, those lines get duplicated
 * as both a parsed section AND a raw global-event text.
 */
function extractChartGlobalEvents(eventLines: string[]): { tick: number; text: string }[] {
	const globalEvents: { tick: number; text: string }[] = []
	for (const line of eventLines) {
		const match = /^(\d+) = E "([\s\S]*)"$/.exec(line)
		if (!match) continue
		const tick = Number(match[1])
		const text = match[2]
		// Classify using the same normalize+section pipeline the section
		// extractor uses so both agree on what "looks like a section".
		const inner = text.replace(/^[\s\r\n]+|[\s\r\n]+$/g, '')
		if (parseChartSectionEventText(inner) !== null) continue
		if (chartEndRegex.test(line)) continue
		if (chartLyricRegex.test(line)) continue
		if (chartPhraseRegex.test(line)) continue
		globalEvents.push({ tick, text })
	}
	// Sort by (tick, text) for deterministic ordering so round-trips don't
	// diverge on charts that store same-tick globalEvents in file order.
	globalEvents.sort((a, b) => a.tick - b.tick || a.text.localeCompare(b.text))
	return globalEvents
}

