import * as _ from 'lodash'

import type { MidiEvent } from '@geomitron/midi-file'

import {
	type AuthoredEvent,
	type AuthoredSource,
	type AuthoredTempo,
	type AuthoredTextEvent,
	type AuthoredTimeSignature,
	midiAuthoredTracks,
} from './chart/authored-view'
import { chartEventEdits, chartEventInsertEdit, chartLineInsertEdit, ChartValueChange, chartValueText, editChartLines } from './chart/chart-edit'
import { ChartFileTokens, tokenizeChartFile } from './chart/chart-file-parser'
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
import { MidiTokens, midiTokensToMidiData, readMidiTokens, serializeMidiTokens } from './chart/midi-tokens'
import { IniTokens, tokenizeIni } from './ini/parse-ini'
import { findIniData } from './ini/scan-ini'
import { getBasename, getExtension, hasChartExtension, hasChartName, hasIniExtension } from './shared/file-names'
import { type EventType, eventTypes } from './chart/raw-types'
import { fileBytes, isByteSource, readFileBytes, type SongFile } from './song-files'
import { type Difficulty, type FolderIssueType, getInstrumentType } from './types'

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
export function serializeSong(song: SongDocument): SongFile[] {
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
	const chartFiles = _.chain(files)
		.filter(f => hasChartExtension(f.fileName))
		.orderBy([
			f => getBasename(f.fileName).toLowerCase() === 'notes',
			f => getExtension(f.fileName).toLowerCase() === 'mid',
			f => hasChartName(f.fileName),
		], ['desc', 'desc', 'desc'])
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
	setLength(event: AuthoredEvent, length: number): void
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

type ElementChange = { tick?: number; length?: number; value?: ChartValueChange }

/**
 * Applies a batch of edits to a song's chart and returns the edited song, leaving `song` unchanged: the earlier
 * document is the undo step. Every byte the edits don't touch is kept.
 *
 * Throws if an edit doesn't fit the chart's format, such as a length on a `.chart` text event.
 */
export function editSong(song: SongDocument, collect: (batch: SongEditBatch) => void): SongDocument {
	const { chart } = song
	if (chart === null) throw new RangeError('The song has no chart to edit')
	// Changes to one element merge, so setting its tick and its length or value in one batch does both.
	const changesBySource = new Map<string, { element: AuthoredElement; change: ElementChange | 'remove' }>()
	const change = (element: AuthoredElement, update: ElementChange | 'remove') => {
		const { source } = element
		const key = source.format === 'chart' ? `${source.section}:${source.line}` : `${source.chunk}:${source.events[0]}`
		const earlier = changesBySource.get(key)?.change
		if (earlier === 'remove') throw new RangeError('The element is already removed in this batch')
		changesBySource.set(key, { element, change: update === 'remove' ? update : { ...earlier, ...update } })
	}
	const additions: { section: number; tick: number; type: EventType; length: number }[] = []
	const midiAdditions: Parameters<SongEditBatch['addToMidiTrack']>[] = []
	const songAdditions: { tick: number; value: ChartValueChange }[] = []
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
		addToChartSection: (section, tick, type, length) => additions.push({ section, tick, type, length }),
		addToMidiTrack: (...addition) => midiAdditions.push(addition),
	})
	const changes = [...changesBySource.values()]

	if (chart.format === 'chart') {
		if (midiAdditions.length) throw new RangeError('A .chart file has no MIDI tracks to add to')
		const tokens = chart.tokens
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
		recordEdit(tokens, edited)
		return { ...song, chart: { ...chart, tokens: edited } }
	}

	if (additions.length) throw new RangeError('A .mid file has no .chart sections to add to')
	if (chart.tokens === null) throw new RangeError('The .mid file can\'t be read, so it can\'t be edited')
	const midiTokens = chart.tokens
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
	recordEdit(midiTokens, tokens)
	return { ...song, chart: { ...chart, bytes: tokens.data, tokens } }
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
