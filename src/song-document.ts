
import type { MidiEvent } from '@geomitron/midi-file'

import {
	type AuthoredSource,
	type AuthoredTempo,
	type AuthoredTextEvent,
	type AuthoredTimeSignature,
	midiAuthoredTracks,
} from './chart/authored-view'
import {
	appendChartSections,
	chartEventEdits,
	chartEventInsertEdit,
	chartLineInsertEdit,
	ChartValueChange,
	chartValueText,
	editChartLines,
} from './chart/chart-edit'
import { chartSectionName, ChartFileTokens, readChartSongEntries, tokenizeChartFile } from './chart/chart-file-parser'
import { recordEdit } from './chart/edit-history'
import {
	editMidiTrack,
	midiEventEdits,
	midiEventEncoding,
	midiEventInserts,
	midiTempoEvent,
	midiTextEvent,
	midiTimeSignatureEvent,
	MidiTrackEdit,
} from './chart/midi-edit'
import { findMidiEventsTrack, isTextLikeEvent } from './chart/midi-file-parser'
import { addMidiTrackChunks, MidiTokens, midiTokensToMidiData, readMidiTokens, serializeMidiTokens } from './chart/midi-tokens'
import { midiInstrumentTrackNames } from './chart/midi-track-names'
import { chartSongIniEntries } from './ini/chart-song-entries'
import { appendSongIniSection, hasSongIniSection, setSongIniValue } from './ini/ini-edit'
import { defaultMetadata } from './ini/metadata'
import { IniTokens, tokenizeIni } from './ini/parse-ini'
import { findIniData } from './ini/scan-ini'
import { getBasename, getExtension, hasChartExtension, hasChartName, hasIniExtension } from './shared/file-names'
import { type EventType, eventTypes } from './chart/raw-types'
import { assertMeaningful, type AuthoredEventType, type AuthoredTrack, authoredTracks, eventTypeOf } from './authored'
import { ObjectCache } from './shared/object-cache'
import { fileBytes, isByteSource, readFileBytes, type SongFile } from './song-files'
import { type Difficulty, type FolderIssueType, getInstrumentType, type Instrument } from './types'

/** The chart file of a song, tokenized in its format. */
export type ChartDocument =
	| { readonly format: 'chart'; readonly fileName: string; readonly tokens: ChartFileTokens }
	| {
		readonly format: 'mid'
		readonly fileName: string
		readonly bytes: Uint8Array
		/** Every chunk of the file, unknown types included, or `null` when the file can't be read as MIDI. */
		readonly tokens: MidiTokens | null
		readonly readError: string | null
	}

/** The song.ini of a song, tokenized. */
export interface IniDocument {
	readonly fileName: string
	readonly tokens: IniTokens
}

/**
 * A song folder as a document: the chart file and song.ini that Clone Hero reads, tokenized, and every file as
 * given. Every view of the song is derived from it.
 */
export interface SongDocument {
	/** Every file of the folder, in the order given. Files scan-chart doesn't read can stay byte sources. */
	readonly files: readonly SongFile[]
	/** The chart file Clone Hero reads, or `null` when the folder has none. */
	readonly chart: ChartDocument | null
	/** The song.ini Clone Hero reads, or `null` when the folder has none. */
	readonly ini: IniDocument | null
}

/**
 * Parses a song folder into a document. Only the chart and .ini files are read; other files, such as audio, video
 * and album art, can be byte sources, and are read only when something needs them. Never rejects: a malformed chart
 * or song.ini is reported when it's read.
 */
export async function parseSong(files: readonly SongFile[]): Promise<SongDocument> {
	const read = await Promise.all(files.map(async file =>
		!isByteSource(file.data) || !(hasChartExtension(file.fileName) || hasIniExtension(file.fileName)) ? file
		: { fileName: file.fileName, data: await readFileBytes(file) }))
	return parseSongFiles(read)
}

/** `parseSong` for a folder whose chart and .ini files are already bytes. */
export function parseSongFiles(files: readonly SongFile[]): SongDocument {
	const { chartFile, format } = findChartData(files)
	const { iniFile } = findIniData(files)
	return {
		files,
		chart: chartFile === null ? null
			: format === 'mid' ? { format, fileName: chartFile.fileName, bytes: fileBytes(chartFile), ...tokenizeMidi(fileBytes(chartFile)) }
			: { format: 'chart', fileName: chartFile.fileName, tokens: tokenizeChartFile(fileBytes(chartFile)) },
		ini: iniFile === null ? null : { fileName: iniFile.fileName, tokens: tokenizeIni(fileBytes(iniFile)) },
	}
}

/** Writes a song document back to files: an unedited document gives back every file byte for byte. */
export function documentFiles(song: SongDocument): SongFile[] {
	return song.files.map(file =>
		file.fileName === song.chart?.fileName ? { fileName: file.fileName, data: chartBytes(song.chart) }
		: file.fileName === song.ini?.fileName ? { fileName: file.fileName, data: song.ini.tokens.bytes }
		: file)
}

function chartBytes(chart: ChartDocument): Uint8Array {
	if (chart.format === 'chart') return chart.tokens.bytes
	return chart.tokens === null ? chart.bytes : serializeMidiTokens(chart.tokens)
}

function tokenizeMidi(bytes: Uint8Array): { tokens: MidiTokens | null; readError: string | null } {
	try {
		return { tokens: readMidiTokens(bytes, 'skip'), readError: null }
	} catch (error) {
		return { tokens: null, readError: error instanceof Error ? error.message : String(error) }
	}
}

/** Chooses the chart file Clone Hero reads from a song folder, and reports problems with the folder's chart files. */
export function findChartData(files: readonly SongFile[]) {
	const folderIssues: { folderIssue: FolderIssueType; description: string }[] = []

	// Like Clone Hero, prefer a file named "notes" in any letter case, and .mid over .chart when both exist.
	const preference = (f: SongFile) => [
		getBasename(f.fileName).toLowerCase() === 'notes',
		getExtension(f.fileName).toLowerCase() === 'mid',
		hasChartName(f.fileName),
	]
	const chartFiles = files.filter(f => hasChartExtension(f.fileName)).sort((a, b) => {
		const [preferenceA, preferenceB] = [preference(a), preference(b)]
		const differing = preferenceA.findIndex((value, index) => value !== preferenceB[index])
		return differing === -1 ? 0 : preferenceA[differing] ? -1 : 1
	})

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
		return { chartFile: null, format: null, folderIssues }
	} else {
		return {
			chartFile: chartFiles[0],
			format: (getExtension(chartFiles[0].fileName).toLowerCase() === 'mid' ? 'mid' : 'chart') as 'mid' | 'chart',
			folderIssues,
		}
	}
}

/** An authored element an edit can move or remove: an event, text event, tempo or time signature. */
export interface AuthoredElement {
	readonly tick: number
	/** Absent for an element written as one event or line with no length, such as a tempo. */
	readonly length?: number
	readonly source: AuthoredSource
}

/** The edits one call of `editSong` collects; they apply together, as one change. */
export interface SongEditBatch {
	/** Moves an authored element, keeping its length. */
	setTick(element: AuthoredElement, tick: number): void
	/** Changes an authored event's length. */
	setLength(event: AuthoredElement & { readonly length: number }, length: number): void
	/** Removes an authored element. */
	remove(element: AuthoredElement): void
	/**
	 * Changes a tempo marker's tempo. It's rounded to what the format holds: thousandths of a BPM in `.chart`, whole
	 * microseconds per beat in `.mid`.
	 */
	setTempo(tempo: AuthoredTempo, beatsPerMinute: number): void
	/** Changes a time signature. The denominator is a power of two. */
	setTimeSignature(timeSignature: AuthoredTimeSignature, numerator: number, denominator: number): void
	/** Changes a text event's text. */
	setText(textEvent: AuthoredTextEvent, text: string): void
	/** Adds a tempo marker to the `[SyncTrack]` section or the conductor track, rounded as `setTempo` rounds. */
	addTempo(tick: number, beatsPerMinute: number): void
	/** Adds a time signature to the `[SyncTrack]` section or the conductor track. */
	addTimeSignature(tick: number, numerator: number, denominator: number): void
	/** Adds a text event, such as a practice section, to the `[Events]` section or the events track. */
	addTextEvent(tick: number, text: string): void
	/**
	 * Adds a track for an instrument and difficulty, and returns it, so `addEvent` can fill it in the same batch.
	 *
	 * - In a `.chart` file, it's an empty section, such as `[ExpertSingle]`, at the end of the file. An empty section of
	 *   that name that Clone Hero reads is returned instead.
	 * - In a `.mid` file, a track holds every difficulty: a new one, such as `PART GUITAR`, goes after the last track.
	 *   When the instrument has a track, that one is returned. Either way, the returned track's `difficulty` is the one
	 *   asked for, so `addEvent` adds to that difficulty.
	 *
	 * Throws a `RangeError` when Clone Hero already reads events for that instrument and difficulty.
	 */
	addTrack(instrument: Instrument, difficulty: Difficulty): AuthoredTrack
	/**
	 * Adds a note, note modifier or phrase to a track from `authoredTracks` or `addTrack`. It's refused, with the reason, when it
	 * means nothing on the track's instrument or the format can't write it. A `.mid` track holds every difficulty, so
	 * `scope` says which one, or `instrument`; an event the format stores once for the instrument, such as star power,
	 * is added for the instrument whichever difficulty asks. A `.mid` note's velocity defaults to 100 and its channel
	 * to 0.
	 */
	addEvent(
		track: AuthoredTrack,
		tick: number,
		type: AuthoredEventType,
		length: number,
		options?: { readonly scope?: Difficulty | 'instrument'; readonly velocity?: number; readonly channel?: number },
	): void
	/**
	 * Sets a song.ini value, as song.ini's text (a time in milliseconds, a difficulty as a whole number), or removes it
	 * with `null`. A song without song.ini gets one, holding the `.chart` `[Song]` values Clone Hero read, so only the
	 * edited value reads differently. A value song.ini can't hold as written, such as one with a line break, is refused.
	 */
	setMetadata(key: SongMetadataKey, value: string | null): void
}

/**
 * `SongEditBatch` with additions by position in the file's tokens and by the parser's numeric event types, which
 * scan-chart's own tools and tests use. The public `editSong` offers only `SongEditBatch`.
 */
export interface RawSongEditBatch extends SongEditBatch {
	/** Adds an event to a `.chart` instrument section, by the section's index in the file's tokens. */
	addToChartSection(section: number, tick: number, type: EventType, length: number): void
	/**
	 * Adds an event to a `.mid` instrument track, by the track chunk's index in the file's tokens. An event type the
	 * format stores once for the instrument, such as star power, is added for the instrument whichever difficulty
	 * asks. A note's velocity defaults to 100 and its channel to 0.
	 */
	addToMidiTrack(
		chunk: number,
		scope: Difficulty | 'instrument',
		tick: number,
		type: EventType,
		length: number,
		note?: { readonly velocity: number; readonly channel: number },
	): void
}

/** A song.ini key scan-chart reads. */
export type SongMetadataKey = keyof typeof defaultMetadata

type ElementChange = { tick?: number; length?: number; value?: ChartValueChange }
type ChartChange = { element: AuthoredElement; change: ElementChange | 'remove' }
type ChartAddition = { section: number; tick: number; type: EventType; length: number }
type MidiAddition = Parameters<RawSongEditBatch['addToMidiTrack']>
type SongEventAddition = { tick: number; value: ChartValueChange }

/**
 * Applies a batch of edits to a song's chart and song.ini and returns the edited song, leaving `song` unchanged: the
 * earlier document is the undo step. Every byte the edits don't touch is kept, and an empty batch returns `song`.
 *
 * Throws if an edit doesn't fit the chart's format, such as a length on a `.chart` text event.
 */
export function editSong(song: SongDocument, collect: (batch: RawSongEditBatch) => void): SongDocument {
	const { chart } = song
	// Changes to one element merge, so setting its tick and its length or value in one batch does both.
	const changesBySource = new Map<string, ChartChange>()
	const change = (element: AuthoredElement, update: ElementChange | 'remove') => {
		const { source } = element
		const key = source.format === 'chart' ? `${source.section}:${source.line}` : `${source.chunk}:${source.events[0]}`
		const earlier = changesBySource.get(key)?.change
		if (earlier === 'remove') throw new RangeError('The element is already removed in this batch')
		changesBySource.set(key, { element, change: update === 'remove' ? update : { ...earlier, ...update } })
	}
	const additions: ChartAddition[] = []
	const midiAdditions: MidiAddition[] = []
	const songAdditions: SongEventAddition[] = []
	const metadataEdits = new Map<string, string | null>()
	const newTracks: string[] = []
	const addedTracks = new Map<string, AuthoredTrack>()
	collect({
		setTick: (element, tick) => change(element, { tick }),
		setLength: (event, length) => change(event, { length }),
		remove: element => change(element, 'remove'),
		setTempo: (tempo, beatsPerMinute) => change(tempo, { value: { beatsPerMinute } }),
		setTimeSignature: (timeSignature, numerator, denominator) => change(timeSignature, { value: { numerator, denominator } }),
		setText: (textEvent, text) => change(textEvent, { value: { text } }),
		addTempo: (tick, beatsPerMinute) => songAdditions.push({ tick, value: { beatsPerMinute } }),
		addTimeSignature: (tick, numerator, denominator) => songAdditions.push({ tick, value: { numerator, denominator } }),
		addTextEvent: (tick, text) => songAdditions.push({ tick, value: { text } }),
		addTrack: (instrument, difficulty) => {
			if (chart === null) throw new RangeError('The song has no chart to add a track to')
			const key = `${instrument}:${difficulty}`
			const added = addedTracks.get(key)
			if (added !== undefined) return added
			const track = trackToAdd(chart, instrument, difficulty, newTracks)
			addedTracks.set(key, track)
			return track
		},
		addEvent: (track, tick, type, length, options = {}) => {
			const eventType = eventTypeOf(type)
			assertMeaningful(track.instrument, eventType)
			if (track.location.format === 'chart') {
				additions.push({ section: track.location.section, tick, type: eventType, length })
				return
			}
			const scope = options.scope ?? track.difficulty
			if (scope === null) throw new RangeError('A .mid track holds every difficulty, so say which one the event is for')
			const note = { velocity: options.velocity ?? 100, channel: options.channel ?? 0 }
			midiAdditions.push([track.location.chunk, scope, tick, eventType, length, note])
		},
		addToChartSection: (section, tick, type, length) => additions.push({ section, tick, type, length }),
		addToMidiTrack: (...addition) => midiAdditions.push(addition),
		setMetadata: (key, value) => {
			if (!Object.prototype.hasOwnProperty.call(defaultMetadata, key)) throw new RangeError(`"${key}" isn't a song.ini key scan-chart reads`)
			metadataEdits.set(key, value)
		},
	})
	const changes = [...changesBySource.values()]

	let edited = song
	if (changes.length || additions.length || midiAdditions.length || songAdditions.length || newTracks.length) {
		if (chart === null) throw new RangeError('The song has no chart to edit')
		edited = { ...song, chart: editChart(chart, newTracks, changes, additions, midiAdditions, songAdditions) }
	}
	if (metadataEdits.size) edited = editMetadata(edited, metadataEdits)
	if (edited !== song) origins.set(edited, origins.get(song) ?? { song, hashes: undefined })
	return edited
}

/**
 * Where a chain of edits started: the song `parseSong` returned, until saving has calculated its hashes, which every
 * edit of it shares. Then the song is let go, so a chain of edits keeps one earlier version alive at most.
 */
export interface SongOrigin {
	song: SongDocument | null
	hashes: ReadonlyMap<string, string> | null | undefined
}

const origins = new ObjectCache<SongDocument, SongOrigin>('songOrigin')

/** Where `song`'s chain of edits started, or `undefined` for a song no edit made. */
export function songOrigin(song: SongDocument): SongOrigin | undefined {
	return origins.get(song)
}

/**
 * The track `addTrack` returns, and the name of the section or MIDI track to add for it, pushed onto `newTracks`,
 * which holds the names added so far in the batch: they go at the end, after the existing ones, in order.
 */
function trackToAdd(chart: ChartDocument, instrument: Instrument, difficulty: Difficulty, newTracks: string[]): AuthoredTrack {
	const already = () => new RangeError(`The chart already has ${difficulty} ${instrument} events`)
	if (chart.format === 'chart') {
		const name = chartSectionName(instrument, difficulty)
		const read = authoredTracks(chart).find(track => track.isRead && track.location.format === 'chart' && chart.tokens.sections[track.location.section].name === name)
		if (read !== undefined) {
			if (read.events.length > 0) throw already()
			return read
		}
		newTracks.push(name)
		const section = chart.tokens.sections.length + newTracks.length - 1
		return { instrument, difficulty, isRead: true, events: [], textEvents: [], location: { format: 'chart', section } }
	}
	if (chart.tokens === null) throw new RangeError('The .mid file can\'t be read, so it can\'t be edited')
	const read = authoredTracks(chart).find(track => track.isRead && track.instrument === instrument)
	if (read !== undefined) {
		if (read.events.some(event => event.scope === difficulty)) throw already()
		return { ...read, difficulty }
	}
	newTracks.push(midiInstrumentTrackNames[instrument])
	const lastTrack = chart.tokens.chunks.reduce((last, chunk, index) => chunk.kind === 'track' ? index : last, -1)
	const chunk = lastTrack + newTracks.length
	return { instrument, difficulty, isRead: true, events: [], textEvents: [], location: { format: 'mid', chunk } }
}

function editChart(
	chart: ChartDocument,
	newTracks: readonly string[],
	changes: readonly ChartChange[],
	additions: readonly ChartAddition[],
	midiAdditions: readonly MidiAddition[],
	songAdditions: readonly SongEventAddition[],
): ChartDocument {
	if (chart.format === 'chart') {
		if (midiAdditions.length) throw new RangeError('A .chart file has no MIDI tracks to add to')
		// New sections go at the end, so every section the other edits name keeps its index.
		const tokens = appendChartSections(chart.tokens, newTracks)
		// Clone Hero reads the last section of each name.
		const lastSection = (name: string) => {
			const section = tokens.sections.reduce((last, candidate, index) => candidate.name === name ? index : last, -1)
			if (section === -1) throw new RangeError(`The .chart file has no [${name}] section to add to`)
			return section
		}
		const edits = [
			...changes.flatMap(({ element, change }) => {
				if (element.source.format !== 'chart') throw new RangeError('The element isn\'t from this chart')
				const source = element.source
				return change === 'remove'
					? [{ kind: 'delete' as const, section: source.section, line: source.line }]
					: chartEventEdits(tokens, { ...element, source }, change)
			}),
			...additions.map(({ section, tick, type, length }) => chartEventInsertEdit(tokens, section, tick, type, length)),
			...songAdditions.map(({ tick, value }) =>
				chartLineInsertEdit(tokens, lastSection('text' in value ? 'Events' : 'SyncTrack'), tick, chartValueText(null, value))),
		]
		const edited = editChartLines(tokens, edits)
		recordEdit(chart.tokens, edited)
		return { ...chart, tokens: edited }
	}

	if (additions.length) throw new RangeError('A .mid file has no .chart sections to add to')
	if (chart.tokens === null) throw new RangeError('The .mid file can\'t be read, so it can\'t be edited')
	// New tracks go after the last track, so every track the other edits name keeps its index.
	const midiTokens = addMidiTrackChunks(chart.tokens, newTracks)
	const byChunk = new Map<number, MidiTrackEdit[]>()
	const editsOf = (chunk: number) => {
		let chunkEdits = byChunk.get(chunk)
		if (!chunkEdits) byChunk.set(chunk, chunkEdits = [])
		return chunkEdits
	}
	for (const { element, change } of changes) {
		if (element.source.format !== 'mid') throw new RangeError('The element isn\'t from this chart')
		const source = element.source
		const chunkEdits = editsOf(source.chunk)
		if (change === 'remove') {
			for (const index of new Set(source.events)) chunkEdits.push({ kind: 'delete', event: index })
			continue
		}
		for (const edit of midiEventEdits({ ...element, source }, change)) chunkEdits.push(edit)
		if (change.value) {
			const chunk = midiTokens.chunks[source.chunk]
			const original = chunk.kind === 'track' ? chunk.events[source.events[0]].event : undefined
			chunkEdits.push({ kind: 'replace', event: source.events[0], with: midiValueEvent(change.value, original) })
		}
	}
	const tracks = midiAdditions.length ? midiAuthoredTracks(midiTokens) : []
	for (const [chunk, scope, tick, type, length, note] of midiAdditions) {
		const track = tracks.find(candidate => candidate.chunk === chunk)
		if (!track) throw new RangeError('The chunk isn\'t an instrument track')
		const enhancedOpens = track.enhancedOpensFrom !== null && tick >= track.enhancedOpensFrom
		const encoded = midiEventEncoding(getInstrumentType(track.instrument), scope, type, enhancedOpens)
		if (!encoded) {
			const typeName = Object.keys(eventTypes).find(name => eventTypes[name as keyof typeof eventTypes] === type)
			throw new RangeError(`A .mid ${track.instrument} track can't hold a ${typeName} event${scope === 'instrument' ? '' : ` on ${scope}`}`)
		}
		const chunkEdits = editsOf(chunk)
		for (const edit of midiEventInserts(encoded.encoding, tick, length, note)) chunkEdits.push(edit)
	}
	if (songAdditions.length) {
		// Clone Hero reads tempos and time signatures from the first track, and text events from the first events track.
		const trackChunks = midiTokens.chunks.flatMap((chunk, index) => chunk.kind === 'track' ? [index] : [])
		const eventsTrack = songAdditions.some(({ value }) => 'text' in value) ? findMidiEventsTrack(midiTokensToMidiData(midiTokens)) : null
		for (const { tick, value } of songAdditions) {
			const chunk = 'text' in value ? (eventsTrack === null ? undefined : trackChunks[eventsTrack]) : trackChunks[0]
			if (chunk === undefined) throw new RangeError(`The .mid file has no ${'text' in value ? 'events track' : 'tracks'} to add to`)
			editsOf(chunk).push({ kind: 'insert', tick, event: midiValueEvent(value) })
		}
	}
	let tokens = midiTokens
	for (const [chunk, edits] of byChunk) tokens = editMidiTrack(tokens, chunk, edits)
	recordEdit(chart.tokens, tokens)
	return { ...chart, bytes: tokens.data, tokens }
}

/**
 * Applies song.ini edits to the song.ini Clone Hero reads. A song without one gets `song.ini`, and a song.ini without
 * a `[song]` section gets one, holding the `[Song]` values Clone Hero read before the edits.
 */
function editMetadata(song: SongDocument, edits: ReadonlyMap<string, string | null>): SongDocument {
	let tokens = songIniWithSection(song)
	for (const [key, value] of edits) tokens = setSongIniValue(tokens, key, value)!
	return withSongIni(song, tokens)
}

/** The song.ini Clone Hero reads: `song.ini` in any letter case. */
function cloneHeroSongIni(song: SongDocument): IniDocument | null {
	return song.ini !== null && song.ini.fileName.toLowerCase() === 'song.ini' ? song.ini : null
}

/**
 * The tokens of the song.ini Clone Hero reads, with a `[song]` section: a song.ini without one gets one, and a song
 * without song.ini a new file, holding the `.chart` `[Song]` values Clone Hero read, so they still read the same.
 */
export function songIniWithSection(song: SongDocument): IniTokens {
	const tokens = cloneHeroSongIni(song)?.tokens ?? tokenizeIni(new Uint8Array(0))
	if (hasSongIniSection(tokens)) return tokens
	const { chart } = song
	return appendSongIniSection(tokens, chart?.format === 'chart' ? chartSongIniEntries(readChartSongEntries(chart.tokens.bytes)) : [])
}

/** The song with `tokens` as the song.ini Clone Hero reads, added as `song.ini` when it has none. */
export function withSongIni(song: SongDocument, tokens: IniTokens): SongDocument {
	const ini = cloneHeroSongIni(song)
	if (ini !== null) return { ...song, ini: { ...ini, tokens } }
	return { ...song, files: [...song.files, { fileName: 'song.ini', data: tokens.bytes }], ini: { fileName: 'song.ini', tokens } }
}

/** The MIDI meta event for a tempo, time signature or text, replacing `original` when given, which must be of its kind. */
function midiValueEvent(value: ChartValueChange, original?: MidiEvent) {
	if ('beatsPerMinute' in value) {
		if (original && original.type !== 'setTempo') throw new RangeError('The event isn\'t a tempo')
		return midiTempoEvent(value.beatsPerMinute)
	}
	if ('numerator' in value) {
		if (original && original.type !== 'timeSignature') throw new RangeError('The event isn\'t a time signature')
		return midiTimeSignatureEvent(value.numerator, value.denominator, original?.type === 'timeSignature' ? original : undefined)
	}
	if (original && !isTextLikeEvent(original)) throw new RangeError('The event isn\'t a text event')
	return midiTextEvent(value.text, original)
}
