import { describe, expect, it } from 'vitest'

import { analyzeChart } from 'src/analyze-chart'
import { parseChartFile, parseChartFileCanonicalIdentity, parseChartFileFrozenLegacyIdentity } from 'src/chart/parse-chart-file'
import { noteTypes } from 'src/chart/types'
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
