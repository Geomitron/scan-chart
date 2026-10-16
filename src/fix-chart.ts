import { chartAuthoredTracks, midiAuthoredTracks } from './chart/authored-view'
import { sameAsJson } from './chart/chart-analysis'
import { spliceChartText } from './chart/chart-edit'
import { chartSectionTrack, ChartFileTokens, ChartSectionToken } from './chart/chart-file-parser'
import { midiSourceTrackInstrument } from './chart/midi-file-parser'
import type { MidiTokens } from './chart/midi-tokens'
import { removeMidiTrackChunks } from './chart/midi-tokens'
import { msAtTick, parseChartSource, type ParsedChartFile, tickAtMs } from './chart/parse-chart-file'
import { parseRules } from './chart/parse-rules'
import { EventType, eventTypes } from './chart/raw-types'
import { NoteEvent, noteFlags, noteTypes } from './chart/types'
import { besideHopofreq, hopoTags, keyList } from './ini/ini-checks'
import { asUtf8Ini, rewriteSongIni } from './ini/ini-edit'
import { olderTags } from './ini/metadata'
import { writtenKey } from './ini/scan-ini'
import { chooseEdits, FixRecord, hashChanges, hashNames, issueFixTable } from './issue-fixes'
import type { Issue, IssueCode, MetadataFinding } from './issues'
import { songContext } from './song-context'
import { AuthoredElement, continueEdits, editSong, RawSongEditBatch, SongDocument, withSongIni } from './song-document'
import { songHashes } from './song-hashes'
import { Difficulty, getInstrumentType, Instrument, instrumentTypes } from './types'

type Track = ParsedChartFile['trackData'][number]

/** The chart as Clone Hero plays it, parsed with the song's settings, or `null` when it doesn't parse. */
function parsedChart(song: SongDocument): ParsedChartFile | null {
	const { chart } = songContext(song)
	return chart.kind === 'parsed' ? chart.parsed : null
}

/** A track as messages name it, such as "expert guitar", or "guitar" for a `.mid` track's every difficulty. */
const trackLabel = (track: { readonly instrument: Instrument; readonly difficulty: Difficulty | null }) =>
	track.difficulty === null ? track.instrument : `${track.difficulty} ${track.instrument}`

/** The `.chart` section a reader reads for a track. */
const chartSectionOf = (tokens: ChartFileTokens, instrument: Instrument, difficulty: Difficulty) =>
	chartAuthoredTracks(tokens).find(track => track.isRead && track.instrument === instrument && track.difficulty === difficulty)

/** The `.mid` track a reader reads for an instrument. */
const midiTrackOf = (tokens: MidiTokens, instrument: Instrument) => midiAuthoredTracks(tokens).find(track => track.isFirst && track.instrument === instrument)

const isFret = (instrument: Instrument) => getInstrumentType(instrument) !== instrumentTypes.drums

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
	const tracks = (chart: ParsedChartFile) => new Map(chart.trackData.map(track => [trackLabel(track), track]))
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
			const ranges = chart.tokens.sections.filter(section => chosen.includes(section.name)).map(section => ({ ...sectionRange(chart.tokens, section), text: '' }))
			return continueEdits(song, { ...song, chart: { ...chart, tokens: spliceChartText(chart.tokens, ranges) } })
		}
		const { song: fixed, chosen } = chooseEdits(song, names, apply, edited => keepsGameplay(song, edited, true),
			(name, problem) => record.skip('emptyTrack', chart.fileName, `Removing the [${name}] section ${problem}.`))
		for (const name of chosen) record.fixed.push({ code: 'emptyTrack', file: chart.fileName, description: `Removed the [${name}] section, which has no notes.` })
		return fixed
	}
	const { tokens } = chart
	if (tokens === null) return song
	const tracks = tokens.chunks.flatMap((chunk, index) => chunk.kind === 'track' ? [{ chunk, index }] : []).slice(1).flatMap(({ chunk, index }) => {
		// A track is named by its last name at tick 0.
		const names = chunk.events.filter(({ tick, event }) => tick === 0 && event.type === 'trackName').map(({ event }) => (event as { text: string }).text)
		const name = names[names.length - 1]
		const instrument = name === undefined ? null : midiSourceTrackInstrument(name)
		return instrument !== null && isReported(instrument, null) ? [{ name, index }] : []
	})
	const apply = (chosen: readonly { name: string; index: number }[]) => {
		const edited = removeMidiTrackChunks(tokens, chosen.map(track => track.index))
		return continueEdits(song, { ...song, chart: { ...chart, bytes: edited.data, tokens: edited } })
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

/** One phrase to remove: where it starts, and the authored events that write it. */
interface PhraseRemoval {
	readonly instrument: Instrument
	/** `null` for a `.mid` phrase, which every difficulty of the instrument shares. */
	readonly difficulty: Difficulty | null
	readonly tick: number
	readonly elements: readonly AuthoredElement[]
}

/**
 * Removes the phrases with no notes that `issueFixTable` names, such as star power (`emptyStarPower`). A `.mid` phrase,
 * which every difficulty shares, is removed only when it has no notes on any. A removal that changes a note, another
 * phrase or a canonical hash isn't made.
 */
export function fixEmptyPhrases(song: SongDocument, issues: readonly Issue[], record: FixRecord): SongDocument {
	let fixed = song
	for (const code of new Set(issues.map(issue => issue.code))) {
		const found = issues.filter(issue => issue.code === code && issue.instrument !== null && issue.difficulty !== null && issue.tick !== null)
		if (issueFixTable[code]?.phrases !== undefined && found.length > 0) fixed = removeEmptyPhrases(fixed, code, found, record)
	}
	return fixed
}

function removeEmptyPhrases(song: SongDocument, code: IssueCode, found: readonly Issue[], record: FixRecord): SongDocument {
	const { chart } = song
	const parsed = parsedChart(song)
	const { field, name } = issueFixTable[code]!.phrases!
	if (chart === null || parsed === null || (chart.format === 'mid' && chart.tokens === null)) return song
	const skip = (reason: string) => record.skip(code, chart.fileName, reason)
	/** The phrase's event types: a `.mid` track's star power is its solo notes where it reads them as star power. */
	const typesOf = (instrument: Instrument, events: readonly { scope?: string; type: EventType }[]): readonly EventType[] =>
		field === 'flexLanes' ? [eventTypes.flexLaneSingle, eventTypes.flexLaneDouble]
		: field === 'soloSections' || (chart.format === 'mid' && starPowerFromSolos(instrument, events, songContext(song).settings.multiplier_note)) ? [eventTypes.soloSection]
		: [eventTypes.starPower]
	const removals: PhraseRemoval[] = []
	if (chart.format === 'chart') {
		for (const { instrument, difficulty, tick } of found) {
			const events = chartSectionOf(chart.tokens, instrument!, difficulty!)?.events ?? []
			const elements = field === 'soloSections' ? soloEvents(events, tick!) : events.filter(event => event.tick === tick && typesOf(instrument!, []).includes(event.type))
			if (elements.length === 0) skip(`The ${difficulty} ${instrument} ${name} phrase at tick ${tick} isn't written as one event.`)
			else removals.push({ instrument: instrument!, difficulty, tick: tick!, elements })
		}
	} else {
		for (const key of new Set(found.map(issue => `${issue.instrument} ${issue.tick}`))) {
			const { instrument, tick } = found.find(issue => `${issue.instrument} ${issue.tick}` === key)!
			// A .mid phrase is every difficulty's: it's removed only when no difficulty's notes are in it.
			const holding = parsed.trackData.filter(track => track.instrument === instrument && track[field].some(phrase => phrase.tick === tick))
			if (holding.some(track => !found.some(issue => issue.instrument === instrument && issue.difficulty === track.difficulty && issue.tick === tick))) {
				skip(`The ${instrument} ${name} phrase at tick ${tick} has notes on another difficulty.`)
				continue
			}
			const events = midiTrackOf(chart.tokens!, instrument!)!.events
			const types = typesOf(instrument!, events)
			const elements = events.filter(event => event.scope === 'instrument' && event.tick === tick && types.includes(event.type))
			if (elements.length === 0) skip(`The ${instrument} ${name} phrase at tick ${tick} isn't written as one event.`)
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
		const after = new Map(parsedChart(edited)!.trackData.map(track => [trackLabel(track), track]))
		for (const track of parsed.trackData) {
			const removed = (tick: number) => chosen.some(removal => removal.instrument === track.instrument && (removal.difficulty ?? track.difficulty) === track.difficulty && removal.tick === tick)
			const expected = phraseRanges(track, field).filter(([tick]) => !removed(tick as number))
			if (!sameAsJson(phraseRanges(after.get(trackLabel(track))!, field), expected)) return `would change other ${trackLabel(track)} ${name} phrases`
		}
		return null
	}
	const { song: fixed, chosen } = chooseEdits(song, removals, apply, problem,
		(removal, problem) => skip(`Removing the ${trackLabel(removal)} ${name} phrase at tick ${removal.tick} ${problem}.`))
	for (const label of new Set(chosen.map(trackLabel))) {
		const ticks = chosen.filter(removal => trackLabel(removal) === label).map(removal => removal.tick)
		const one = ticks.length === 1
		record.fixed.push({ code, file: chart.fileName, description: `Removed the ${label} ${name} ${one ? 'phrase' : 'phrases'} with no notes at ${one ? 'tick' : 'ticks'} ${ticks.join(', ')}.` })
	}
	return fixed
}

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
function starPowerFromSolos(instrument: Instrument, events: readonly { scope?: string; type: EventType }[], multiplierNote: number): boolean {
	if (!isFret(instrument) || multiplierNote === 116) return false
	const count = (type: EventType) => events.filter(event => event.scope === 'instrument' && event.type === type).length
	return multiplierNote === 103 || (count(eventTypes.starPower) === 0 && count(eventTypes.soloSection) > 1)
}

/** The event type of each fret note type, as a `.chart` line or MIDI note writes it. */
const fretEventTypes = new Map<number, EventType>([
	[noteTypes.open, eventTypes.open], [noteTypes.green, eventTypes.green], [noteTypes.red, eventTypes.red], [noteTypes.yellow, eventTypes.yellow],
	[noteTypes.blue, eventTypes.blue], [noteTypes.orange, eventTypes.orange], [noteTypes.black1, eventTypes.black1], [noteTypes.black2, eventTypes.black2],
	[noteTypes.black3, eventTypes.black3], [noteTypes.white1, eventTypes.white1], [noteTypes.white2, eventTypes.white2], [noteTypes.white3, eventTypes.white3],
])

/** How a sustain fix changes a note: its new length in ticks, and why. */
type SustainChange = { length: number; reason: 'gap' | 'short' | 'leftShort' }

/** The sustains of one track to change. */
interface SustainEdits {
	readonly track: Track
	readonly changes: Map<NoteEvent, SustainChange>
}

/**
 * Shortens each sustain that ends less than `gapMs` before the next note to end `gapMs` before it (`badSustainGap`),
 * and removes each sustain shorter than `minMs` (`babySustain`), as the checks measure them. With `removeShort`, a
 * sustain the gap fix leaves shorter than `minMs` is removed too.
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
	const msAt = (tick: number) => msAtTick(parsed.tempos, parsed.resolution, tick)
	const tracks: SustainEdits[] = []
	for (const track of parsed.trackData.filter(track => isFret(track.instrument))) {
		const ticksOf = (code: IssueCode) => new Set(found.filter(issue => issue.code === code && issue.instrument === track.instrument && issue.difficulty === track.difficulty).map(issue => issue.tick))
		const [gapTicks, shortTicks] = [ticksOf('badSustainGap'), ticksOf('babySustain')]
		const changes: SustainEdits['changes'] = new Map()
		const held = new Set<NoteEvent>()
		track.noteEventGroups.forEach((group, index) => {
			if (shortTicks.has(group[0].tick)) {
				const nextOpen = track.noteEventGroups[index + 1]?.find(note => note.type === noteTypes.open)
				for (const note of group) {
					// The check doesn't count a short sustain before a HOPO or tap open note.
					const beforeOpen = nextOpen !== undefined && nextOpen.tick < note.tick + note.length && (nextOpen.flags & (noteFlags.hopo | noteFlags.tap)) !== 0
					if (note.msLength > 0 && note.msLength < minMs && !beforeOpen) changes.set(note, { length: 0, reason: 'short' })
				}
			}
			if (!gapTicks.has(group[0].tick)) return
			const start = group[0].msTime
			for (const earlier of track.noteEventGroups.slice(0, index)) {
				for (const note of earlier) {
					const end = note.msTime + note.msLength
					if (note.msLength <= 0 || note.type === noteTypes.open || start < end || start - end >= gapMs) continue
					const endTick = Math.max(note.tick, Math.floor(tickAtMs(parsed.tempos, parsed.resolution, start - gapMs)))
					// A sustain held over other notes would end too close to one of them.
					if (endTick > note.tick && track.noteEventGroups.some(other => other !== group && other[0].tick >= endTick && other[0].msTime < msAt(endTick) + gapMs)) {
						held.add(note)
						continue
					}
					const change: SustainChange = removeShort && msAt(endTick) - note.msTime < minMs ? { length: 0, reason: 'leftShort' } : { length: endTick - note.tick, reason: 'gap' }
					const previous = changes.get(note)
					if (previous === undefined || change.length < previous.length) changes.set(note, change)
				}
			}
		})
		if (held.size > 0) {
			const one = held.size === 1
			record.skip('badSustainGap', chart.fileName, `${held.size} ${trackLabel(track)} ${one ? 'sustain is' : 'sustains are'} held over other notes: `
				+ `shortening ${one ? 'it' : 'them'} would end ${one ? 'it' : 'them'} too close to one.`)
		}
		// A note the parser moved or made, such as a snapped chord's note or a forced open note, has no event of its own.
		for (const [note, { reason }] of changes) {
			if (authoredNotes(song, track, note).length > 0) continue
			changes.delete(note)
			record.skip(reason === 'short' ? 'babySustain' : 'badSustainGap', chart.fileName, `The ${trackLabel(track)} note at tick ${note.tick} isn't written as a note of its type and tick.`)
		}
		if (changes.size > 0) tracks.push({ track, changes })
	}

	const apply = (chosen: readonly SustainEdits[]) => editSong(song, batch => {
		for (const { track, changes } of chosen) {
			for (const [note, { length }] of changes) for (const event of authoredNotes(song, track, note)) batch.setLength(event, length)
		}
	})
	// Each note changed is no longer than asked for, and every other note and phrase stays.
	const problem = (edited: SongDocument, chosen: readonly SustainEdits[]) => {
		const after = parsedChart(edited)
		if (after === null) return 'would make the chart unreadable'
		const tracksAfter = new Map(after.trackData.map(track => [trackLabel(track), track]))
		const expected = parsed.trackData.map(track => {
			const asked = chosen.find(edits => edits.track === track)?.changes
			const notesAfter = tracksAfter.get(trackLabel(track))?.noteEventGroups.flat() ?? []
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
		const codes = new Set([...edits.changes.values()].map(change => change.reason === 'short' ? 'babySustain' : 'badSustainGap' as const))
		for (const code of codes) record.skip(code, chart.fileName, `Changing the ${trackLabel(edits.track)} sustains ${problem}.`)
	})
	for (const { track, changes } of chosen) {
		const count = (reason: SustainChange['reason']) => [...changes.values()].filter(change => change.reason === reason).length
		const sustains = (count: number) => `${count} ${trackLabel(track)} ${count === 1 ? 'sustain' : 'sustains'}`
		const [gaps, short, leftShort] = [count('gap'), count('short'), count('leftShort')]
		// A sustain the gap fix left too short is shortened, then removed: both are listed.
		if (gaps + leftShort > 0) record.fixed.push({ code: 'badSustainGap', file: chart.fileName, description: `Shortened ${sustains(gaps + leftShort)} to end ${gapMs} ms before the next note.` })
		if (short > 0) record.fixed.push({ code: 'babySustain', file: chart.fileName, description: `Removed ${sustains(short)} shorter than ${minMs} ms.` })
		if (leftShort > 0) record.fixed.push({ code: 'babySustain', file: chart.fileName, description: `Removed ${sustains(leftShort)} that shortening left shorter than ${minMs} ms.` })
	}
	return fixed
}

/** The authored events of a parsed fret note: its `.chart` lines, or its MIDI notes on its difficulty. */
function authoredNotes(song: SongDocument, track: Track, note: NoteEvent): (AuthoredElement & { length: number })[] {
	const { chart } = song
	const type = fretEventTypes.get(note.type)
	if (chart === null || type === undefined) return []
	if (chart.format === 'chart') return chartSectionOf(chart.tokens, track.instrument, track.difficulty)?.events.filter(event => event.tick === note.tick && event.type === type) ?? []
	const midiTrack = chart.tokens === null ? undefined : midiTrackOf(chart.tokens, track.instrument)
	return midiTrack?.events.filter(event => event.scope === track.difficulty && event.tick === note.tick && event.type === type) ?? []
}

/** Whether a `deprecatedIniTag` finding is about one of `keys`. */
export const reportsDeprecatedTag = (findings: readonly MetadataFinding[], keys: readonly string[]) =>
	findings.some(finding => finding.metadataIssue === 'deprecatedIniTag' && finding.keys?.some(key => keys.includes(key)))

/** Whether a deprecated tag's issue that one of `keys` is about is reported. */
const isTagReported = (issues: readonly Issue[], findings: readonly MetadataFinding[], keys: readonly string[]) =>
	issues.some(issue => issue.code === 'deprecatedIniTag') && reportsDeprecatedTag(findings, keys)

/**
 * The song with `edit` made to its chart and `keys` removed from song.ini, if it plays the same, phrases and canonical
 * hashes included; otherwise what's wrong, ending a sentence about the rewrite.
 */
function withoutTags(song: SongDocument, keys: readonly string[], edit: (batch: RawSongEditBatch) => void): { song: SongDocument } | { problem: string } {
	let fixed: SongDocument
	try {
		const tokens = rewriteSongIni(asUtf8Ini(song.ini!.tokens), { layout: false, order: false, remove: new Set(keys), set: new Map() })
		const edited = editSong(song, edit)
		fixed = continueEdits(edited, withSongIni(edited, tokens))
	} catch (error) {
		return { problem: `fails: ${error instanceof Error ? error.message : String(error)}` }
	}
	const problem = keepsGameplay(song, fixed, true)
	return problem === null ? { song: fixed } : { problem }
}

/**
 * A song rewritten to play the same without deprecated song.ini tags, phrases and canonical hashes included: the song,
 * the chart file it rewrote, the tags it removed and what the rewrite counts; or why it isn't rewritten.
 */
export type TagRewrite<Counts> = ({ readonly song: SongDocument; readonly file: string; readonly keys: readonly string[] } & Counts) | { readonly reason: string }

/**
 * Forces the notes whose HOPO or strum `hopo_frequency` or `eighthnote_hopo` changes, then removes the tags
 * (`deprecatedIniTag`), as `rewriteHopoTags` does.
 */
export function fixHopoTags(song: SongDocument, issues: readonly Issue[], findings: readonly MetadataFinding[], record: FixRecord): SongDocument {
	const { ini } = song
	if (!isTagReported(issues, findings, hopoTags) || ini === null) return song
	const rewritten = rewriteHopoTags(song)
	if ('reason' in rewritten) {
		record.skip('deprecatedIniTag', ini.fileName, rewritten.reason)
		return song
	}
	const { file, keys, forced } = rewritten
	const tags = keyList(keys)
	record.fixed.push({
		code: 'deprecatedIniTag',
		file,
		description: forced === 0
			? `Removed ${tags}, without which every note reads the same.`
			: `Forced ${forced} ${forced === 1 ? 'note' : 'notes'} to play the same without ${tags}, and removed ${keys.length === 1 ? 'it' : 'them'}.`,
	})
	return rewritten.song
}

/**
 * Forces the notes whose HOPO or strum `hopo_frequency` or `eighthnote_hopo` changes, then removes the tags, so every
 * note plays the same. A `.chart` note's `N 5` line, which swaps HOPO and strum, is added or removed; a `.mid` note gets
 * a one-tick force HOPO or force strum note on its difficulty. Beside `hopofreq`, which YARG reads without them, the
 * tags stay. Counts the notes it forced. The song has a song.ini.
 */
export function rewriteHopoTags(song: SongDocument): TagRewrite<{ readonly forced: number }> {
	const context = songContext(song)
	const { chart } = song
	if (besideHopofreq(context.ini.songSection ?? {})) {
		return { reason: 'YARG reads "hopofreq" when song.ini has neither "hopo_frequency" nor "eighthnote_hopo", so they stay.' }
	}
	if (chart === null || context.chart.kind !== 'parsed' || (chart.format === 'mid' && chart.tokens === null)) {
		return { reason: 'The chart can\'t be read, so it can\'t be rewritten to play the same without the HOPO tags.' }
	}
	const { settings } = context
	// Without hopo_frequency, eighthnote_hopo = True would apply, so it goes too.
	const keys = [...settings.hopo_frequency > 0 ? ['hopo_frequency'] : [], ...settings.eighthnote_hopo ? ['eighthnote_hopo'] : []]
	const withTags = context.chart.parsed
	const without = parseChartSource(context.chart.source, { ...settings, hopo_frequency: 0, eighthnote_hopo: false }, parseRules.canonical20260801)
	let forced = 0
	const result = withoutTags(song, keys, batch => {
		forced = 0
		for (const track of withTags.trackData.filter(track => isFret(track.instrument))) {
			const plain = without.trackData.find(candidate => trackLabel(candidate) === trackLabel(track))
			if (plain === undefined || plain.noteEventGroups.length !== track.noteEventGroups.length) throw new RangeError(`the ${trackLabel(track)} notes don't line up`)
			track.noteEventGroups.forEach((group, index) => {
				const hopoOrStrum = (flags: number) => flags & (noteFlags.hopo | noteFlags.strum)
				const plainGroup = plain.noteEventGroups[index]
				if (plainGroup[0].tick !== group[0].tick) throw new RangeError(`the ${trackLabel(track)} notes don't line up`)
				if (hopoOrStrum(group[0].flags) === hopoOrStrum(plainGroup[0].flags)) return
				forced++
				const tick = group[0].tick
				if (chart.format === 'chart') {
					const section = chartSectionOf(chart.tokens, track.instrument, track.difficulty)!
					const unnatural = section.events.filter(event => event.tick === tick && event.type === eventTypes.forceUnnatural)
					if (unnatural.length > 0) for (const event of unnatural) batch.remove(event)
					else batch.addToChartSection(section.section, tick, eventTypes.forceUnnatural, 0)
				} else {
					const type = group[0].flags & noteFlags.hopo ? eventTypes.forceHopo : eventTypes.forceStrum
					batch.addToMidiTrack(midiTrackOf(chart.tokens!, track.instrument)!.chunk, track.difficulty, tick, type, 1)
				}
			})
		}
	})
	if ('problem' in result) return { reason: `Rewriting the chart to play the same without ${keyList(keys)} ${result.problem}.` }
	return { song: result.song, file: chart.fileName, keys, forced }
}

/**
 * Moves a `.mid` file's star power from note 103 to note 116 and removes `multiplier_note`, or its older name
 * `star_power_note` (`deprecatedIniTag`), as `rewriteMultiplierNote` does.
 */
export function fixMultiplierNote(song: SongDocument, issues: readonly Issue[], findings: readonly MetadataFinding[], record: FixRecord): SongDocument {
	const { ini } = song
	const { settings, ini: { songSection } } = songContext(song)
	// The issue is about the line games read: the tag, or its older name without it.
	const read = writtenKey(songSection ?? {}, 'multiplier_note')
	if (settings.multiplier_note !== 103 || !isTagReported(issues, findings, [read]) || ini === null) return song
	const rewritten = rewriteMultiplierNote(song)
	if ('reason' in rewritten) {
		record.skip('deprecatedIniTag', ini.fileName, rewritten.reason)
		return song
	}
	const { file, keys, moved, dropped } = rewritten
	const ignored = dropped === 0 ? '' : `, removed ${dropped} ${dropped === 1 ? 'note' : 'notes'} 116 that "${read} = 103" made games ignore,`
	record.fixed.push({
		code: 'deprecatedIniTag',
		file,
		description: `Moved ${moved} star power ${moved === 1 ? 'phrase' : 'phrases'} from note 103 to note 116${ignored} and removed ${keyList(keys)}.`,
	})
	return rewritten.song
}

/**
 * Moves a `.mid` file's star power from note 103 to note 116 in each guitar and keys track, removes the notes 116 there,
 * which `multiplier_note = 103` makes games ignore, then removes the tag and its older name `star_power_note`, so
 * neither is left to read. The drums tracks keep their notes 103, which mark solos whatever the tag. Counts the phrases
 * it moved and the notes 116 it removed. The song has a song.ini.
 */
export function rewriteMultiplierNote(song: SongDocument): TagRewrite<{ readonly moved: number; readonly dropped: number }> {
	const { chart } = song
	if (chart?.format !== 'mid' || chart.tokens === null) return { reason: 'The chart isn\'t a .mid file that can be read, so its star power can\'t be moved to note 116.' }
	const { songSection } = songContext(song).ini
	const keys = ['multiplier_note', olderTags.get('multiplier_note')!].filter(key => songSection?.[key] !== undefined)
	const tokens = chart.tokens
	let [moved, dropped] = [0, 0]
	const result = withoutTags(song, keys, batch => {
		[moved, dropped] = [0, 0]
		for (const track of midiAuthoredTracks(tokens).filter(track => track.isFirst && isFret(track.instrument))) {
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
	if ('problem' in result) return { reason: `Moving the star power to note 116 ${result.problem}.` }
	return { song: result.song, file: chart.fileName, keys, moved, dropped }
}
