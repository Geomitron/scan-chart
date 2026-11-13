import { describe, expect, it } from 'vitest'

import { analyzeChart } from 'src/analyze-chart'
import { parseChartFile, parseChartFileCanonicalIdentity, parseChartFileFrozenLegacyIdentity } from 'src/chart/parse-chart-file'
import { noteFlags, noteTypes } from 'src/chart/types'
import { fixIssues } from 'src/fix-issues'
import { resolveChart } from 'src/gameplay-chart'
import type { IssueCode } from 'src/issues'
import { parseSong, parseSongFiles } from 'src/song-document'

import { midiFile, midiNote, midiText, type TimedMidiEvent } from './helpers/midi-files'

const parsers = { scanner: parseChartFile, canonical: parseChartFileCanonicalIdentity, legacy: parseChartFileFrozenLegacyIdentity }
type Parse = typeof parseChartFile
const guitarMidi = (events: readonly TimedMidiEvent[]) => midiFile([{ name: 'PART GUITAR', events }])
/** The Expert guitar notes' ticks and types. */
const expertNotes = (data: Uint8Array, parse: Parse) => parse(data, 'mid').trackData
	.find(track => track.instrument === 'guitar' && track.difficulty === 'expert')?.noteEventGroups.flatMap(group => group.map(note => [note.tick, note.type])) ?? []
const issuesOf = (data: Uint8Array, code: IssueCode) => analyzeChart(resolveChart(parseSongFiles([{ fileName: 'notes.mid', data }]))).issues
	.filter(issue => issue.code === code).map(({ instrument, difficulty, severity, message }) => ({ instrument, difficulty, severity, message }))
const fixed = async (data: Uint8Array, code: IssueCode, changeHashes = false) => {
	const { song, report } = await fixIssues(await parseSong([{ fileName: 'notes.mid', data }]), { codes: [code], changeHashes })
	return { report, data: song.chart!.format === 'mid' ? song.chart!.bytes : new Uint8Array() }
}

describe('ENHANCED_OPENS in any letter case (C20: R13)', () => {
	const data = guitarMidi([midiText(0, '[enhanced_opens]'), ...midiNote(480, 95, 10), ...midiNote(960, 96, 10)])

	it('makes note 95 an open note in the scanner and canonical profiles, and not in the frozen one', () => {
		for (const parse of [parsers.scanner, parsers.canonical]) expect(expertNotes(data, parse)).toEqual([[480, noteTypes.open], [960, noteTypes.green]])
		expect(expertNotes(data, parsers.legacy)).toEqual([[960, noteTypes.green]])
		// Only in a text event, and without spaces around it.
		for (const other of [midiText(0, '[enhanced_opens]', 'lyrics'), midiText(0, ' [ENHANCED_OPENS]')]) {
			expect(expertNotes(guitarMidi([other, ...midiNote(480, 95, 10), ...midiNote(960, 96, 10)]), parsers.canonical)).toEqual([[960, noteTypes.green]])
		}
	})

	it('reports it as a warning, and fixIssues rewrites it in capitals, keeping the hashes', async () => {
		expect(issuesOf(data, 'nonstandardEnhancedOpens')).toEqual([{
			instrument: 'guitar', difficulty: null, severity: 'warning',
			message: 'The ENHANCED_OPENS event "[enhanced_opens]" at tick 0 isn\'t in capitals. Clone Hero reads it in any letter case, and other programs, '
				+ 'such as YARG, only in capitals. fixIssues can rewrite it in capitals.',
		}])
		expect(issuesOf(guitarMidi([midiText(0, '[ENHANCED_OPENS]'), ...midiNote(480, 95, 10)]), 'nonstandardEnhancedOpens')).toEqual([])
		const result = await fixed(data, 'nonstandardEnhancedOpens')
		expect(result.report.fixed).toEqual([{
			code: 'nonstandardEnhancedOpens', file: 'notes.mid', description: 'Rewrote the ENHANCED_OPENS event "[enhanced_opens]" at tick 0 in "PART GUITAR" as "[ENHANCED_OPENS]".',
		}])
		expect(result.report.hashes).toEqual([])
		expect(expertNotes(result.data, parsers.legacy)).toEqual([[480, noteTypes.open], [960, noteTypes.green]])
	})
})

/** `data` with the header's track count set to `count`. */
const withCount = (data: Uint8Array, count: number) => {
	const counted = data.slice()
	counted[11] = count
	return counted
}
const instruments = (data: Uint8Array, parse: Parse) => parse(data, 'mid').trackData.map(track => `${track.instrument}/${track.difficulty}`)

describe('every MTrk chunk is a track (C20: R15)', () => {
	const data = withCount(midiFile([{ name: 'PART GUITAR', events: midiNote(480, 96, 10) }, { name: 'PART BASS', events: midiNote(480, 96, 10) }]), 2)

	it('reads the tracks past the header count in the scanner and canonical profiles, and not in the frozen one', () => {
		for (const parse of [parsers.scanner, parsers.canonical]) expect(instruments(data, parse)).toEqual(['guitar/expert', 'bass/expert'])
		expect(instruments(data, parsers.legacy)).toEqual(['guitar/expert'])
		// A count of 0 is read too, as Clone Hero ignores the count.
		for (const parse of [parsers.scanner, parsers.canonical]) expect(instruments(withCount(data, 0), parse)).toEqual(['guitar/expert', 'bass/expert'])
		expect(() => parsers.legacy(withCount(data, 0), 'mid')).toThrow('no tracks detected')
	})

	it('reports the wrong count as a warning, and fixIssues rewrites it, keeping the hashes', async () => {
		expect(issuesOf(data, 'wrongMidiTrackCount')).toEqual([{
			instrument: null, difficulty: null, severity: 'warning',
			message: 'The .mid file\'s header counts 2 tracks, but the file has 3. Clone Hero reads all 3, and other programs may read only the first 2. fixIssues can rewrite the count.',
		}])
		expect(issuesOf(withCount(data, 5), 'wrongMidiTrackCount')).toEqual([{
			instrument: null, difficulty: null, severity: 'warning', message: 'The .mid file\'s header counts 5 tracks, but the file has only 3. fixIssues can rewrite the count.',
		}])
		expect(issuesOf(withCount(data, 3), 'wrongMidiTrackCount')).toEqual([])
		const result = await fixed(data, 'wrongMidiTrackCount')
		expect(result.report.fixed).toEqual([{ code: 'wrongMidiTrackCount', file: 'notes.mid', description: 'Rewrote the header\'s track count from 2 to 3.' }])
		expect(result.report.hashes).toEqual([])
		expect(result.data).toEqual(withCount(data, 3))
		expect(instruments(result.data, parsers.legacy)).toEqual(['guitar/expert', 'bass/expert'])
	})
})

describe('events after the end of track are ignored (C20: R16)', () => {
	const endOfTrack = (tick: number): TimedMidiEvent => ({ tick, event: { type: 'endOfTrack' } as TimedMidiEvent['event'] })
	// The track ends at 600; the green at 960 and the red's note-off at 650 come after it.
	const data = guitarMidi([...midiNote(480, 96, 10), ...midiNote(500, 97, 150), endOfTrack(600), ...midiNote(960, 96, 10)])

	it('leaves them out in the scanner and canonical profiles, and reads them in the frozen one', () => {
		for (const parse of [parsers.scanner, parsers.canonical]) expect(expertNotes(data, parse)).toEqual([[480, noteTypes.green]])
		expect(expertNotes(data, parsers.legacy)).toEqual([[480, noteTypes.green], [500, noteTypes.red], [960, noteTypes.green]])
	})

	it('reports them as a warning, and fixIssues moves the end of track after them with changeHashes', async () => {
		expect(issuesOf(data, 'eventsAfterEndOfTrack')).toEqual([{
			instrument: 'guitar', difficulty: null, severity: 'warning',
			message: 'The track "PART GUITAR" has 3 events, from tick 650, after its end of track. Clone Hero ignores them, and other programs may read them. '
				+ 'fixIssues can move the end of track after them.',
		}])
		const withheld = await fixed(data, 'eventsAfterEndOfTrack')
		expect(withheld.report.fixed).toEqual([])
		expect(withheld.report.skipped).toEqual([{ code: 'eventsAfterEndOfTrack', file: null, reason: 'Its fix changes a canonical hash: fix it with changeHashes.' }])
		const made = await fixed(data, 'eventsAfterEndOfTrack', true)
		expect(made.report.fixed).toEqual([{
			code: 'eventsAfterEndOfTrack', file: 'notes.mid', description: 'Moved the end of track of "PART GUITAR" from tick 600 to tick 970, after the 3 events that followed it.',
		}])
		expect(made.report.hashes.map(change => change.key)).toEqual(['canonical:guitar:expert', 'canonical:song'])
		for (const parse of Object.values(parsers)) expect(expertNotes(made.data, parse)).toEqual([[480, noteTypes.green], [500, noteTypes.red], [960, noteTypes.green]])
		expect(issuesOf(made.data, 'eventsAfterEndOfTrack')).toEqual([])
	})
})

/** A tap SysEx event of Expert, a start or an end, with `data` after `50 53 00 00 03 04`. */
const tapSysEx = (tick: number, ...rest: number[]): TimedMidiEvent =>
	({ tick, event: { type: 'sysEx', data: new Uint8Array([0x50, 0x53, 0, 0, 3, 4, ...rest]) } as TimedMidiEvent['event'] })
const tapTicks = (data: Uint8Array, parse: Parse) => parse(data, 'mid').trackData.find(track => track.difficulty === 'expert')!
	.noteEventGroups.filter(group => group[0].flags & noteFlags.tap).map(group => group[0].tick)

describe('a Phase Shift SysEx event is read only at exactly 8 bytes (C20: R12)', () => {
	const greens = [0, 100, 200].flatMap(tick => midiNote(tick, 96, 10))
	const taps = (start: number[], end: number[]) => guitarMidi([...greens, tapSysEx(0, ...start), tapSysEx(300, ...end)])

	it('reads a 7- or 9-byte one in the frozen profile only', () => {
		for (const parse of Object.values(parsers)) expect(tapTicks(taps([1, 0xf7], [0, 0xf7]), parse)).toEqual([0, 100, 200])
		for (const [start, end] of [[[1], [0]], [[1, 0, 0xf7], [0, 0, 0xf7]], [[1, 0xf0], [0, 0xf0]]]) {
			for (const parse of [parsers.scanner, parsers.canonical]) expect(tapTicks(taps(start, end), parse), String(start)).toEqual([])
			expect(tapTicks(taps(start, end), parsers.legacy), String(start)).toEqual([0, 100, 200])
		}
	})

	it('reports one of another length as a warning, and fixIssues rewrites it in the 8-byte form with changeHashes', async () => {
		const data = taps([1], [0, 0, 0xf7])
		expect(issuesOf(data, 'nonstandardPhaseShiftSysEx')).toEqual([{
			instrument: 'guitar', difficulty: null, severity: 'warning',
			message: '2 tap and open SysEx events, such as the one at tick 0, which is 7 bytes long, aren\'t 8 bytes long. Clone Hero and YARG read only an 8-byte one, '
				+ 'so they ignore them, and other programs may read them. fixIssues can rewrite them in the 8-byte form.',
		}])
		expect(issuesOf(taps([1, 0xf7], [0, 0xf7]), 'nonstandardPhaseShiftSysEx')).toEqual([])
		expect((await fixed(data, 'nonstandardPhaseShiftSysEx')).report.fixed).toEqual([])
		const made = await fixed(data, 'nonstandardPhaseShiftSysEx', true)
		expect(made.report.fixed.map(entry => entry.description)).toEqual([
			'Rewrote the 7-byte tap SysEx event at tick 0 in "PART GUITAR" in the 8-byte form.',
			'Rewrote the 9-byte tap SysEx event at tick 300 in "PART GUITAR" in the 8-byte form.',
		])
		expect(made.report.hashes.map(change => change.key)).toEqual(['canonical:guitar:expert', 'canonical:song'])
		for (const parse of Object.values(parsers)) expect(tapTicks(made.data, parse)).toEqual([0, 100, 200])
		expect(made.data).toEqual(taps([1, 0xf7], [0, 0xf7]))
	})
})

describe('a UTF-8 byte order mark at the start of a .mid text', () => {
	const data = guitarMidi([midiText(0, '\ufeff[ENHANCED_OPENS]'), ...midiNote(480, 95, 10), ...midiNote(960, 96, 10)])

	it('stays part of the text in the scanner and canonical profiles, as Clone Hero keeps it, and is dropped in the frozen one', () => {
		expect(Array.from(data.subarray(data.indexOf(0xef), data.indexOf(0xef) + 4))).toEqual([0xef, 0xbb, 0xbf, 0x5b])
		for (const parse of [parsers.scanner, parsers.canonical]) expect(expertNotes(data, parse)).toEqual([[960, noteTypes.green]])
		expect(expertNotes(data, parsers.legacy)).toEqual([[480, noteTypes.open], [960, noteTypes.green]])
	})
})
