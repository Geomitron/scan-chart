import { sameAsJson } from './chart/chart-analysis'
import { readChartSongEntries } from './chart/chart-file-parser'
import { chartTextForMidiEventsText, writeChartFile } from './chart/chart-writer'
import { roundBpm } from './chart/identity/btrack-20260801'
import { canonicalChartFromParse } from './chart/identity/canonical-source'
import { midiSustainCutoff, writeMidiFile } from './chart/midi-writer'
import { midiTextForChartEventsText } from './chart/midi-writer/events'
import { readMidiEventsText } from './chart/song-events'
import { ParsedChart, parseSongChartAndIni } from './chart/parse-chart-and-ini'
import { calculateCompetitiveHashes } from './competitive'
import { ChartFormat, ChartReadError } from './gameplay-chart'
import { previewEndMs, secondsToMs } from './ini/chart-song-entries'
import { asUtf8Ini, setSongIniValue } from './ini/ini-edit'
import { IniTokens, parseIniTokens } from './ini/parse-ini'
import { songContext } from './song-context'
import { documentFiles, parseSongFiles, SongDocument, songIniWithSection, withSongIni } from './song-document'
import type { SongFile } from './song-files'
import { songSectionAgreement } from './song-section'
import { Difficulty, getInstrumentType, Instrument, instrumentTypes } from './types'

/** What changed a track's TrackHash: the part of its canonical semantics that differs, or its tempo map. */
export type ConversionCause = 'notes' | 'starPower' | 'solos' | 'flexLanes' | 'drumFills' | 'rangeShifts' | 'tempoMap' | 'trackAdded' | 'trackRemoved'

/** A value the `.mid` format can't store (r3 5.4). */
export interface ConversionLimit {
	readonly kind: 'tempo' | 'timeSignature' | 'resolution'
	/** Where it is, or `null` for the resolution. */
	readonly tick: number | null
	readonly value: number
	/** The nearest value `.mid` can store, written when the conversion is forced; `null` when there's none. */
	readonly nearest: number | null
}

/** What a conversion did, found by reading the converted song back. */
export interface ConversionReport {
	/** Each track of either song, and whether its TrackHash survived; empty when either song has no TrackHashes. */
	readonly tracks: readonly {
		readonly instrument: Instrument
		readonly difficulty: Difficulty
		readonly kept: boolean
		readonly causes: readonly ConversionCause[]
	}[]
	/** Whether the SongHash survived; `null` when either song has no SongHash. */
	readonly songHashKept: boolean | null
	/** Content the target format can't hold, left out. */
	readonly dropped: readonly { readonly content: string; readonly count: number }[]
	/** song.ini settings written because the target format needs them. */
	readonly settings: readonly { readonly key: 'multiplier_note' | 'sustain_cutoff_threshold' | 'delay' | 'preview_start_time' | 'preview_end_time'; readonly value: string }[]
	/** Values the target can't store, written as the nearest it can because the conversion was forced. */
	readonly forced: readonly ConversionLimit[]
}

/** The chart holds values the target format can't store; `force` writes the nearest ones, where there are any. */
export class ConversionError extends RangeError {
	override readonly name = 'ConversionError'
	constructor(readonly limits: readonly ConversionLimit[]) {
		super(`The chart holds values a .mid file can't store: ${limits.map(limit => `${limit.kind} ${limit.value}${limit.tick === null ? '' : ` at tick ${limit.tick}`}`).join(', ')}`)
	}
}

/** The slowest tempo a `.mid` file holds: its tempo is 24 bits of microseconds per beat. */
const slowestMidiBpm = 60_000_000 / 0xffffff

/**
 * Converts a song's chart to the other format and returns the converted song with a report, leaving `song` as it was
 * (r5 Q10). The report reads the converted song back: each track's TrackHash is kept or changed, with its cause.
 *
 * - **To `.mid`:** each instrument's phrases are its Expert track's (r4 Q4), and zero-length phrases stay zero-length.
 *   song.ini gets the settings `.mid` needs: `multiplier_note` when a solo would otherwise read as star power, and
 *   `sustain_cutoff_threshold` only when a sustain would otherwise be trimmed, as the largest value that keeps every
 *   sustain (r4 Q5). The `.chart` `[Song]` Offset, PreviewStart and PreviewEnd, which games read only from a `.chart`,
 *   are copied into song.ini when it doesn't set them.
 * - **To `.chart`:** vocal pitches, harmonies, and MIDI-only tracks and events such as the venue are left out; lyrics
 *   and vocal phrases are kept. `[Song]` agrees with song.ini.
 *
 * song.ini is otherwise kept as written (D4). Throws `ConversionError` for a value the target can't store, unless
 * `force` is set, and then writes the nearest one; a resolution over 32767 has none.
 */
export function convertChart(
	song: SongDocument,
	format: ChartFormat,
	options: { readonly force?: boolean } = {},
): { readonly song: SongDocument; readonly report: ConversionReport } {
	const { chart } = song
	if (chart === null) throw new ChartReadError('The song has no chart file.')
	if (chart.format === format) throw new RangeError(`The chart is already a .${format} file`)
	const context = songContext(song)
	if (context.chart.kind === 'failed') throw new ChartReadError(context.chart.error)
	const { parsedChart } = parseSongChartAndIni(song)
	if (parsedChart === null) throw new ChartReadError('The song has no chart file.')

	const limits = format === 'mid' ? midiLimits(parsedChart) : []
	if (limits.length > 0 && (!options.force || limits.some(limit => limit.nearest === null))) throw new ConversionError(limits)
	const source = limits.length > 0 ? withNearestMidiValues(parsedChart) : parsedChart

	const settings: { key: ConversionReport['settings'][number]['key']; value: string }[] = []
	// To .chart, song.ini stays as it is; to .mid, it holds what .mid needs.
	let ini: IniTokens | null = null
	let chartBytes: Uint8Array
	if (format === 'mid') {
		// A song.ini that isn't UTF-8 is written as UTF-8, which reads the same, so it can be edited.
		const songIni = song.ini !== null && song.ini.fileName.toLowerCase() === 'song.ini' ? song.ini : null
		ini = songIniWithSection(songIni === null ? song : withSongIni(song, asUtf8Ini(songIni.tokens)))
		const iniSong = parseIniTokens(ini).iniObject.song ?? {}
		const isSet = (key: string, ...unset: number[]) => Number.isFinite(parseFloat(iniSong[key] ?? '')) && !unset.includes(parseFloat(iniSong[key]))
		const chartSong = chart.format === 'chart' ? readChartSongEntries(chart.tokens.bytes) : new Map<string, string>()
		// Games read these [Song] values when song.ini doesn't set them, from a .chart only.
		const offset = secondsToMs(chartSong.get('Offset'))
		if (offset !== null && offset !== 0 && !isSet('delay', 0)) settings.push({ key: 'delay', value: String(offset) })
		const previewStart = secondsToMs(chartSong.get('PreviewStart'))
		if (previewStart !== null && previewStart !== -1 && !isSet('preview_start_time', -1)) settings.push({ key: 'preview_start_time', value: String(previewStart) })
		const previewEnd = previewEndMs(chartSong.get('PreviewEnd'))
		if (previewEnd !== null && !isSet('preview_end_time', -1, 0)) settings.push({ key: 'preview_end_time', value: String(previewEnd) })
		const cutoff = midiSustainCutoff(source, context.settings.sustain_cutoff_threshold)
		if (cutoff.write) settings.push({ key: 'sustain_cutoff_threshold', value: String(cutoff.value) })
		if (soloReadsAsStarPower(source, context.settings.multiplier_note)) settings.push({ key: 'multiplier_note', value: '116' })
		chartBytes = writeMidiFile(source, { phrasesFromExpert: true, zeroLengthPhrases: true, sustainCutoff: cutoff.value })
	} else {
		// [Song] is written from song.ini below, not from the scanner's cleaned metadata (D4).
		chartBytes = new TextEncoder().encode(writeChartFile({ ...source, metadata: {} }))
	}
	for (const { key, value } of settings) ini = setSongIniValue(ini!, key, value)

	let converted = parseSongFiles(convertedFiles(song, format, chartBytes, ini))
	if (format === 'chart') converted = songSectionAgreement(converted) ?? converted
	return { song: converted, report: { ...comparison(song, converted), dropped: droppedContent(parsedChart, format), settings, forced: limits } }
}

/** The song's files with the converted chart in place of the old one, and song.ini as converted. */
function convertedFiles(song: SongDocument, format: ChartFormat, chartBytes: Uint8Array, ini: IniTokens | null): SongFile[] {
	const oldChart = song.chart!.fileName
	const newChart = `notes.${format}`
	const files: SongFile[] = []
	for (const file of documentFiles(song)) {
		if (file.fileName === oldChart) files.push({ fileName: newChart, data: chartBytes })
		else if (file.fileName.toLowerCase() === newChart) continue // A notes file of the target format would be read instead.
		else if (ini !== null && file.fileName.toLowerCase() === 'song.ini') files.push({ fileName: file.fileName, data: ini.bytes })
		else files.push(file)
	}
	if (ini !== null && !files.some(file => file.fileName.toLowerCase() === 'song.ini')) files.push({ fileName: 'song.ini', data: ini.bytes })
	return files
}

/** Each value `.mid` can't store, with the nearest it can. */
function midiLimits(chart: ParsedChart): ConversionLimit[] {
	const limits: ConversionLimit[] = []
	for (const tempo of chart.tempos) {
		if (tempo.beatsPerMinute < slowestMidiBpm) limits.push({ kind: 'tempo', tick: tempo.tick, value: tempo.beatsPerMinute, nearest: slowestMidiBpm })
	}
	for (const signature of chart.timeSignatures) {
		if (signature.numerator > 255) limits.push({ kind: 'timeSignature', tick: signature.tick, value: signature.numerator, nearest: 255 })
	}
	if (chart.resolution > 0x7fff) limits.push({ kind: 'resolution', tick: null, value: chart.resolution, nearest: null })
	return limits
}

function withNearestMidiValues(chart: ParsedChart): ParsedChart {
	return {
		...chart,
		tempos: chart.tempos.map(tempo => tempo.beatsPerMinute < slowestMidiBpm ? { ...tempo, beatsPerMinute: slowestMidiBpm } : tempo),
		timeSignatures: chart.timeSignatures.map(signature => signature.numerator > 255 ? { ...signature, numerator: 255 } : signature),
	}
}

/**
 * Whether a `.mid` would read a five- or six-fret instrument's solos as star power: without `multiplier_note = 116`,
 * a difficulty with no star power and more than one solo reads as Guitar Hero 1's star power.
 */
function soloReadsAsStarPower(chart: ParsedChart, multiplierNote: number): boolean {
	if (multiplierNote === 116 || multiplierNote === 103) return false
	const byInstrument = new Map<Instrument, ParsedChart['trackData']>()
	for (const track of chart.trackData) byInstrument.set(track.instrument, [...(byInstrument.get(track.instrument) ?? []), track])
	for (const [instrument, tracks] of byInstrument) {
		const type = getInstrumentType(instrument)
		if (type !== instrumentTypes.fiveFret && type !== instrumentTypes.sixFret) continue
		// Each instrument's phrases come from its Expert track, or its hardest.
		const phrases = ['expert', 'hard', 'medium', 'easy'].map(difficulty => tracks.find(track => track.difficulty === difficulty)).find(Boolean)!
		if (phrases.starPowerSections.length === 0 && phrases.soloSections.length > 1) return true
	}
	return false
}

/** The tracks' and the song's hashes before and after, and what changed each changed track. */
function comparison(before: SongDocument, after: SongDocument): Pick<ConversionReport, 'tracks' | 'songHashKept'> {
	const [hashesBefore, hashesAfter] = [calculateCompetitiveHashes(before), calculateCompetitiveHashes(after)]
	if (!hashesBefore.accepted || !hashesAfter.accepted) return { tracks: [], songHashKept: null }
	const canonicalOf = (song: SongDocument) => {
		const { chart } = songContext(song)
		const outcome = chart.kind === 'parsed' ? canonicalChartFromParse(chart.source.format, chart.parsed) : null
		return outcome?.kind === 'accepted' ? outcome.chart : null
	}
	const [canonicalBefore, canonicalAfter] = [canonicalOf(before), canonicalOf(after)]
	const semanticsOf = (chart: typeof canonicalBefore) =>
		new Map(chart === null ? [] : chart.tracks.map(track => [`${track.key.instrument}:${track.key.difficulty}`, track.semantics]))
	const [semanticsBefore, semanticsAfter] = [semanticsOf(canonicalBefore), semanticsOf(canonicalAfter)]
	const hashBefore = new Map(hashesBefore.tracks.map(track => [`${track.instrument}:${track.difficulty}`, track]))
	const hashAfter = new Map(hashesAfter.tracks.map(track => [`${track.instrument}:${track.difficulty}`, track]))
	// The tempo map as the TrackHash reads it: tempos rounded to 0.001 BPM, which .chart and .mid can't both store exactly.
	const hashedTempoMap = (chart: typeof canonicalBefore) => chart === null ? null : {
		tempos: chart.tempoMap.tempos.map(tempo => [tempo.tick, roundBpm(tempo.beatsPerMinute)]),
		timeSignatures: chart.tempoMap.timeSignatures.map(signature => [signature.tick, signature.numerator, signature.denominator]),
	}
	const tempoMapChanged = !sameAsJson(hashedTempoMap(canonicalBefore), hashedTempoMap(canonicalAfter))
	const tracks: ConversionReport['tracks'][number][] = []
	for (const key of new Set([...hashBefore.keys(), ...hashAfter.keys()])) {
		const { instrument, difficulty } = (hashBefore.get(key) ?? hashAfter.get(key))!
		if (!hashBefore.has(key) || !hashAfter.has(key)) {
			tracks.push({ instrument, difficulty, kept: false, causes: [hashBefore.has(key) ? 'trackRemoved' : 'trackAdded'] })
			continue
		}
		if (hashBefore.get(key)!.trackHash === hashAfter.get(key)!.trackHash) {
			tracks.push({ instrument, difficulty, kept: true, causes: [] })
			continue
		}
		const [a, b] = [semanticsBefore.get(key), semanticsAfter.get(key)]
		const causes: ConversionCause[] = []
		for (const [field, cause] of [['notes', 'notes'], ['starPower', 'starPower'], ['solos', 'solos'], ['flexLanes', 'flexLanes'], ['drumFreestyle', 'drumFills'], ['rangeShifts', 'rangeShifts']] as const) {
			if (a !== undefined && b !== undefined && !sameAsJson(a[field], b[field])) causes.push(cause)
		}
		if (tempoMapChanged) causes.push('tempoMap')
		tracks.push({ instrument, difficulty, kept: false, causes })
	}
	return { tracks, songHashKept: hashesBefore.songHash === hashesAfter.songHash }
}

/** What the target format can't hold, by kind, with how much of it there was. */
function droppedContent(chart: ParsedChart, format: ChartFormat): ConversionReport['dropped'] {
	const dropped: { content: string; count: number }[] = []
	const add = (content: string, count: number) => { if (count > 0) dropped.push({ content, count }) }
	if (format === 'chart') {
		const parts = chart.vocalTracks.parts
		add('vocal pitches', (parts.vocals?.notePhrases ?? []).reduce((count, phrase) => count + phrase.notes.length, 0))
		for (const part of ['harmony1', 'harmony2', 'harmony3']) add(`${part} phrases`, parts[part]?.notePhrases.length ?? 0)
		for (const track of chart.unrecognized.midiTracks) {
			add(`MIDI track ${track.trackName}`, track.events.filter(event => event.type !== 'trackName' && event.type !== 'endOfTrack').length)
		}
		add('instrument track MIDI events', chart.trackData.reduce((count, track) => count + track.unrecognizedMidiEvents.length, 0))
		add('events track MIDI events', chart.unrecognized.eventsTrackMidiEvents.length)
		const texts = chart.format === 'mid' ? chart.unrecognized.eventsTrackTextEvents : []
		add('events track vocal events', texts.filter(event => readMidiEventsText(event.text) !== null).length)
		const unwritable = texts.filter(event => readMidiEventsText(event.text) === null && chartTextForMidiEventsText(event.text) === null)
		add('events track text that [Events] would read as an event', unwritable.length)
	} else {
		for (const section of chart.unrecognized.chartSections) add(`[${section.name}] lines`, section.lines.length)
		add('[SyncTrack] lines', chart.unrecognized.syncTrackEvents.length)
		const texts = chart.format === 'chart' ? chart.unrecognized.eventsTrackTextEvents : []
		add('[Events] text that the events track would read as an event', texts.filter(event => midiTextForChartEventsText(event.text) === null).length)
	}
	return dropped
}
