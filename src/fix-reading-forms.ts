import { spliceChartText } from './chart/chart-edit'
import { chartSectionLines, chartSectionTrack } from './chart/chart-file-parser'
import { chartSectionMisspelledMixes, midiTrackMisspelledMixes } from './chart/disco-flip'
import { editMidiTrack, midiTextEvent, type MidiTrackEdit } from './chart/midi-edit'
import { midiEnhancedOpensInOtherCase, midiEventsAfterEnd, midiTrackCounts } from './chart/midi-file-parser'
import { type MidiTokens, readMidiTokens } from './chart/midi-tokens'
import type { FixOptions } from './fix-issues'
import { chooseEdits, FixRecord, hashChanges, hashNames, issueFixTable } from './issue-fixes'
import type { Issue, IssueCode } from './issues'
import { continueEdits, SongDocument } from './song-document'
import { songHashes } from './song-hashes'

/**
 * One rewrite of a form the canonical profile reads as Clone Hero does (C20), into the standard form: the code of the
 * issue it fixes, what it does, and its edit of the chart file's text or of one `.mid` track or the whole `.mid` file.
 */
interface FormFix {
	readonly code: IssueCode
	readonly description: string
	readonly edit:
		| { readonly kind: 'chart'; readonly start: number; readonly end: number; readonly text: string }
		| { readonly kind: 'midiTrack'; readonly chunkIndex: number; readonly edits: readonly MidiTrackEdit[] }
		| { readonly kind: 'midiFile'; readonly apply: (tokens: MidiTokens) => MidiTokens }
}

/** The codes `fixReadingForms` fixes. */
const formCodes: readonly IssueCode[] = ['nonstandardMixEvent', 'nonstandardEnhancedOpens', 'wrongMidiTrackCount', 'eventsAfterEndOfTrack']

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
						description: `Rewrote the mix event "${mix.text}" at tick ${mix.tick} in [${section.name}] as "${mix.standard}".`,
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
				description: `Rewrote the header's track count from ${counted.toLocaleString('en-US')} to ${tracks.toLocaleString('en-US')}.`,
				edit: { kind: 'midiFile', apply: current => withTrackCount(current, midiTrackCounts(current).tracks) },
			})
		}
		for (const track of codes.has('eventsAfterEndOfTrack') ? midiEventsAfterEnd(tokens) : []) {
			const original = tokens.chunks[track.chunkIndex]
			const endTick = original.kind === 'track' ? original.events[track.end].tick : 0
			fixes.push({
				code: 'eventsAfterEndOfTrack',
				description: `Moved the end of track of "${track.name}" from tick ${endTick} to tick ${Math.max(endTick, track.lastTick)}, after the `
					+ `${track.after === 1 ? 'event' : `${track.after.toLocaleString('en-US')} events`} that followed it.`,
				edit: {
					kind: 'midiTrack',
					chunkIndex: track.chunkIndex,
					edits: [{ kind: 'move', event: track.end, tick: Math.max(endTick, track.lastTick) }, ...track.otherEnds.map(event => ({ kind: 'delete' as const, event }))],
				},
			})
		}
		for (const track of codes.has('nonstandardEnhancedOpens') ? midiEnhancedOpensInOtherCase(tokens) : []) {
			for (const { eventIndex, tick, text } of track.events) {
				fixes.push({
					code: 'nonstandardEnhancedOpens',
					description: `Rewrote the ENHANCED_OPENS event "${text}" at tick ${tick} in "${track.name}" as "${text.toUpperCase()}".`,
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
				description: `Rewrote the mix event "${mix.text}" at tick ${mix.tick} in "${drums!.name}" as "${mix.standard}".`,
				edit: { kind: 'midiTrack', chunkIndex: drums!.chunkIndex, edits: [{ kind: 'replace', event: mix.eventIndex, with: midiTextEvent(mix.standard, event) }] },
			})
		}
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
	// With changeHashes, the fixes that may change hashes may change the ones each changes alone.
	const problem = (edited: SongDocument, chosen: readonly FormFix[]) => {
		const changes = hashChanges(before, songHashes(edited))
		const allowed = new Set(options.changeHashes ? chosen.filter(mayChange).flatMap(changesOf) : [])
		return changes.every(change => allowed.has(change.key)) ? null : `would change ${hashNames(changes)}`
	}
	const { song: fixed, chosen } = chooseEdits(song, fixes, apply, problem, (fix, problem) => record.skip(fix.code, chart.fileName, mayChange(fix)
		? `${fix.description.replace(/^Rewrote/, 'Rewriting').replace(/\.$/, '')} ${problem}: fix it with changeHashes.`
		: `${fix.description.replace(/^Rewrote/, 'Rewriting').replace(/\.$/, '')} ${problem}, so games would read the song differently.`))
	for (const fix of chosen) record.fixed.push({ code: fix.code, file: chart.fileName, description: fix.description })
	return fixed
}

/** A `.mid` file's tokens with the header's track count set to `count`. */
function withTrackCount(tokens: MidiTokens, count: number): MidiTokens {
	const data = tokens.data.slice()
	// The track count follows the format in the header's body, as a big-endian 16-bit number.
	data[tokens.header.bodyStart + 2] = count >>> 8
	data[tokens.header.bodyStart + 3] = count & 0xff
	return readMidiTokens(data, 'skip')
}
