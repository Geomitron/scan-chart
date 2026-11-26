import { spliceChartText } from './chart/chart-edit'
import { chartSectionLines, chartSectionTrack } from './chart/chart-file-parser'
import { chartSectionMisspelledMixes, drumMixText, midiTrackMisspelledMixes } from './chart/disco-flip'
import { editMidiTrack, midiTextEvent, type MidiTrackEdit } from './chart/midi-edit'
import { midiEnhancedOpensInOtherCase, midiEventsAfterEnd, midiMixAndDynamicsLyrics, midiSysExOfAnotherLength, midiTrackCounts, phaseShiftSysExTypes } from './chart/midi-file-parser'
import { metaEventDataStart, type MidiTokens, readMidiTokens } from './chart/midi-tokens'
import { isMixEventSpelledAnotherWay } from './chart/mix-event'
import type { FixOptions } from './fix-issues'
import { chooseEdits, FixRecord, hashChanges, hashNames, issueFixTable } from './issue-fixes'
import type { Issue, IssueCode } from './issues'
import { continueEdits, SongDocument } from './song-document'
import { songHashes } from './song-hashes'

/**
 * One rewrite of a form games read differently, such as one the canonical profile reads as Clone Hero does (C20), into
 * the standard form: the code of the issue it fixes, what it does as the report describes it (`Rewrote ...`) and as a
 * skip reason starts (`Rewriting ...`), and its edit of the chart file's text or of one `.mid` track or the whole `.mid`
 * file.
 */
interface FormFix {
	readonly code: IssueCode
	readonly description: string
	readonly skipping: string
	readonly edit:
		| { readonly kind: 'chart'; readonly start: number; readonly end: number; readonly text: string }
		| { readonly kind: 'midiTrack'; readonly chunkIndex: number; readonly edits: readonly MidiTrackEdit[] }
		| { readonly kind: 'midiFile'; readonly apply: (tokens: MidiTokens) => MidiTokens }
}

/** A fix's description and skip reason start, for a fix that rewrites `what`. */
const rewriting = (what: string) => ({ description: `Rewrote ${what}.`, skipping: `Rewriting ${what}` })

/** A fix's description and skip reason start, for a fix that moves `what`. */
const moving = (what: string) => ({ description: `Moved ${what}.`, skipping: `Moving ${what}` })

/** The codes `fixReadingForms` fixes. */
const formCodes: readonly IssueCode[] = [
	'nonstandardMixEvent',
	'midiDrumsLyricEvent',
	'nonstandardEnhancedOpens',
	'wrongMidiTrackCount',
	'eventsAfterEndOfTrack',
	'nonstandardPhaseShiftSysEx',
]

/**
 * Rewrites the forms of the chart file the issues report in their standard forms, each by its own edit so that each
 * keeps or changes the canonical hashes alone. A fix whose code may change hashes is made where it keeps them, or with
 * `changeHashes`; one that keeps them is made only where it does.
 */
export function fixReadingForms(song: SongDocument, issues: readonly Issue[], options: FixOptions, record: FixRecord): SongDocument {
	const { chart } = song
	const codes = new Set(issues.map(issue => issue.code).filter(code => formCodes.includes(code)))
	if (chart === null || codes.size === 0 || (chart.format === 'mid' && chart.tokens === null)) return song
	const fixes: FormFix[] = []
	if (chart.format === 'chart') {
		const { tokens } = chart
		if (codes.has('nonstandardMixEvent')) {
			const read = new Set<string>()
			for (const section of tokens.sections) {
				const track = chartSectionTrack(section.name)
				// A reader reads the first section of each name.
				if (track?.instrument !== 'drums' || read.has(section.name)) continue
				read.add(section.name)
				for (const mix of chartSectionMisspelledMixes(chartSectionLines(tokens, section), track.difficulty)) {
					const start = tokens.text.indexOf(mix.line.text, mix.line.start)
					fixes.push({
						code: 'nonstandardMixEvent',
						...rewriting(`the mix event "${mix.text}" at tick ${mix.tick} in [${section.name}] as "${mix.standard}"`),
						edit: { kind: 'chart', start, end: start + mix.line.text.length, text: `${mix.tick} = E ${mix.standard}` },
					})
				}
			}
		}
	} else {
		const tokens = chart.tokens!
		const { counted, tracks } = midiTrackCounts(tokens)
		if (codes.has('wrongMidiTrackCount') && counted !== tracks) {
			fixes.push({
				code: 'wrongMidiTrackCount',
				...rewriting(`the header's track count from ${counted.toLocaleString('en-US')} to ${tracks.toLocaleString('en-US')}`),
				edit: { kind: 'midiFile', apply: current => withTrackCount(current, midiTrackCounts(current).tracks) },
			})
		}
		for (const track of codes.has('eventsAfterEndOfTrack') ? midiEventsAfterEnd(tokens) : []) {
			const original = tokens.chunks[track.chunkIndex]
			const endTick = original.kind === 'track' ? original.events[track.end].tick : 0
			fixes.push({
				code: 'eventsAfterEndOfTrack',
				...moving(`the end of track of "${track.name}" from tick ${endTick} to tick ${Math.max(endTick, track.lastTick)}, after the `
					+ `${track.after === 1 ? 'event' : `${track.after.toLocaleString('en-US')} events`} that followed it`),
				edit: {
					kind: 'midiTrack',
					chunkIndex: track.chunkIndex,
					edits: [{ kind: 'move', event: track.end, tick: Math.max(endTick, track.lastTick) }, ...track.otherEnds.map(event => ({ kind: 'delete' as const, event }))],
				},
			})
		}
		for (const track of codes.has('nonstandardPhaseShiftSysEx') ? midiSysExOfAnotherLength(tokens) : []) {
			for (const { eventIndex, tick, data } of track.events) {
				const standard = new Uint8Array([...Array.from(data).slice(0, 7), 0xf7])
				fixes.push({
					code: 'nonstandardPhaseShiftSysEx',
					...rewriting(`the ${data.length}-byte ${data[5] === phaseShiftSysExTypes.tap ? 'tap' : 'open'} SysEx event at tick ${tick} in "${track.name}" in the 8-byte form`),
					edit: { kind: 'midiTrack', chunkIndex: track.chunkIndex, edits: [{ kind: 'delete', event: eventIndex }, { kind: 'insert', tick, event: { type: 'sysEx', data: standard } }] },
				})
			}
		}
		for (const track of codes.has('nonstandardEnhancedOpens') ? midiEnhancedOpensInOtherCase(tokens) : []) {
			for (const { eventIndex, tick, text } of track.events) {
				fixes.push({
					code: 'nonstandardEnhancedOpens',
					...rewriting(`the ENHANCED_OPENS event "${text}" at tick ${tick} in "${track.name}" as "${text.toUpperCase()}"`),
					edit: { kind: 'midiTrack', chunkIndex: track.chunkIndex, edits: [{ kind: 'replace', event: eventIndex, with: midiTextEvent(text.toUpperCase()) }] },
				})
			}
		}
		const drums = codes.has('nonstandardMixEvent') ? midiTrackMisspelledMixes(tokens) : null
		for (const mix of drums?.events ?? []) {
			const original = tokens.chunks[drums!.chunkIndex]
			const event = original.kind === 'track' ? original.events[mix.eventIndex].event : undefined
			fixes.push({
				code: 'nonstandardMixEvent',
				...rewriting(`the mix event "${mix.text}" at tick ${mix.tick} in "${drums!.name}" as "${mix.standard}"`),
				edit: { kind: 'midiTrack', chunkIndex: drums!.chunkIndex, edits: [{ kind: 'replace', event: mix.eventIndex, with: midiTextEvent(mix.standard, event) }] },
			})
		}
		if (codes.has('midiDrumsLyricEvent')) fixes.push(...lyricFixes(tokens))
	}
	if (fixes.length === 0) return song

	const before = songHashes(song)
	const apply = (chosen: readonly FormFix[]): SongDocument => {
		if (chart.format === 'chart') {
			const splices = chosen.flatMap(fix => fix.edit.kind === 'chart' ? [fix.edit] : []).sort((a, b) => a.start - b.start)
			return continueEdits(song, { ...song, chart: { ...chart, tokens: spliceChartText(chart.tokens, splices) } })
		}
		let tokens = chart.tokens!
		const byChunk = new Map<number, MidiTrackEdit[]>()
		for (const { edit } of chosen) if (edit.kind === 'midiTrack') byChunk.set(edit.chunkIndex, [...byChunk.get(edit.chunkIndex) ?? [], ...edit.edits])
		for (const [chunkIndex, edits] of byChunk) tokens = editMidiTrack(tokens, chunkIndex, edits)
		for (const { edit } of chosen) if (edit.kind === 'midiFile') tokens = edit.apply(tokens)
		return continueEdits(song, { ...song, chart: { ...chart, bytes: tokens.data, tokens } })
	}
	const mayChange = (fix: FormFix) => issueFixTable[fix.code]!.hashes !== 'keepsHashes'
	const changedAlone = new Map<FormFix, readonly string[]>()
	const changesOf = (fix: FormFix) => {
		let keys = changedAlone.get(fix)
		if (keys === undefined) changedAlone.set(fix, keys = hashChanges(before, songHashes(apply([fix]))).map(change => change.key))
		return keys
	}
	// With changeHashes, a fix that changes hashes may change any, as a tap's start and end fixes change them only together,
	// and one that may change them the ones it changes alone. A fix that keeps them must keep them alone.
	const problem = (edited: SongDocument, chosen: readonly FormFix[]) => {
		const changes = hashChanges(before, songHashes(edited))
		if (options.changeHashes && chosen.some(fix => issueFixTable[fix.code]!.hashes === 'changesHashes') && changes.length > 0) {
			const kept = chosen.filter(fix => !mayChange(fix))
			return kept.every(fix => changesOf(fix).length === 0) ? null : `would change ${hashNames(changes)}`
		}
		const allowed = new Set(options.changeHashes ? chosen.filter(mayChange).flatMap(changesOf) : [])
		return changes.every(change => allowed.has(change.key)) ? null : `would change ${hashNames(changes)}`
	}
	const { song: fixed, chosen } = chooseEdits(song, fixes, apply, problem, (fix, problem) => record.skip(fix.code, chart.fileName, mayChange(fix)
		? `${fix.skipping} ${problem}: fix it with changeHashes.`
		: `${fix.skipping} ${problem}, so games would read the song differently.`))
	for (const fix of chosen) record.fixed.push({ code: fix.code, file: chart.fileName, description: fix.description })
	return fixed
}

/**
 * The fixes that rewrite each of the drums track's lyric events that the canonical profile reads as a mix event or
 * `ENABLE_CHART_DYNAMICS` as a text event, which it reads alike: a mix event spelled another way in the standard
 * spelling, and any other with the lyric's bytes as written.
 */
function lyricFixes(tokens: MidiTokens): FormFix[] {
	const lyrics = midiMixAndDynamicsLyrics(tokens)
	const chunk = lyrics === null ? undefined : tokens.chunks[lyrics.chunkIndex]
	if (lyrics === null || chunk?.kind !== 'track') return []
	return lyrics.events.map((lyric): FormFix => {
		const standard = lyric.kind === 'mix' && isMixEventSpelledAnotherWay(lyric.text) ? drumMixText(lyric.mix.difficulty, lyric.mix) : null
		const { start, end } = chunk.events[lyric.eventIndex]
		return {
			code: 'midiDrumsLyricEvent',
			...rewriting(`the lyric event "${lyric.text}" at tick ${lyric.tick} in "${lyrics.name}" as ${standard === null ? 'a text event' : `the text event "${standard}"`}`),
			edit: {
				kind: 'midiTrack',
				chunkIndex: lyrics.chunkIndex,
				edits: [{
					kind: 'replace',
					event: lyric.eventIndex,
					// A text event is meta type 01.
					with: standard === null ? { type: 'meta', metaType: 0x01, data: tokens.data.slice(metaEventDataStart(tokens.data, start), end) } : midiTextEvent(standard),
				}],
			},
		}
	})
}

/** A `.mid` file's tokens with the header's track count set to `count`. */
function withTrackCount(tokens: MidiTokens, count: number): MidiTokens {
	const data = tokens.data.slice()
	// The track count follows the format in the header's body, as a big-endian 16-bit number.
	data[tokens.header.bodyStart + 2] = count >>> 8
	data[tokens.header.bodyStart + 3] = count & 0xff
	return readMidiTokens(data, 'skip')
}
