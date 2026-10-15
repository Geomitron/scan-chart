import { sameAsJson } from './chart/chart-analysis'
import { chartAuthoredTracks, midiAuthoredTracks } from './chart/authored-view'
import { spliceChartText } from './chart/chart-edit'
import { chartSectionTrack, ChartFileTokens, ChartSectionToken } from './chart/chart-file-parser'
import { midiSourceTrackInstrument } from './chart/midi-file-parser'
import { removeMidiTrackChunks } from './chart/midi-tokens'
import { parseChartSource, type ParsedChartFile } from './chart/parse-chart-file'
import { parseRules } from './chart/parse-rules'
import { EventType, eventTypes } from './chart/raw-types'
import { NoteEvent, noteFlags, noteTypes } from './chart/types'
import { FixRecord, hashChanges, hashNames } from './fix-report'
import { asUtf8Ini, rewriteSongIni } from './ini/ini-edit'
import type { IniTokens } from './ini/parse-ini'
import type { Issue, IssueCode, MetadataFinding } from './issues'
import { songContext } from './song-context'
import { AuthoredElement, continueEdits, editSong, SongDocument, withSongIni } from './song-document'
import { songHashes } from './song-save'
import { Difficulty, getInstrumentType, Instrument, instrumentTypes } from './types'

type Track = ParsedChartFile['trackData'][number]

/** The chart as Clone Hero plays it, parsed with the song's settings, or `null` when it doesn't parse. */
function parsedChart(song: SongDocument): ParsedChartFile | null {
	const { chart } = songContext(song)
	return chart.kind === 'parsed' ? chart.parsed : null
}

/**
 * The first way two parses of a chart play differently, or `null` when they play alike: the drum type, the tempo map, a
 * track, or a note's tick, length, type or flags, and, with `phrases`, star power, solos, flex lanes and drum fills.
 */
export function gameplayDifference(a: ParsedChartFile, b: ParsedChartFile, phrases = true): string | null {
	// The drum type is read for drums tracks, if any.
	const drumType = (chart: ParsedChartFile) => chart.trackData.some(track => track.instrument === 'drums') ? chart.drumType : null
	if (drumType(a) !== drumType(b)) return 'the drum type'
	const tempoMap = (chart: ParsedChartFile) => [chart.tempos.map(tempo => [tempo.tick, tempo.beatsPerMinute]), chart.timeSignatures.map(signature => [signature.tick, signature.numerator, signature.denominator])]
	if (!sameAsJson(tempoMap(a), tempoMap(b))) return 'the tempo map'
	const tracks = (chart: ParsedChartFile) => new Map(chart.trackData.map(track => [trackName(track), track]))
	const [tracksA, tracksB] = [tracks(a), tracks(b)]
	for (const name of new Set([...tracksA.keys(), ...tracksB.keys()])) {
		const [x, y] = [tracksA.get(name), tracksB.get(name)]
		if (x === undefined || y === undefined) return `the ${name} track`
		const notes = (track: Track) => track.noteEventGroups.flat().map(note => [note.tick, note.length, note.type, note.flags])
		const [notesX, notesY] = [notes(x), notes(y)]
		const at = notesX.findIndex((note, index) => !sameAsJson(note, notesY[index]))
		if (at !== -1 || notesX.length !== notesY.length) return `the ${name} note at tick ${(notesX[at] ?? notesY[notesX.length])[0]}`
		if (!phrases) continue
		for (const [field, kind] of phraseFields) {
			if (!sameAsJson(phraseRanges(x, field), phraseRanges(y, field))) return `the ${name} ${kind} phrases`
		}
	}
	return null
}

const phraseFields = [['starPowerSections', 'star power'], ['soloSections', 'solo'], ['flexLanes', 'flex lane'], ['drumFreestyleSections', 'drum fill']] as const
type PhraseField = (typeof phraseFields)[number][0]

/** A track's phrases of a kind, as their ticks and lengths, and whether a flex lane is double or a drum fill a coda. */
function phraseRanges(track: Track, field: PhraseField) {
	return (track[field] as readonly { tick: number; length: number; isDouble?: boolean; isCoda?: boolean }[])
		.map(phrase => [phrase.tick, phrase.length, phrase.isDouble ?? phrase.isCoda ?? null])
}

const trackName = (track: { instrument: Instrument; difficulty: Difficulty }) => `${track.difficulty} ${track.instrument}`

/**
 * Applies the edits that keep `problem` away: all of them, or else each that passes alone, and then those together.
 * Each edit left out is skipped with its problem, which completes a sentence about the edit, such as "would change the
 * drum type". Returns the song with the edits chosen.
 */
function chooseEdits<T>(
	song: SongDocument,
	edits: readonly T[],
	apply: (chosen: readonly T[]) => SongDocument,
	problem: (edited: SongDocument, chosen: readonly T[]) => string | null,
	skip: (edit: T, problem: string) => void,
): { song: SongDocument; chosen: readonly T[] } {
	const check = (chosen: readonly T[]) => {
		try {
			const edited = apply(chosen)
			return { edited, reason: problem(edited, chosen) }
		} catch (error) {
			return { edited: song, reason: `fails: ${error instanceof Error ? error.message : String(error)}` }
		}
	}
	if (edits.length === 0) return { song, chosen: [] }
	const all = check(edits)
	if (all.reason === null) return { song: all.edited, chosen: edits }
	if (edits.length === 1) {
		skip(edits[0], all.reason)
		return { song, chosen: [] }
	}
	const chosen = edits.filter(edit => {
		const { reason } = check([edit])
		if (reason !== null) skip(edit, reason)
		return reason === null
	})
	if (chosen.length === 0) return { song, chosen }
	const together = check(chosen)
	if (together.reason === null) return { song: together.edited, chosen }
	for (const edit of chosen) skip(edit, `${together.reason}, with the other fixes`)
	return { song, chosen: [] }
}

/**
 * How an edit that should play alike doesn't, such as "would change the drum type", or `null` when it plays alike and
 * keeps every canonical hash. `phrases` compares the phrases too.
 */
function keepsGameplay(before: SongDocument, edited: SongDocument, phrases: boolean): string | null {
	const [a, b] = [parsedChart(before), parsedChart(edited)]
	if (b === null) return 'would make the chart unreadable'
	const difference = a === null ? null : gameplayDifference(a, b, phrases)
	if (difference !== null) return `would change ${difference}`
	const changes = hashChanges(songHashes(before), songHashes(edited))
	return changes.length === 0 ? null : `would change ${hashNames(changes)}`
}

/**
 * Removes each `.chart` instrument section and `.mid` instrument track with no notes (`emptyTrack`): every section of
 * the name, and every track of the instrument, of which a reader reads only the first.
 */
export function fixEmptyTracks(song: SongDocument, issues: readonly Issue[], record: FixRecord): SongDocument {
	const found = issues.filter(issue => issue.code === 'emptyTrack' && issue.instrument !== null)
	const { chart } = song
	if (found.length === 0 || chart === null) return song
	const isReported = (instrument: Instrument | null, difficulty: Difficulty | null) =>
		found.some(issue => issue.instrument === instrument && (issue.difficulty === null || issue.difficulty === difficulty))
	if (chart.format === 'chart') {
		const names = [...new Set(chart.tokens.sections.map(section => section.name))].filter(name => {
			const track = chartSectionTrack(name)
			return track !== null && isReported(track.instrument, track.difficulty)
		})
		const apply = (chosen: readonly string[]) => {
			if (song.chart?.format !== 'chart') return song
			const { tokens } = song.chart
			const ranges = tokens.sections.filter(section => chosen.includes(section.name)).map(section => ({ ...sectionRange(tokens, section), text: '' }))
			return continueEdits(song, { ...song, chart: { ...song.chart, tokens: spliceChartText(tokens, ranges) } })
		}
		const { song: fixed, chosen } = chooseEdits(song, names, apply, edited => keepsGameplay(song, edited, true),
			(name, problem) => record.skip('emptyTrack', chart.fileName, `Removing the [${name}] section ${problem}.`))
		for (const name of chosen) record.fixed.push({ code: 'emptyTrack', file: chart.fileName, description: `Removed the [${name}] section, which has no notes.` })
		return fixed
	}
	if (chart.tokens === null) return song
	const tracks = chart.tokens.chunks.flatMap((chunk, index) => chunk.kind === 'track' ? [{ chunk, index }] : []).slice(1).flatMap(({ chunk, index }) => {
		// A track is named by its last name at tick 0.
		const names = chunk.events.filter(({ tick, event }) => tick === 0 && event.type === 'trackName').map(({ event }) => (event as { text: string }).text)
		const name = names[names.length - 1]
		const instrument = name === undefined ? null : midiSourceTrackInstrument(name)
		return instrument !== null && isReported(instrument, null) ? [{ name, index }] : []
	})
	const apply = (chosen: readonly { name: string; index: number }[]) => {
		if (song.chart?.format !== 'mid' || song.chart.tokens === null) return song
		const tokens = removeMidiTrackChunks(song.chart.tokens, chosen.map(track => track.index))
		return continueEdits(song, { ...song, chart: { ...song.chart, bytes: tokens.data, tokens } })
	}
	const { song: fixed, chosen } = chooseEdits(song, tracks, apply, edited => keepsGameplay(song, edited, true),
		(track, problem) => record.skip('emptyTrack', chart.fileName, `Removing the "${track.name}" track ${problem}.`))
	for (const track of chosen) record.fixed.push({ code: 'emptyTrack', file: chart.fileName, description: `Removed the "${track.name}" track, which has no notes.` })
	return fixed
}

/** A `.chart` section's text range: from the start of its name's line to the end of its closing brace's line. */
function sectionRange(tokens: ChartFileTokens, section: ChartSectionToken): { start: number; end: number } {
	const { text } = tokens
	const start = text.lastIndexOf('\n', text.lastIndexOf('[', section.bodyStart)) + 1
	const lineEnd = text.indexOf('\n', section.bodyEnd)
	return { start, end: lineEnd === -1 ? text.length : lineEnd + 1 }
}

const emptyPhraseFields = { emptyStarPower: 'starPowerSections', emptySoloSection: 'soloSections', emptyFlexLane: 'flexLanes' } as const
const phraseNames = { emptyStarPower: 'star power', emptySoloSection: 'solo', emptyFlexLane: 'flex lane' } as const

/** One phrase to remove: where it starts, and the authored events that write it. */
interface PhraseRemoval {
	readonly instrument: Instrument
	/** `null` for a `.mid` phrase, which every difficulty of the instrument shares. */
	readonly difficulty: Difficulty | null
	readonly tick: number
	readonly elements: readonly AuthoredElement[]
}

/**
 * Removes star power, solo and flex lane phrases with no notes (`emptyStarPower`, `emptySoloSection`,
 * `emptyFlexLane`). A `.mid` phrase, which every difficulty shares, is removed only when it has no notes on any. The
 * canonical hashes leave out phrases with no notes, so a removal that changes a note or a hash is left out.
 */
export function fixEmptyPhrases(song: SongDocument, issues: readonly Issue[], record: FixRecord): SongDocument {
	let fixed = song
	for (const code of ['emptyStarPower', 'emptySoloSection', 'emptyFlexLane'] as const) {
		const found = issues.filter(issue => issue.code === code && issue.instrument !== null && issue.difficulty !== null && issue.tick !== null)
		if (found.length > 0) fixed = removeEmptyPhrases(fixed, code, found, record)
	}
	return fixed
}

function removeEmptyPhrases(song: SongDocument, code: keyof typeof emptyPhraseFields, found: readonly Issue[], record: FixRecord): SongDocument {
	const { chart } = song
	const parsed = parsedChart(song)
	if (chart === null || parsed === null || (chart.format === 'mid' && chart.tokens === null)) return song
	const field = emptyPhraseFields[code]
	const skip = (reason: string) => record.skip(code, chart.fileName, reason)
	const removals: PhraseRemoval[] = []
	if (chart.format === 'chart') {
		for (const { instrument, difficulty, tick } of found) {
			const section = chartAuthoredTracks(chart.tokens).find(track => track.isRead && track.instrument === instrument && track.difficulty === difficulty)
			const events = section?.events ?? []
			const elements = code === 'emptySoloSection' ? soloEvents(events, tick!)
				: events.filter(event => event.tick === tick && (code === 'emptyStarPower' ? event.type === eventTypes.starPower : isFlexLane(event.type)))
			if (elements.length === 0) skip(`The ${difficulty} ${instrument} ${phraseNames[code]} phrase at tick ${tick} isn't written as one event.`)
			else removals.push({ instrument: instrument!, difficulty, tick: tick!, elements })
		}
	} else {
		const settings = songContext(song).settings
		for (const key of new Set(found.map(issue => `${issue.instrument} ${issue.tick}`))) {
			const { instrument, tick } = found.find(issue => `${issue.instrument} ${issue.tick}` === key)!
			// A .mid phrase is every difficulty's: it's removed only when no difficulty's notes are in it.
			const holding = parsed.trackData.filter(track => track.instrument === instrument && track[field].some(phrase => phrase.tick === tick))
			if (holding.some(track => !found.some(issue => issue.instrument === instrument && issue.difficulty === track.difficulty && issue.tick === tick))) {
				skip(`The ${instrument} ${phraseNames[code]} phrase at tick ${tick} has notes on another difficulty.`)
				continue
			}
			const track = midiAuthoredTracks(chart.tokens!).find(candidate => candidate.isFirst && candidate.instrument === instrument)!
			const types: readonly EventType[] = code === 'emptySoloSection' ? [eventTypes.soloSection]
				: code === 'emptyFlexLane' ? [eventTypes.flexLaneSingle, eventTypes.flexLaneDouble]
				: [starPowerFromSolos(instrument!, track.events, settings.multiplier_note) ? eventTypes.soloSection : eventTypes.starPower]
			const elements = track.events.filter(event => event.scope === 'instrument' && event.tick === tick && types.includes(event.type))
			if (elements.length === 0) skip(`The ${instrument} ${phraseNames[code]} phrase at tick ${tick} isn't written as one event.`)
			else removals.push({ instrument: instrument!, difficulty: null, tick: tick!, elements })
		}
	}

	const apply = (chosen: readonly PhraseRemoval[]) => editSong(song, batch => {
		for (const removal of chosen) for (const element of removal.elements) batch.remove(element)
	})
	// The notes and hashes stay, and the phrases chosen are gone, every other phrase of the kind kept.
	const problem = (edited: SongDocument, chosen: readonly PhraseRemoval[]) => {
		const reason = keepsGameplay(song, edited, false)
		if (reason !== null) return reason
		const after = new Map(parsedChart(edited)!.trackData.map(track => [trackName(track), track]))
		for (const track of parsed.trackData) {
			const removed = (tick: number) => chosen.some(removal => removal.instrument === track.instrument && (removal.difficulty ?? track.difficulty) === track.difficulty && removal.tick === tick)
			const expected = phraseRanges(track, field).filter(([tick]) => !removed(tick as number))
			if (!sameAsJson(phraseRanges(after.get(trackName(track))!, field), expected)) return `would change other ${trackName(track)} ${phraseNames[code]} phrases`
		}
		return null
	}
	const { song: fixed, chosen } = chooseEdits(song, removals, apply, problem,
		(removal, problem) => skip(`Removing the ${`${removal.difficulty ?? ''} ${removal.instrument}`.trim()} ${phraseNames[code]} phrase at tick ${removal.tick} ${problem}.`))
	for (const name of new Set(chosen.map(removal => `${removal.difficulty ?? ''} ${removal.instrument}`.trim()))) {
		const ticks = chosen.filter(removal => `${removal.difficulty ?? ''} ${removal.instrument}`.trim() === name).map(removal => removal.tick)
		record.fixed.push({
			code,
			file: chart.fileName,
			description: `Removed the ${name} ${phraseNames[code]} ${ticks.length === 1 ? 'phrase' : 'phrases'} with no notes at ${ticks.length === 1 ? 'tick' : 'ticks'} ${ticks.join(', ')}.`,
		})
	}
	return fixed
}

const isFlexLane = (type: EventType) => type === eventTypes.flexLaneSingle || type === eventTypes.flexLaneDouble

/** The `solo` and `soloend` events of the `.chart` solo starting at `tick`, paired as the parser pairs them. */
function soloEvents<E extends { tick: number; type: EventType }>(events: readonly E[], tick: number): E[] {
	const open: E[] = []
	for (const event of [...events].sort((a, b) => a.tick - b.tick)) {
		if (event.type === eventTypes.soloSectionStart) open.push(event)
		else if (event.type === eventTypes.soloSectionEnd) {
			const start = open.pop()
			if (start?.tick === tick) return [start, event]
		}
	}
	return []
}

/**
 * Whether a `.mid` track reads its solo notes (103) as star power, as Clone Hero's guitar and keys tracks do with
 * `multiplier_note = 103`, or with more than one solo and no star power (116) unless `multiplier_note = 116`.
 */
function starPowerFromSolos(instrument: Instrument, events: readonly { scope: string; type: EventType }[], multiplierNote: number): boolean {
	if (getInstrumentType(instrument) === instrumentTypes.drums || multiplierNote === 116) return false
	const count = (type: EventType) => events.filter(event => event.scope === 'instrument' && event.type === type).length
	return multiplierNote === 103 || (count(eventTypes.starPower) === 0 && count(eventTypes.soloSection) > 1)
}

/** The event type of each fret note type, as a `.chart` line or MIDI note writes it. */
const fretEventTypes = new Map<number, EventType>([
	[noteTypes.open, eventTypes.open], [noteTypes.green, eventTypes.green], [noteTypes.red, eventTypes.red], [noteTypes.yellow, eventTypes.yellow],
	[noteTypes.blue, eventTypes.blue], [noteTypes.orange, eventTypes.orange], [noteTypes.black1, eventTypes.black1], [noteTypes.black2, eventTypes.black2],
	[noteTypes.black3, eventTypes.black3], [noteTypes.white1, eventTypes.white1], [noteTypes.white2, eventTypes.white2], [noteTypes.white3, eventTypes.white3],
])

/** The sustains of one track to change: each note's new length, in ticks, and the code each change fixes. */
interface SustainEdits {
	readonly track: Track
	readonly lengths: Map<NoteEvent, { length: number; code: 'badSustainGap' | 'babySustain' }>
}

/**
 * Shortens each sustain that ends less than `gapMs` before the next note to end `gapMs` before it (`badSustainGap`),
 * and removes each sustain shorter than `minMs` (`babySustain`), measured as the checks measure them. A shortened
 * sustain left shorter than `minMs` is removed with `removeShort`, when `babySustain` is fixed too. Both change the
 * TrackHash.
 */
export function fixSustains(
	song: SongDocument,
	issues: readonly Issue[],
	{ gapMs, minMs, removeShort }: { gapMs: number; minMs: number; removeShort: boolean },
	record: FixRecord,
): SongDocument {
	const { chart } = song
	const parsed = parsedChart(song)
	const found = issues.filter(issue => (issue.code === 'badSustainGap' || issue.code === 'babySustain') && issue.tick !== null)
	if (chart === null || parsed === null || found.length === 0 || (chart.format === 'mid' && chart.tokens === null)) return song
	const msLength = (note: NoteEvent, length: number) => msAtTick(parsed, note.tick + length) - note.msTime
	const tracks: SustainEdits[] = []
	for (const track of parsed.trackData.filter(track => getInstrumentType(track.instrument) !== instrumentTypes.drums)) {
		const ticksOf = (code: IssueCode) => new Set(found.filter(issue => issue.code === code && issue.instrument === track.instrument && issue.difficulty === track.difficulty).map(issue => issue.tick))
		const [gapTicks, babyTicks] = [ticksOf('badSustainGap'), ticksOf('babySustain')]
		const lengths: SustainEdits['lengths'] = new Map()
		const held = new Set<NoteEvent>()
		track.noteEventGroups.forEach((group, index) => {
			if (babyTicks.has(group[0].tick)) {
				const nextOpen = track.noteEventGroups[index + 1]?.find(note => note.type === noteTypes.open)
				for (const note of group) {
					// The check doesn't count a short sustain before a HOPO or tap open note.
					const beforeOpen = nextOpen !== undefined && nextOpen.tick < note.tick + note.length && (nextOpen.flags & (noteFlags.hopo | noteFlags.tap)) !== 0
					if (note.msLength > 0 && note.msLength < minMs && !beforeOpen) lengths.set(note, { length: 0, code: 'babySustain' })
				}
			}
			if (!gapTicks.has(group[0].tick)) return
			const start = group[0].msTime
			for (const earlier of track.noteEventGroups.slice(0, index)) {
				for (const note of earlier) {
					const end = note.msTime + note.msLength
					if (note.msLength <= 0 || note.type === noteTypes.open || start < end || start - end >= gapMs) continue
					const endTick = Math.max(note.tick, Math.floor(tickAtMs(parsed, start - gapMs)))
					// A sustain held over other notes would end too close to one of them.
					const endMs = msAtTick(parsed, endTick)
					if (endTick > note.tick && track.noteEventGroups.some(other => other !== group && other[0].tick >= endTick && other[0].msTime < endMs + gapMs)) {
						held.add(note)
						continue
					}
					const shortened = removeShort && msLength(note, endTick - note.tick) < minMs ? 0 : endTick - note.tick
					const previous = lengths.get(note)
					if (previous === undefined || shortened < previous.length) lengths.set(note, { length: shortened, code: previous?.code ?? 'badSustainGap' })
				}
			}
		})
		if (held.size > 0) {
			record.skip('badSustainGap', chart.fileName, `${held.size} ${trackName(track)} ${held.size === 1 ? 'sustain is' : 'sustains are'} held over other notes: `
				+ `shortening ${held.size === 1 ? 'it' : 'them'} would end ${held.size === 1 ? 'it' : 'them'} too close to one.`)
		}
		if (lengths.size > 0) tracks.push({ track, lengths })
	}

	const apply = (chosen: readonly SustainEdits[]) => editSong(song, batch => {
		for (const { track, lengths } of chosen) {
			for (const [note, { length }] of lengths) {
				const events = authoredNotes(song, track, note)
				if (events.length === 0) throw new RangeError(`the note at tick ${note.tick} isn't written as one event`)
				for (const event of events) batch.setLength(event, length)
			}
		}
	})
	// Each note changed is no longer than asked for, and every other note and phrase stays.
	const problem = (edited: SongDocument, chosen: readonly SustainEdits[]) => {
		const after = parsedChart(edited)
		if (after === null) return 'would make the chart unreadable'
		const tracksAfter = new Map(after.trackData.map(track => [trackName(track), track]))
		const expected = parsed.trackData.map(track => {
			const asked = chosen.find(edits => trackName(edits.track) === trackName(track))?.lengths
			const notesAfter = tracksAfter.get(trackName(track))?.noteEventGroups.flat() ?? []
			return {
				...track,
				noteEventGroups: track.noteEventGroups.map(group => group.map(note => {
					const length = asked?.get(note)?.length
					const resolved = length === undefined ? undefined : notesAfter.find(candidate => candidate.tick === note.tick && candidate.type === note.type)?.length
					return resolved === undefined || resolved > length! ? note : { ...note, length: resolved }
				})),
			}
		})
		const difference = gameplayDifference({ ...parsed, trackData: expected }, after)
		return difference === null ? null : `would change ${difference}`
	}
	const { song: fixed, chosen } = chooseEdits(song, tracks, apply, problem, (edits, problem) => {
		for (const code of new Set([...edits.lengths.values()].map(edit => edit.code))) record.skip(code, chart.fileName, `Changing the ${trackName(edits.track)} sustains ${problem}.`)
	})
	for (const { track, lengths } of chosen) {
		const count = (code: 'badSustainGap' | 'babySustain') => [...lengths.values()].filter(edit => edit.code === code).length
		const [gaps, babies] = [count('badSustainGap'), count('babySustain')]
		if (gaps > 0) {
			record.fixed.push({ code: 'badSustainGap', file: chart.fileName,
				description: `Shortened ${gaps} ${trackName(track)} ${gaps === 1 ? 'sustain' : 'sustains'} to end ${gapMs} ms before the next note.` })
		}
		if (babies > 0) {
			record.fixed.push({ code: 'babySustain', file: chart.fileName,
				description: `Removed ${babies} ${trackName(track)} ${babies === 1 ? 'sustain' : 'sustains'} shorter than ${minMs} ms.` })
		}
	}
	return fixed
}

/** The authored events of a parsed fret note: its `.chart` lines, or its MIDI notes on its difficulty. */
function authoredNotes(song: SongDocument, track: Track, note: NoteEvent): (AuthoredElement & { length: number })[] {
	const { chart } = song
	const type = fretEventTypes.get(note.type)
	if (chart === null || type === undefined) return []
	if (chart.format === 'chart') {
		const section = chartAuthoredTracks(chart.tokens).find(candidate => candidate.isRead && candidate.instrument === track.instrument && candidate.difficulty === track.difficulty)
		return section?.events.filter(event => event.tick === note.tick && event.type === type) ?? []
	}
	const midiTrack = chart.tokens === null ? undefined : midiAuthoredTracks(chart.tokens).find(candidate => candidate.isFirst && candidate.instrument === track.instrument)
	return midiTrack?.events.filter(event => event.scope === track.difficulty && event.tick === note.tick && event.type === type) ?? []
}

/** The tick at a time in milliseconds, from the chart's tempo map, as a fraction. */
function tickAtMs(chart: ParsedChartFile, ms: number): number {
	const tempo = [...chart.tempos].reverse().find(candidate => candidate.msTime <= ms) ?? chart.tempos[0]
	return tempo.tick + (ms - tempo.msTime) * tempo.beatsPerMinute * chart.resolution / 60000
}

/** The time of a tick in milliseconds, from the chart's tempo map. */
function msAtTick(chart: ParsedChartFile, tick: number): number {
	const tempo = [...chart.tempos].reverse().find(candidate => candidate.tick <= tick) ?? chart.tempos[0]
	return tempo.msTime + (tick - tempo.tick) * 60000 / (tempo.beatsPerMinute * chart.resolution)
}

/**
 * Forces the notes whose HOPO or strum differs between song.ini's HOPO threshold and the format's own, so every note
 * plays the same without `hopo_frequency` and `eighthnote_hopo`, then removes them from song.ini
 * (`deprecatedIniTag`). A `.chart` note is forced by adding or removing its `N 5` line, which swaps HOPO and strum; a
 * `.mid` note gets a one-tick force HOPO or force strum note on its difficulty. The rewrite is checked: every note,
 * phrase and canonical hash stays, or it isn't made.
 */
export function fixHopoTags(song: SongDocument, issues: readonly Issue[], findings: readonly MetadataFinding[], record: FixRecord): SongDocument {
	const reported = issues.some(issue => issue.code === 'deprecatedIniTag')
		&& findings.some(finding => finding.metadataIssue === 'deprecatedIniTag' && finding.keys?.some(key => key === 'hopo_frequency' || key === 'eighthnote_hopo'))
	const context = songContext(song)
	const { chart, ini } = song
	if (!reported || ini === null) return song
	if (chart === null || context.chart.kind !== 'parsed' || (chart.format === 'mid' && chart.tokens === null)) {
		record.skip('deprecatedIniTag', ini.fileName, 'The chart can\'t be read, so it can\'t be rewritten to play the same without the HOPO tags.')
		return song
	}
	const { settings } = context
	// Without hopo_frequency, eighthnote_hopo = True would apply, so it goes too.
	const keys = [...settings.hopo_frequency > 0 ? ['hopo_frequency'] : [], ...settings.eighthnote_hopo ? ['eighthnote_hopo'] : []]
	const tags = keys.map(key => `"${key}"`).join(' and ')
	const skip = (problem: string) => record.skip('deprecatedIniTag', ini.fileName, `Rewriting the chart to play the same without ${tags} ${problem}.`)
	const withTags = context.chart.parsed
	const without = parseChartSource(context.chart.source, { ...settings, hopo_frequency: 0, eighthnote_hopo: false }, parseRules.canonical20260801)

	let forced = 0
	let tokens: IniTokens
	try {
		tokens = rewriteSongIni(asUtf8Ini(ini.tokens), { layout: false, order: null, remove: new Set(keys), set: new Map() })
	} catch {
		record.skip('deprecatedIniTag', ini.fileName, 'song.ini can\'t be decoded, so it can\'t be rewritten.')
		return song
	}
	let fixed: SongDocument
	try {
		const edited = editSong(song, batch => {
			for (const track of withTags.trackData.filter(track => getInstrumentType(track.instrument) !== instrumentTypes.drums)) {
				const plain = without.trackData.find(candidate => trackName(candidate) === trackName(track))
				if (plain === undefined || plain.noteEventGroups.length !== track.noteEventGroups.length) throw new RangeError(`the ${trackName(track)} notes don't line up`)
				track.noteEventGroups.forEach((group, index) => {
					const hopoOrStrum = (flags: number) => flags & (noteFlags.hopo | noteFlags.strum)
					const plainGroup = plain.noteEventGroups[index]
					if (plainGroup[0].tick !== group[0].tick) throw new RangeError(`the ${trackName(track)} notes don't line up`)
					if (hopoOrStrum(group[0].flags) === hopoOrStrum(plainGroup[0].flags)) return
					forced++
					const tick = group[0].tick
					if (chart.format === 'chart') {
						const section = chartAuthoredTracks(chart.tokens).find(candidate => candidate.isRead && trackName(candidate) === trackName(track))!
						const unnatural = section.events.filter(event => event.tick === tick && event.type === eventTypes.forceUnnatural)
						if (unnatural.length > 0) for (const event of unnatural) batch.remove(event)
						else batch.addToChartSection(section.section, tick, eventTypes.forceUnnatural, 0)
					} else {
						const midiTrack = midiAuthoredTracks(chart.tokens!).find(candidate => candidate.isFirst && candidate.instrument === track.instrument)!
						const type = group[0].flags & noteFlags.hopo ? eventTypes.forceHopo : eventTypes.forceStrum
						batch.addToMidiTrack(midiTrack.chunk, track.difficulty, tick, type, 1)
					}
				})
			}
		})
		fixed = continueEdits(edited, withSongIni(edited, tokens))
	} catch (error) {
		skip(`fails: ${error instanceof Error ? error.message : String(error)}`)
		return song
	}
	const problem = keepsGameplay(song, fixed, true)
	if (problem !== null) {
		skip(problem)
		return song
	}
	record.fixed.push({
		code: 'deprecatedIniTag',
		file: chart.fileName,
		description: forced === 0
			? `Removed ${tags}, without which every note reads the same.`
			: `Forced ${forced} ${forced === 1 ? 'note' : 'notes'} to play the same without ${tags}, and removed ${keys.length === 1 ? 'it' : 'them'}.`,
	})
	return fixed
}

/**
 * Moves a `.mid` file's star power from note 103 to note 116 in each guitar and keys track, removing the notes 116 there,
 * which `multiplier_note = 103` makes games ignore, then removes the tag (`deprecatedIniTag`). The drums tracks, where
 * note 103 marks solos whatever the tag, keep theirs. The rewrite is checked: every note, phrase and canonical hash
 * stays, or it isn't made.
 */
export function fixMultiplierNote(song: SongDocument, issues: readonly Issue[], findings: readonly MetadataFinding[], record: FixRecord): SongDocument {
	const reported = issues.some(issue => issue.code === 'deprecatedIniTag')
		&& findings.some(finding => finding.metadataIssue === 'deprecatedIniTag' && finding.keys?.includes('multiplier_note'))
	const { chart, ini } = song
	if (!reported || chart?.format !== 'mid' || chart.tokens === null || ini === null) return song
	const skip = (problem: string) => record.skip('deprecatedIniTag', ini.fileName, `Moving the star power to note 116 ${problem}.`)
	let [moved, dropped] = [0, 0]
	let fixed: SongDocument
	try {
		const tokens = rewriteSongIni(asUtf8Ini(ini.tokens), { layout: false, order: null, remove: new Set(['multiplier_note']), set: new Map() })
		const edited = editSong(song, batch => {
			for (const track of midiAuthoredTracks(chart.tokens!).filter(track => track.isFirst && getInstrumentType(track.instrument) !== instrumentTypes.drums)) {
				for (const event of track.events.filter(event => event.scope === 'instrument')) {
					if (event.type === eventTypes.soloSection) {
						batch.remove(event)
						batch.addToMidiTrack(track.chunk, 'instrument', event.tick, eventTypes.starPower, event.length, { velocity: event.velocity, channel: event.channel })
						moved++
					} else if (event.type === eventTypes.starPower) {
						batch.remove(event)
						dropped++
					}
				}
			}
		})
		fixed = continueEdits(edited, withSongIni(edited, tokens))
	} catch (error) {
		skip(`fails: ${error instanceof Error ? error.message : String(error)}`)
		return song
	}
	const problem = keepsGameplay(song, fixed, true)
	if (problem !== null) {
		skip(problem)
		return song
	}
	const ignored = dropped === 0 ? '' : `, removed ${dropped} ${dropped === 1 ? 'note' : 'notes'} 116 that "multiplier_note = 103" made games ignore,`
	record.fixed.push({
		code: 'deprecatedIniTag',
		file: chart.fileName,
		description: `Moved ${moved} star power ${moved === 1 ? 'phrase' : 'phrases'} from note 103 to note 116${ignored} and removed "multiplier_note".`,
	})
	return fixed
}
