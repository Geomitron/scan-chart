import { describe, expect, it } from 'vitest'

import { analyzeChart } from 'src/analyze-chart'
import { readMixEvent } from 'src/chart/mix-event'
import { parseChartFile, parseChartFileCanonicalIdentity, parseChartFileFrozenLegacyIdentity } from 'src/chart/parse-chart-file'
import { fixIssues } from 'src/fix-issues'
import { resolveChart } from 'src/gameplay-chart'
import { parseSong, parseSongFiles } from 'src/song-document'

import { chartFile } from './helpers/chart-files'
import { midiFile, midiNote, midiText } from './helpers/midi-files'

const parsers = { scanner: parseChartFile, canonical: parseChartFileCanonicalIdentity, legacy: parseChartFileFrozenLegacyIdentity }
const drumsChart = (...lines: string[]) => chartFile(['[ExpertDrums]', '{', ...['480 = N 1 0', ...lines].map(line => `  ${line}`), '}'])
const drumsMidi = (...texts: string[]) => midiFile([{ name: 'PART DRUMS', events: [...texts.map(text => midiText(0, text)), ...midiNote(480, 97)] }])
const mixes = (data: Uint8Array, format: 'chart' | 'mid', parse: typeof parseChartFile) =>
	parse(data, format).trackData.find(track => track.instrument === 'drums' && track.difficulty === 'expert')!.drumMixes
const mixIssues = (files: { fileName: string; data: Uint8Array }[]) => analyzeChart(resolveChart(parseSongFiles(files))).issues
	.filter(issue => issue.code === 'nonstandardMixEvent').map(({ difficulty, severity, message }) => ({ difficulty, severity, message }))

describe('mix events spelled another way (C20: R2, R10)', () => {
	it('reads each as Clone Hero does: TryParseDiscoMixEvent, then ParseDiscoMix', () => {
		expect(readMixEvent('mix 3  drums0d', 'cloneHero')).toEqual({ difficulty: 'expert', configuration: 0, flag: 'd' })
		expect(readMixEvent('mix 3 drumsxd', 'cloneHero')).toEqual({ difficulty: 'expert', configuration: 0, flag: 'd' })
		expect(readMixEvent('[mix 03 drums0d]', 'cloneHero')).toEqual({ difficulty: 'expert', configuration: 0, flag: 'd' })
		expect(readMixEvent('[mix 3 drums6d]', 'cloneHero')).toEqual({ difficulty: 'expert', configuration: 0, flag: 'd' })
		expect(readMixEvent('[mix 3 drums0dx]', 'cloneHero')).toEqual({ difficulty: 'expert', configuration: 0, flag: 'd' })
		expect(readMixEvent('[mix 3 drumsd]', 'cloneHero')).toEqual({ difficulty: 'expert', configuration: 0, flag: '' })
		expect(readMixEvent('[mix_2_drums4dnoflip]', 'cloneHero')).toEqual({ difficulty: 'hard', configuration: 4, flag: 'dnoflip' })
		// Clone Hero reads only text that starts with "[mix" or "mix", and ignores a flag that doesn't start with d.
		expect(readMixEvent(' [mix 3 drums0d]', 'cloneHero')).toBeNull()
		expect(readMixEvent('[mix 3 drums0x]', 'cloneHero')).toBeNull()
		expect(readMixEvent('[mix 4 drums0d]', 'cloneHero')).toBeNull()
		// scan-chart 8's reading, which the frozen profile keeps, reads none of the other spellings.
		expect(readMixEvent('[mix 03 drums0d]', 'strict')).toBeNull()
		expect(readMixEvent(' [mix 3 drums0d]', 'strict')).toEqual({ difficulty: 'expert', configuration: 0, flag: 'd' })
	})

	it('flips with them in a .chart file in the scanner and canonical profiles, and not in the frozen one', () => {
		const data = drumsChart('0 = E mix 3  drums0d', '960 = E mix 3 drumsxd', '1440 = E mix 3 drumsd')
		for (const parse of [parsers.scanner, parsers.canonical]) {
			expect(mixes(data, 'chart', parse)).toEqual([
				{ tick: 0, configuration: 0, flag: 'd' }, { tick: 960, configuration: 0, flag: 'd' }, { tick: 1440, configuration: 0, flag: '' }])
		}
		expect(mixes(data, 'chart', parsers.legacy)).toEqual([])
	})

	it('flips with them in a .mid file in the scanner and canonical profiles, and not in the frozen one', () => {
		for (const text of ['[mix 03 drums0d]', '[mix 3 drums6d]', '[mix 3 drums0dx]']) {
			for (const parse of [parsers.scanner, parsers.canonical]) expect(mixes(drumsMidi(text), 'mid', parse), text).toEqual([{ tick: 0, configuration: 0, flag: 'd' }])
			expect(mixes(drumsMidi(text), 'mid', parsers.legacy), text).toEqual([])
		}
		for (const parse of [parsers.scanner, parsers.canonical]) expect(mixes(drumsMidi('[mix 3 drumsd]'), 'mid', parse)).toEqual([{ tick: 0, configuration: 0, flag: '' }])
		expect(mixes(drumsMidi('[mix 3 drumsd]'), 'mid', parsers.legacy)).toEqual([])
		// One Clone Hero ignores, the frozen profile reads.
		for (const parse of [parsers.scanner, parsers.canonical]) expect(mixes(drumsMidi(' [mix 3 drums0d]'), 'mid', parse)).toEqual([])
		expect(mixes(drumsMidi(' [mix 3 drums0d]'), 'mid', parsers.legacy)).toEqual([{ tick: 0, configuration: 0, flag: 'd' }])
	})

	it('reports them as an error, per difficulty, naming the first', () => {
		expect(mixIssues([{ fileName: 'notes.chart', data: drumsChart('0 = E mix 3  drums0d', '960 = E mix 3 drumsxd') }])).toEqual([{
			difficulty: 'expert',
			severity: 'error',
			message: '2 mix events, such as "mix 3  drums0d" at tick 0, aren\'t spelled the standard way. Clone Hero reads that one as "mix 3 drums0d", '
				+ 'and other programs may not. fixIssues can rewrite them in the standard spelling.',
		}])
		expect(mixIssues([{ fileName: 'notes.mid', data: drumsMidi(' [mix 3 drums0d]', '[mix 3 drums0d]', '[mix 2 drums0dnoflip]') }])).toEqual([{
			difficulty: 'expert',
			severity: 'error',
			message: 'The mix event " [mix 3 drums0d]" at tick 0 isn\'t spelled the standard way. Clone Hero ignores it, and other programs may read it as '
				+ '"mix 3 drums0d". fixIssues can rewrite it in the standard spelling.',
		}])
		expect(mixIssues([{ fileName: 'notes.chart', data: drumsChart('0 = E mix 3 drums0d', '960 = E mix 3 drums0easy') }])).toEqual([])
	})

	it('rewrites them in the standard spelling, keeping the bytes until fixed', async () => {
		const chart = await parseSong([{ fileName: 'notes.chart', data: drumsChart('0 = E mix 3 drumsxd') }])
		const fixedChart = await fixIssues(chart, { codes: ['nonstandardMixEvent'] })
		expect(fixedChart.report.fixed).toEqual([{ code: 'nonstandardMixEvent', file: 'notes.chart', description: 'Rewrote the mix event "mix 3 drumsxd" at tick 0 in [ExpertDrums] as "mix 3 drums0d".' }])
		expect(new TextDecoder().decode(fixedChart.song.chart!.format === 'chart' ? fixedChart.song.chart!.tokens.bytes : undefined)).toContain('  0 = E mix 3 drums0d\r\n')

		// Clone Hero ignores this one, so its fix changes the canonical hashes, and is made only with changeHashes.
		const mid = await parseSong([{ fileName: 'notes.mid', data: drumsMidi(' [mix 3 drums0d]') }])
		const withheld = await fixIssues(mid, { codes: ['nonstandardMixEvent'] })
		expect(withheld.report.fixed).toEqual([])
		expect(withheld.report.skipped).toEqual([{
			code: 'nonstandardMixEvent', file: 'notes.mid',
			reason: 'Rewriting the mix event " [mix 3 drums0d]" at tick 0 in "PART DRUMS" as "mix 3 drums0d" would change the SongHash and a TrackHash: fix it with changeHashes.',
		}])
		const made = await fixIssues(mid, { codes: ['nonstandardMixEvent'], changeHashes: true })
		expect(made.report.fixed.map(entry => entry.description)).toEqual(['Rewrote the mix event " [mix 3 drums0d]" at tick 0 in "PART DRUMS" as "mix 3 drums0d".'])
		expect(made.report.hashes.map(change => change.key)).toEqual(['canonical:drums:expert', 'canonical:song'])
	})
})
