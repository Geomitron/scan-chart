import * as _ from 'lodash'

import type { AuthoredEvent } from './chart/authored-view'
import { chartEventEdits, chartEventInsertEdit, editChartLines } from './chart/chart-edit'
import { ChartFileTokens, tokenizeChartFile } from './chart/chart-file-parser'
import { editMidiTrack, midiEventEdits, MidiTrackEdit } from './chart/midi-edit'
import { MidiTokens, readMidiTokens, serializeMidiTokens } from './chart/midi-tokens'
import { IniTokens, tokenizeIni } from './ini/parse-ini'
import { findIniData } from './ini/scan-ini'
import { getBasename, getExtension, hasChartExtension, hasChartName } from './shared/file-names'
import type { EventType } from './chart/raw-types'
import type { File, FolderIssueType } from './types'

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
	/** Every file of the folder, in the order given. */
	readonly files: readonly File[]
	/** The chart file Clone Hero reads, or `null` when the folder has none. */
	readonly chart: ChartDocument | null
	/** The song.ini Clone Hero reads, or `null` when the folder has none. */
	readonly ini: IniDocument | null
}

/** Parses a song folder into a document. Never throws: a malformed chart or song.ini is reported when it is read. */
export function parseSong(files: readonly File[]): SongDocument {
	const { chartFile, format } = findChartData(files)
	const { iniFile } = findIniData(files)
	return {
		files,
		chart: chartFile === null ? null
			: format === 'mid' ? { format, fileName: chartFile.fileName, bytes: chartFile.data, ...tokenizeMidi(chartFile.data) }
			: { format: 'chart', fileName: chartFile.fileName, tokens: tokenizeChartFile(chartFile.data) },
		ini: iniFile === null ? null : { fileName: iniFile.fileName, tokens: tokenizeIni(iniFile.data) },
	}
}

/** Writes a song document back to files: an unedited document gives back every file byte for byte. */
export function serializeSong(song: SongDocument): File[] {
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
export function findChartData(files: readonly File[]) {
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
		return { chartFile: null, chartData: null, format: null, folderIssues }
	} else {
		return {
			chartFile: chartFiles[0],
			chartData: chartFiles[0].data,
			format: (getExtension(chartFiles[0].fileName).toLowerCase() === 'mid' ? 'mid' : 'chart') as 'mid' | 'chart',
			folderIssues,
		}
	}
}

/** The edits one call of `editSong` collects; they apply together, as one change. */
export interface SongEditBatch {
	/** Moves an authored event, keeping its length. */
	setTick(event: AuthoredEvent, tick: number): void
	/** Changes an authored event's length. */
	setLength(event: AuthoredEvent, length: number): void
	/** Removes an authored event. */
	remove(event: AuthoredEvent): void
	/** Adds an event to a `.chart` instrument section, by the section's index in the file's tokens. */
	addToChartSection(section: number, tick: number, type: EventType, length: number): void
}

/**
 * Applies a batch of edits to a song's chart and returns the edited song, leaving `song` unchanged: the earlier
 * document is the undo step. Every byte the edits don't touch is kept.
 *
 * Throws if an edit doesn't fit the chart's format, such as a length on a `.chart` text event.
 */
export function editSong(song: SongDocument, collect: (batch: SongEditBatch) => void): SongDocument {
	const { chart } = song
	if (chart === null) throw new RangeError('The song has no chart to edit')
	// Changes to one event merge, so setting its tick and its length in one batch does both.
	const changesBySource = new Map<string, { event: AuthoredEvent; change: { tick?: number; length?: number } | 'remove' }>()
	const change = (event: AuthoredEvent, update: { tick?: number; length?: number } | 'remove') => {
		const key = event.source.format === 'chart' ? `${event.source.section}:${event.source.line}` : `${event.source.chunk}:${event.source.events[0]}`
		const earlier = changesBySource.get(key)?.change
		if (earlier === 'remove') throw new RangeError('The event is already removed in this batch')
		changesBySource.set(key, { event, change: update === 'remove' ? update : { ...earlier, ...update } })
	}
	const additions: { section: number; tick: number; type: EventType; length: number }[] = []
	collect({
		setTick: (event, tick) => change(event, { tick }),
		setLength: (event, length) => change(event, { length }),
		remove: event => change(event, 'remove'),
		addToChartSection: (section, tick, type, length) => additions.push({ section, tick, type, length }),
	})
	const changes = [...changesBySource.values()]

	if (chart.format === 'chart') {
		const tokens = chart.tokens
		const edits = [
			...changes.flatMap(({ event, change }) => {
				if (event.source.format !== 'chart') throw new RangeError('The event isn\'t from this chart')
				const source = event.source
				return change === 'remove'
					? [{ kind: 'delete' as const, section: source.section, line: source.line }]
					: chartEventEdits(tokens, { ...event, source }, change)
			}),
			...additions.map(({ section, tick, type, length }) => chartEventInsertEdit(tokens, section, tick, type, length)),
		]
		return { ...song, chart: { ...chart, tokens: editChartLines(tokens, edits) } }
	}

	if (additions.length) throw new RangeError('Adding events to a .mid chart isn\'t supported yet')
	if (chart.tokens === null) throw new RangeError('The .mid file can\'t be read, so it can\'t be edited')
	const byChunk = new Map<number, MidiTrackEdit[]>()
	for (const { event, change } of changes) {
		if (event.source.format !== 'mid') throw new RangeError('The event isn\'t from this chart')
		const source = event.source
		const edits = change === 'remove'
			? source.events.map(index => ({ kind: 'delete' as const, event: index }))
			: midiEventEdits({ ...event, source }, change)
		let chunkEdits = byChunk.get(source.chunk)
		if (!chunkEdits) byChunk.set(source.chunk, chunkEdits = [])
		for (const edit of edits) chunkEdits.push(edit)
	}
	let tokens = chart.tokens
	for (const [chunk, edits] of byChunk) tokens = editMidiTrack(tokens, chunk, edits)
	return { ...song, chart: { ...chart, bytes: tokens.data, tokens } }
}
