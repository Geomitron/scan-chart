import { Difficulty, Instrument } from '../types'
import { decodeCloneHeroText } from '../shared/decode-text'
import { trimDotnet } from '../shared/text'
import { ChartEncoding, decodeChartText, detectChartEncoding } from './chart-encoding'
import { ChartEventSection, chartLineSpelling, readableChartLines } from './chart-line-spelling'
import type { ParseRules } from './parse-rules'
import { EventType, eventTypes, RawChartData } from './raw-types'
import { extractChartLyrics, extractChartVocalPhrases } from './lyric-parser'

/* eslint-disable @typescript-eslint/naming-convention */
type TrackName = keyof typeof trackNameMap

/** The `.chart` section name of an instrument and difficulty, such as `ExpertSingle` for Expert guitar. */
export function chartSectionName(instrument: Instrument, difficulty: Difficulty): string {
	const name = (Object.keys(trackNameMap) as TrackName[]).find(key => trackNameMap[key].instrument === instrument && trackNameMap[key].difficulty === difficulty)
	if (name === undefined) throw new RangeError(`A .chart file has no section for ${difficulty} ${instrument}`)
	return name
}

/** The instrument and difficulty a `.chart` section holds, or `null` for a section that isn't a track. */
export function chartSectionTrack(sectionName: string): { instrument: Instrument; difficulty: Difficulty } | null {
	return Object.prototype.hasOwnProperty.call(trackNameMap, sectionName) ? trackNameMap[sectionName as TrackName] as { instrument: Instrument; difficulty: Difficulty } : null
}

/** The resolution a reader uses for a `.chart` file that doesn't give one. */
export const defaultChartResolution = 192

/** Which kind of event section a `.chart` section is, or `null` for `[Song]` and sections readers ignore. */
export function chartEventSection(sectionName: string): ChartEventSection | null {
	if (sectionName === 'SyncTrack') return 'sync'
	if (sectionName === 'Events') return 'events'
	return chartSectionTrack(sectionName) === null ? null : 'track'
}

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
 * `[Song]` keys that a typed metadata field claims. Anything outside this set
 * is preserved on `metadata.extraChartSongFields` so it round-trips verbatim
 * (deprecated Moonscraper / GHTCP fields, audio stream filenames, `Player2`,
 * `HoPo`, etc.). `Resolution` is not a metadata field but is
 * claimed here because it's emitted separately from the chart's tick-rate.
 */
const CLAIMED_SONG_KEYS = new Set<string>([
	'Resolution',
	'Name', 'Artist', 'Album', 'Genre', 'Year', 'Charter',
	'Difficulty', 'Offset', 'PreviewStart', 'PreviewEnd',
])

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
	return classifyChartFile(readChartFile(data))
}

/** A `.chart` file's sections by name, each as its trimmed, nonblank lines. */
export type ChartFileSections = { [sectionName: string]: string[] }

/** One `[name] { ... }` section of a `.chart` file. `bodyStart` and `bodyEnd` are offsets in the decoded text. */
export interface ChartSectionToken {
	readonly name: string
	readonly bodyStart: number
	readonly bodyEnd: number
}

/** A `.chart` file as read, kept whole so an unedited file is written back byte for byte. */
export interface ChartFileTokens {
	readonly bytes: Uint8Array
	readonly encoding: ChartEncoding
	/** The decoded text, without the byte-order mark. */
	readonly text: string
	/** Every section in file order, duplicates included. */
	readonly sections: readonly ChartSectionToken[]
	/** Why the file isn't a valid `.chart`, found while finding its sections; reported when it is classified. */
	readonly structureError: string | null
}

/** Tokenizes a `.chart` file. Never throws: a malformed file keeps its error for classification to report. */
export function tokenizeChartFile(bytes: Uint8Array): ChartFileTokens {
	const { encoding, bomLength } = detectChartEncoding(bytes)
	const text = decodeChartText(bytes.subarray(bomLength), encoding)
	return { bytes, encoding, text, ...findChartSections(text) }
}

/**
 * Reads a tokenized `.chart` file's sections by name. A repeated name takes its first body: a file must not repeat a
 * name, and a reader of one that does uses the first section with it.
 *
 * Throws an exception if the file is malformed or has no sections.
 */
export function chartFileSections(tokens: ChartFileTokens): ChartFileSections {
	if (tokens.structureError !== null) throw tokens.structureError
	const fileSections: ChartFileSections = {}
	for (const section of tokens.sections) {
		if (Object.prototype.hasOwnProperty.call(fileSections, section.name)) continue
		fileSections[section.name] = splitTrimmedNonEmptyLines(tokens.text, section.bodyStart, section.bodyEnd)
	}
	if (Object.keys(fileSections).length === 0) {
		throw 'Invalid .chart file: no sections were found.'
	}
	return fileSections
}

/**
 * Reads a tokenized `.chart` file's sections by name like `chartFileSections`, with the same keys in the same order,
 * but splits a section into lines only when it is first read. `bodies` gets each name's body text.
 *
 * Throws an exception if the file is malformed or has no sections.
 */
export function lazyChartFileSections(tokens: ChartFileTokens, bodies?: Map<string, string>): ChartFileSections {
	if (tokens.structureError !== null) throw tokens.structureError
	const firstOfName = new Map<string, ChartSectionToken>()
	for (const section of tokens.sections) if (!firstOfName.has(section.name)) firstOfName.set(section.name, section)
	if (firstOfName.size === 0) throw 'Invalid .chart file: no sections were found.'
	const fileSections: ChartFileSections = {}
	for (const [name, section] of firstOfName) {
		bodies?.set(name, tokens.text.slice(section.bodyStart, section.bodyEnd))
		let lines: string[] | undefined
		Object.defineProperty(fileSections, name, {
			enumerable: true,
			get: () => lines ??= splitTrimmedNonEmptyLines(tokens.text, section.bodyStart, section.bodyEnd),
		})
	}
	return fileSections
}

/**
 * Reads a `.chart` file into its sections.
 *
 * Throws an exception if the file is malformed or has no sections.
 */
export function readChartFile(data: Uint8Array): ChartFileSections {
	return chartFileSections(tokenizeChartFile(data))
}

/**
 * Classifies a `.chart` file's sections into chart data. The one rule that differs between profiles before the notes
 * are resolved is `nonstandardLines`: whether a nonstandard line is read as what it probably means.
 *
 * Throws an exception if the resolution isn't a positive number, or is missing and `nonstandardLines` is `ignored`.
 */
export function classifyChartFile(
	fileSections: ChartFileSections,
	classifySection: ChartSectionClassifier = (_name, _coda, classify) => classify(),
	nonstandardLines: ParseRules['chartNonstandardLines'] = 'read',
): RawChartData {
	const fileSectionKeys = Object.keys(fileSections)
	// The lines as scan-chart reads them: a nonstandard line that has a probable meaning is read as its standard
	// spelling (chart-line-spelling.ts).
	const readable = (lines: string[], section: 'sync' | 'events' | 'song') => nonstandardLines === 'read' ? readableChartLines(lines, section) : lines
	const metadata: { [key: string]: string } = {}
	const songLines = fileSections['Song'] && readable(fileSections['Song'], 'song')
	if (songLines) {
		for (const line of songLines) {
			const m = chartSongMetaRegex.exec(line)
			if (m) metadata[m[1]] = m[2]
		}
	}

	// Without a Resolution, a reader uses 192: Clone Hero does with no [Song] section (Song.cs:59), and YARG does with
	// no Resolution in it. A value is read by its leading digits, as Clone Hero reads it (ChartReader.Header.cs,
	// WeakIntParse): `480.5` is 480 and `1e3` is 1. A value that doesn't start with a digit, or is 0, is an error.
	// The frozen profile keeps scan-chart 8's reading.
	const namesResolution = songLines?.some(line => /^Resolution[ \t]*=/.test(line)) ?? false
	const resolution = nonstandardLines === 'ignored' ? Number(metadata['Resolution'])
		: namesResolution ? Number(/^\d*/.exec(metadata['Resolution'] ?? '')![0])
		: defaultChartResolution
	if (!resolution) {
		throw 'Invalid .chart file: resolution not found.'
	}

	// Collect any [Song] keys not claimed by a typed metadata field into
	// `extraChartSongFields` so they round-trip verbatim. Parallel to how
	// `extraIniFields` preserves unknown song.ini keys.
	const extraChartSongFields: { [key: string]: string } = {}
	for (const [key, value] of Object.entries(metadata)) {
		if (CLAIMED_SONG_KEYS.has(key)) continue
		extraChartSongFields[key] = value
	}

	const eventLines = readable(fileSections['Events'] ?? [], 'events')
	if (fileSections['SyncTrack'] === undefined) throw 'Invalid .chart file: no [SyncTrack] section was found.'
	const syncLines = readable(fileSections['SyncTrack'], 'sync')

	// Classify each line of the [Events] section into one of:
	// sections, endEvents, codaEvents, or unrecognizedTextEvents (the remainder).
	const eventsScan = scanEventsSection(eventLines)
	const firstCodaTick = eventsScan.codaEvents[0]?.tick ?? null

	return {
		chartTicksPerBeat: resolution,
		metadata: {
			name: metadata['Name'] || undefined,
			artist: metadata['Artist'] || undefined,
			album: metadata['Album'] || undefined,
			genre: metadata['Genre'] || undefined,
			// GH-era charts write ", 2004" so the year reads well after the artist; Clone Hero removes that prefix.
			year: (metadata['Year']?.startsWith(', ') ? metadata['Year'].slice(2) : metadata['Year']) || undefined,
			charter: metadata['Charter'] || undefined,
			diff_band: Number(metadata['Difficulty']) || undefined,
			// "Offset", "PreviewStart" and "PreviewEnd" are in units of seconds.
			// NOTE: [Song].Offset pairs with song.ini's `delay`, and games read it only when `delay` is 0 or missing.
			// It's exposed under the `chart_offset` key so it never overwrites the ini-origin `delay` on merge.
			chart_offset: Number(metadata['Offset']) ? Number(metadata['Offset']) * 1000 : undefined,
			preview_start_time: Number(metadata['PreviewStart']) ? Number(metadata['PreviewStart']) * 1000 : undefined,
			preview_end_time: Number(metadata['PreviewEnd']) ? Number(metadata['PreviewEnd']) * 1000 : undefined,
			...(Object.keys(extraChartSongFields).length > 0 ? { extraChartSongFields } : {}),
		},
		vocalTracks: {
			vocals: {
				lyrics: extractChartLyrics(eventLines),
				vocalPhrases: extractChartVocalPhrases(eventLines),
				notes: [],
				starPowerSections: [],
				rangeShifts: [],
				lyricShifts: [],
				staticLyricPhrases: [],
				textEvents: [],
				unrecognizedMidiEvents: [],
			},
		},
		tempos: parseChartTempos(syncLines),
		timeSignatures: parseChartTimeSignatures(syncLines),
		unrecognizedSyncTrackEvents: parseChartUnrecognizedSyncTrackEvents(syncLines),
		sections: eventsScan.sections,
		endEvents: eventsScan.endEvents,
		unrecognizedEventsTrackTextEvents: eventsScan.unrecognizedTextEvents,
		parseIssues: [],
		unrecognizedMidiTracks: [], // MIDI-only
		unrecognizedEventsTrackMidiEvents: [], // MIDI-only
		unrecognizedChartSections: buildUnrecognizedChartSections(fileSections, fileSectionKeys),
		trackData: classifyChartTrackSections(fileSections, firstCodaTick, classifySection, nonstandardLines),
	}
}

export type ChartSongMetadata = { [key in 'name' | 'artist' | 'album' | 'genre' | 'year' | 'charter']?: string }

const chartSongMetadataFields = new Map<string, keyof ChartSongMetadata>([
	['Name', 'name'],
	['Artist', 'artist'],
	['Album', 'album'],
	['Genre', 'genre'],
	['Year', 'year'],
	['Charter', 'charter'],
])

/**
 * Reads song metadata as Clone Hero's `SongEntry.ReadFeedbackChartMetadata` does: the first `{}` block of the
 * file, case-sensitive keys, the first nonblank value of each key, outer quotes removed, and .NET trimming. A
 * `Name` of `TEMPO TRACK` or `midi_export` stops the reader. A leading `, ` is removed from `Year`.
 *
 * This feeds the canonical SongHash. `parseNotesFromChart` keeps its own `[Song]` reading for the scanner's
 * metadata, which writers round-trip.
 */
export function readChartSongMetadata(data: Uint8Array): ChartSongMetadata {
	const metadata: ChartSongMetadata = {}
	for (const [key, value] of readChartSongEntries(data)) {
		const field = chartSongMetadataFields.get(key)
		if (field !== undefined) metadata[field] = field === 'year' && value.startsWith(', ') ? value.slice(2) : value
	}
	return metadata
}

/**
 * Every entry of a `.chart` file's first `{}` block, as Clone Hero's `SongEntry.ReadFeedbackChartMetadata` reads it:
 * case-sensitive keys, the first nonblank value of each key, outer quotes removed, and .NET trimming. A `Name` of
 * `TEMPO TRACK` or `midi_export` stops the reader. Empty for a file that can't be decoded.
 */
export function readChartSongEntries(data: Uint8Array): ReadonlyMap<string, string> {
	const entries = new Map<string, string>()
	let text: string
	try {
		text = decodeCloneHeroText(data)
	} catch {
		return entries
	}
	let position = text.indexOf('{') + 1
	if (position === 0) return entries
	while (position < text.length) {
		while (position < text.length && ' \r\n\t'.includes(text[position])) position++
		if (position === text.length || text[position] === '}') break
		const lineEnd = findEndOfLine(text, position)
		const entry = readChartSongLine(text.slice(position, lineEnd))
		position = lineEnd + 1
		if (entry === null || entry.value === '') continue
		if (isChartSongReaderStop(entry)) break
		if (!entries.has(entry.key)) entries.set(entry.key, entry.value)
	}
	return entries
}

/** A `[Song]` line's key and value as Clone Hero reads them, or `null` for a line without `=`. */
export function readChartSongLine(line: string): { readonly key: string; readonly value: string } | null {
	const separator = line.indexOf('=')
	if (separator === -1) return null
	return { key: trimDotnet(line.slice(0, separator)), value: trimDotnet(stripOuterQuotes(trimDotnet(line.slice(separator + 1)))) }
}

/** Whether Clone Hero's `[Song]` reader stops at this entry: a `Name` of `TEMPO TRACK` or `midi_export`. */
export function isChartSongReaderStop(entry: { readonly key: string; readonly value: string }) {
	return entry.key === 'Name' && (entry.value === 'TEMPO TRACK' || entry.value === 'midi_export')
}

/** Mirrors CH `ParsingTools.FindEndOfLine`: a line ends at LF, or at CR only when LF follows it. */
function findEndOfLine(text: string, position: number) {
	for (let index = position; index < text.length; index++) {
		const char = text.charCodeAt(index)
		if (char === 10 || (char === 13 && text.charCodeAt(index + 1) === 10)) return index
	}
	return text.length
}

/** Removes the outer quote pair, or a lone quote at either end, as CH's `.chart` metadata reader does. */
function stripOuterQuotes(value: string) {
	const first = value.indexOf('"')
	if (first === -1) return value
	let last = value.lastIndexOf('"')
	if (first === last) {
		return first === 0 ? value.slice(1)
			: first === value.length - 1 ? value.slice(0, -1)
			: value
	}
	let result = value
	if (first === 0) {
		result = result.slice(1)
		last--
	}
	return last === result.length - 1 ? result.slice(0, -1) : result
}

function buildUnrecognizedChartSections(
	fileSections: { [k: string]: string[] },
	fileSectionKeys: string[],
): { name: string; lines: string[] }[] {
	const out: { name: string; lines: string[] }[] = []
	for (const name of fileSectionKeys) {
		if (name === 'Song' || name === 'SyncTrack' || name === 'Events') continue
		if (name in trackNameMap) continue
		out.push({ name, lines: [...fileSections[name]] })
	}
	return out
}

/**
 * Classifies one instrument section, by calling `classify` or by giving back an earlier classification of the same
 * section text and first coda tick. The track it returns may be changed by the caller.
 */
export type ChartSectionClassifier = (
	sectionName: string,
	firstCodaTick: number | null,
	classify: () => RawChartData['trackData'][number],
) => RawChartData['trackData'][number]

/** Classifies every instrument section, in the order classification lists tracks. */
export function classifyChartTrackSections(
	fileSections: { [k: string]: string[] },
	firstCodaTick: number | null,
	classifySection: ChartSectionClassifier,
	nonstandardLines: ParseRules['chartNonstandardLines'] = 'read',
): RawChartData['trackData'] {
	const out: RawChartData['trackData'] = []
	// Iterate in `trackNameMap` order (matches lodash's `_.pick(fileSections, _.keys(trackNameMap))`)
	// so `trackData` output order is deterministic regardless of how the chart file orders sections.
	for (const trackName of Object.keys(trackNameMap) as TrackName[]) {
		if (!(trackName in fileSections)) continue
		out.push(classifySection(trackName, firstCodaTick, () => classifyChartTrackSection(trackName, fileSections[trackName], firstCodaTick, nonstandardLines)))
	}
	return out
}

/**
 * Classifies one instrument section from its nonblank lines. It reads nothing else but the tick of the first coda
 * event in `[Events]`, which marks the drum fills from there on as the Big Rock Ending.
 */
export function classifyChartTrackSection(
	sectionName: string,
	lines: readonly string[],
	firstCodaTick: number | null,
	nonstandardLines: ParseRules['chartNonstandardLines'] = 'read',
): RawChartData['trackData'][number] {
	const { instrument, difficulty } = trackNameMap[sectionName as TrackName]

	// Single parsing pass that produces note-shaped events ({tick, type, length})
	// plus data-carrying events (text, versus).
	const parsedEvents: ParsedTrackLine[] = []
	for (const line of lines) {
		const parsed = parseTrackLine(line, instrument, difficulty, nonstandardLines)
		if (parsed !== null) parsedEvents.push(parsed)
	}
	// Most parsers reject charts that aren't already sorted, but sort here for safety.
	parsedEvents.sort((a, b) => a.tick - b.tick)

	// Merge solo/soloend pairs in place (note-shaped events only)
	const trackEvents = mergeSoloEvents(
		parsedEvents.filter((e): e is ParsedNoteEvent => e.kind === 'note'),
	)

	const result: RawChartData['trackData'][number] = {
		instrument,
		difficulty,
		starPowerSections: [],
		rejectedStarPowerSections: [],
		soloSections: [],
		flexLanes: [],
		drumFreestyleSections: [],
		trackEvents: [],
		textEvents: [],
		versusPhrases: [],
		animations: [],
		unrecognizedMidiEvents: [],
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

	for (const event of parsedEvents) {
		if (event.kind === 'text') {
			result.textEvents.push({ tick: event.tick, text: event.text })
		} else if (event.kind === 'versus') {
			result.versusPhrases.push({ tick: event.tick, length: event.length, isPlayer2: event.isPlayer2 })
		}
	}

	return result
}

/**
 * Finds each section body in file order, duplicates included. A body that repeats an earlier name is ignored when the
 * sections are read by name. A malformed file gets an error instead of throwing, so it can still be tokenized.
 */
function findChartSections(chartText: string): { sections: ChartSectionToken[]; structureError: string | null } {
	const sections: ChartSectionToken[] = []
	let skipLine = false
	let readStartIndex = 0
	let readingSection = false
	let thisSection: string | null = null
	const len = chartText.length
	for (let i = 0; i < len; i++) {
		const c = chartText.charCodeAt(i)
		if (readingSection) {
			if (c === 93) { // ']'
				readingSection = false
				thisSection = chartText.slice(readStartIndex, i)
			} else if (c === 10) { // '\n'
				return { sections, structureError: `Invalid .chart file: unexpected new line when parsing section at index ${i}` }
			}
			continue // Keep reading section until it ends
		}

		if (c === 61) { // '='
			skipLine = true
		} else if (c === 10) { // '\n'
			skipLine = false
		}
		if (skipLine) continue

		if (c === 123) { // '{'
			skipLine = true
			readStartIndex = i + 1
		} else if (c === 125) { // '}'
			if (!thisSection) {
				return { sections, structureError: `Invalid .chart file: end of section reached before a section name was found at index ${i}` }
			}
			sections.push({ name: thisSection, bodyStart: readStartIndex, bodyEnd: i })
		} else if (c === 91) { // '['
			readStartIndex = i + 1
			readingSection = true
		}
	}

	return { sections, structureError: null }
}

/**
 * Slice `source` from `start` to `end`, split on '\n', trim each line, and
 * drop empty results — in one pass with no intermediate arrays.
 */
/** One line of a `.chart` section body. `start` and `end` are offsets in the decoded text; `end` is before the line feed. */
export interface ChartLineToken {
	readonly start: number
	readonly end: number
	/** The line without surrounding spaces, tabs and carriage returns, as classification reads it; empty when blank. */
	readonly text: string
}

/**
 * Splits a section body into every line, blank lines included, in file order. Its nonblank lines are exactly the
 * lines classification reads from the section.
 */
export function chartSectionLines(tokens: ChartFileTokens, section: ChartSectionToken): ChartLineToken[] {
	const source = tokens.text
	const out: ChartLineToken[] = []
	let lineStart = section.bodyStart
	for (let i = section.bodyStart; i <= section.bodyEnd; i++) {
		if (i === section.bodyEnd || source.charCodeAt(i) === 10) {
			let a = lineStart, b = i
			while (a < b) {
				const cc = source.charCodeAt(a)
				if (cc !== 32 && cc !== 9 && cc !== 13) break
				a++
			}
			while (b > a) {
				const cc = source.charCodeAt(b - 1)
				if (cc !== 32 && cc !== 9 && cc !== 13) break
				b--
			}
			out.push({ start: lineStart, end: i, text: source.slice(a, b) })
			lineStart = i + 1
		}
	}
	return out
}

function splitTrimmedNonEmptyLines(source: string, start: number, end: number): string[] {
	const out: string[] = []
	let lineStart = start
	for (let i = start; i <= end; i++) {
		if (i === end || source.charCodeAt(i) === 10) {
			// trim the slice [lineStart, i)
			let a = lineStart, b = i
			while (a < b) {
				const cc = source.charCodeAt(a)
				if (cc !== 32 && cc !== 9 && cc !== 13) break
				a++
			}
			while (b > a) {
				const cc = source.charCodeAt(b - 1)
				if (cc !== 32 && cc !== 9 && cc !== 13) break
				b--
			}
			if (b > a) out.push(source.slice(a, b))
			lineStart = i + 1
		}
	}
	return out
}

/** Regex matching disco flip mix events (any difficulty). Used to filter them
 * out from textEvents since they're consumed as disco flip modifiers. */
const chartDiscoFlipRegex = /^\s*\[?mix[ _][0-3][ _]drums[0-5](d|dnoflip|easy|easynokick|)\]?\s*$/

// Hoisted regexes — avoid re-parsing on every parseTrackLine call.
const chartLineEQuoted = /^(\d+) = E "([^"\r\n]*)"$/
const chartLineEUnquoted = /^(\d+) = E ([^\r\n]+?)$/
const chartLineNS = /^(\d+) = ([NS]) (\w+)( \d+)?$/
const chartLineDiscoFlipE = /^\s*\[?mix[ _]([0-3])[ _]drums([0-5])(d|dnoflip|easy|easynokick|)\]?\s*$/
const chartSyncTempo = /^(\d+) = B (\d+)$/
const chartSyncTS = /^(\d+) = TS (\d+)(?: (\d+))?$/
const chartSyncUnknown = /^(\d+) = (.+)$/
const chartSongMetaRegex = /^(.+?) = "?(.*?)"?$/

function parseChartTempos(lines: string[]): { tick: number; beatsPerMinute: number }[] {
	const tempos: { tick: number; beatsPerMinute: number }[] = []
	for (const line of lines) {
		const m = chartSyncTempo.exec(line)
		if (!m) continue
		tempos.push({ tick: Number(m[1]), beatsPerMinute: Number(m[2]) / 1000 })
	}
	for (const tempo of tempos) {
		if (tempo.beatsPerMinute === 0) {
			throw `Invalid .chart file: Tempo at tick ${tempo.tick} was zero.`
		}
	}
	if (!tempos[0] || tempos[0].tick !== 0) {
		tempos.unshift({ tick: 0, beatsPerMinute: 120 })
	}
	return tempos
}

function parseChartTimeSignatures(lines: string[]): { tick: number; numerator: number; denominator: number }[] {
	const result: { tick: number; numerator: number; denominator: number }[] = []
	for (const line of lines) {
		const m = chartSyncTS.exec(line)
		if (!m) continue
		result.push({
			tick: Number(m[1]),
			numerator: Number(m[2]),
			denominator: m[3] ? Math.pow(2, Number(m[3])) : 4,
		})
	}
	for (const ts of result) {
		if (ts.numerator === 0) {
			throw `Invalid .chart file: Time signature numerator at tick ${ts.tick} was zero.`
		}
	}
	for (const ts of result) {
		if (ts.denominator === 0) {
			throw `Invalid .chart file: Time signature denominator at tick ${ts.tick} was zero.`
		}
	}
	if (!result[0] || result[0].tick !== 0) {
		result.unshift({ tick: 0, numerator: 4, denominator: 4 })
	}
	return result
}

/**
 * Collect `[SyncTrack]` lines that aren't tempos (`B`) or time signatures
 * (`TS`) into a raw-preserved bucket so they round-trip verbatim. Today this
 * mostly catches tempo anchors (`A <microseconds>`); the bucket is
 * intentionally type-agnostic so any future `[SyncTrack]` event type survives
 * a parse → write loop without parser updates.
 */
function parseChartUnrecognizedSyncTrackEvents(lines: string[]): { tick: number; text: string }[] {
	const out: { tick: number; text: string }[] = []
	for (const line of lines) {
		if (chartSyncTempo.test(line)) continue
		if (chartSyncTS.test(line)) continue
		const m = chartSyncUnknown.exec(line)
		if (!m) continue
		out.push({ tick: Number(m[1]), text: m[2] })
	}
	return out
}

/**
 * Events parsed from a single .chart track line. Note-shaped events flow into
 * `trackEvents` and friends via the distribution loop; text and versus events
 * have extra data and go into their dedicated arrays.
 */
type ParsedNoteEvent = { kind: 'note'; tick: number; type: EventType; length: number }
type ParsedTextEvent = { kind: 'text'; tick: number; text: string }
type ParsedVersusEvent = { kind: 'versus'; tick: number; length: number; isPlayer2: boolean }
export type ParsedTrackLine = ParsedNoteEvent | ParsedTextEvent | ParsedVersusEvent

/**
 * Parse a single line of a .chart instrument track section. Produces a typed
 * event (note / text / versus) or null if the line is unrecognized or consumed
 * by other parsing logic (ENABLE_CHART_DYNAMICS, ENHANCED_OPENS).
 *
 * Lines take one of these forms:
 *   TICK = E "TEXT"          → text event (or recognized E type: solo, mix...)
 *   TICK = S VALUE LENGTH    → starPower, flex lane, freestyle, or versus phrase
 *   TICK = N VALUE LENGTH    → note (with instrument-specific mapping)
 *
 * With `nonstandardLines` read, any other line is read as what it probably means, if anything (chart-line-spelling.ts).
 */
export function parseTrackLine(
	line: string,
	instrument: Instrument,
	difficulty: Difficulty,
	nonstandardLines: ParseRules['chartNonstandardLines'] = 'read',
): ParsedTrackLine | null {
	// Most lines are N/S (notes). Try them first to short-circuit the common case.
	const nsMatch = chartLineNS.exec(line)
	if (nsMatch) {
		const tick = Number(nsMatch[1])
		const typeCode = nsMatch[2]
		const value = nsMatch[3]
		const length = Number(nsMatch[4]) || 0
		if (typeCode === 'S') {
			if (value === '0' || value === '1') {
				return { kind: 'versus', tick, length, isPlayer2: value === '1' }
			}
			const type = getSEventType(value)
			return type !== null ? { kind: 'note', tick, type, length } : null
		}
		const type = getNEventType(value, instrument)
		return type !== null ? { kind: 'note', tick, type, length } : null
	}
	// E events have quoted arbitrary text, so handle them separately from N/S.
	const quoted = chartLineEQuoted.exec(line)
	const eMatch = quoted ?? chartLineEUnquoted.exec(line)
	// A text after more than one space is read trimmed, as Clone Hero reads it: by its respelling, below.
	if (eMatch && (quoted !== null || nonstandardLines === 'ignored' || !/^[ \t]/.test(eMatch[2]))) {
		const tick = Number(eMatch[1])
		const value = eMatch[2]
		const recognizedType = getEEventType(value, difficulty)
		if (recognizedType !== null) return { kind: 'note', tick, type: recognizedType, length: 0 }
		// Disco flip events for other difficulties: consumed (not stored as text)
		if (chartDiscoFlipRegex.test(value)) return null
		// Skip directives consumed by chart processing (not stored as text events)
		const stripped = value.replace(/^\[/, '').replace(/\]$/, '').trim()
		if (stripped === 'ENABLE_CHART_DYNAMICS' || stripped === 'ENHANCED_OPENS') return null
		return { kind: 'text', tick, text: value }
	}
	if (nonstandardLines === 'ignored') return null
	// Not a standard line: read what it probably means, if anything. A respelled line is always standard.
	const spelling = chartLineSpelling(line, 'track')
	return spelling?.kind === 'respelled' ? parseTrackLine(spelling.line, instrument, difficulty) : null
}

function getEEventType(value: string, difficulty: Difficulty): EventType | null {
	switch (value) {
		case 'solo':
			return eventTypes.soloSectionStart
		case 'soloend':
			return eventTypes.soloSectionEnd
	}
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

export function getSEventType(value: string): EventType | null {
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

export function getNEventType(value: string, instrument: Instrument): EventType | null {
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
				case '109':
					return eventTypes.forceFlam // MIDI's flam note; the frozen legacy profile ignores it (parse rule `chartFlam`)
				default:
					return null
			}
		}
		case 'guitarghl':
		case 'guitarcoopghl':
		case 'rhythmghl':
		case 'bassghl':
		case 'keysghl': {
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

	let w = 0
	for (let r = 0; r < events.length; r++) {
		const t = events[r].type
		if (t !== eventTypes.soloSectionStart && t !== eventTypes.soloSectionEnd) {
			events[w++] = events[r]
		}
	}
	events.length = w

	return events
}

interface ChartEventsScanResult {
	sections: { tick: number; name: string }[]
	endEvents: { tick: number }[]
	codaEvents: { tick: number }[]
	/** E-events not recognized as sections/end/coda/lyrics/phrases. Becomes
	 *  `RawChartData.unrecognizedEventsTrackTextEvents`. Lyrics and
	 *  phrase_start/phrase_end are extracted separately by the vocal parsing
	 *  path. */
	unrecognizedTextEvents: { tick: number; text: string }[]
}

/**
 * Parse each line of the .chart [Events] section once via the generic
 * `TICK = E "TEXT"` regex, then classify the text into one of
 * {section, end, coda, lyric, phrase, unrecognized text event}.
 */
function scanEventsSection(eventLines: string[]): ChartEventsScanResult {
	const result: ChartEventsScanResult = {
		sections: [],
		endEvents: [],
		codaEvents: [],
		unrecognizedTextEvents: [],
	}
	for (const line of eventLines) {
		const match = /^(\d+) = E "([^\r\n]*?)"$/.exec(line)
		if (!match) continue
		const tick = Number(match[1])
		const text = match[2]

		// Accept either `[section NAME]` (bracketed form — outer brackets are
		// stripped) or `section NAME` (plain form — everything after the prefix
		// is the name). Brackets must match as a pair: a trailing `]` is not
		// stripped unless the text also started with `[`. This preserves section
		// names that legitimately end in `]` (e.g. `section <b>…</b> [credits]`).
		const bracketedSection = /^\[(?:section|prc)[ _](.*)\]$/.exec(text)
		const plainSection = !bracketedSection && /^(?:section|prc)[ _](.*)$/.exec(text)
		if (bracketedSection || plainSection) {
			const name = (bracketedSection ?? plainSection as RegExpExecArray)[1]
			result.sections.push({ tick, name })
			continue
		}
		if (/^\[?end\]?$/.test(text)) {
			result.endEvents.push({ tick })
			continue
		}
		if (/^\s*\[?coda\]?\s*$/.test(text)) {
			result.codaEvents.push({ tick })
			continue
		}
		// Lyrics and phrase markers are extracted by the vocal parsing path — skip here
		if (/^\s*lyric[ \t]/.test(text)) continue
		if (/^(?:phrase_start|phrase_end)$/.test(text)) continue

		result.unrecognizedTextEvents.push({ tick, text })
	}
	return result
}

