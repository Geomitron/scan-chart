import { describe, expect, it } from 'vitest'

import { analyzeChart } from 'src/analyze-chart'
import { parseChartAndIni } from 'src/chart/parse-chart-and-ini'
import { ChartReadError, resolveChart } from 'src/gameplay-chart'
import { msToExactTime } from 'src/shared/time'
import { scanChart } from 'src/scan-chart'
import { parseSong } from 'src/song-document'

const encode = (text: string) => new TextEncoder().encode(text)
const chart = (sections: Record<string, readonly string[]>) => {
	const lines = ['[Song]', '{', '  Resolution = 192', '}', '[SyncTrack]', '{', '  0 = TS 4', '  0 = B 120000', '  500 = TS 3', '}', '[Events]', '{', '}']
	for (const [name, body] of Object.entries(sections)) lines.push(`[${name}]`, '{', ...body.map(line => `  ${line}`), '}')
	return encode(lines.join('\r\n') + '\r\n')
}
// Issues of several kinds: a misaligned time signature, a broken note, a baby sustain, a forbidden note on Easy,
// an empty star power phrase, no sections, and Hard identical to Expert.
const notes = Array.from({ length: 30 }, (_, i) => `${i * 192} = N ${i % 3} 0`)
const files = [
	{ fileName: 'notes.chart', data: chart({
		ExpertSingle: [...notes, '5760 = N 0 10', '5762 = N 1 0', '5952 = S 2 10'],
		HardSingle: [...notes, '5760 = N 0 10', '5762 = N 1 0', '5952 = S 2 10'],
		EasySingle: ['0 = N 4 0'],
	}) },
	{ fileName: 'song.ini', data: encode('[song]\r\nname = Song\r\nsong_length = 60000\r\n') },
]

describe('the gameplay chart', () => {
	it('is resolved once per document, with the glossary\'s names', () => {
		const song = parseSong(files)
		const gameplay = resolveChart(song)
		expect(resolveChart(song)).toBe(gameplay)
		expect(gameplay.format).toBe('chart')
		expect(gameplay.tracks.map(track => `${track.instrument}:${track.difficulty}`)).toEqual(['guitar:expert', 'guitar:hard', 'guitar:easy'])
		expect(gameplay.tracks[0].noteGroups[0][0]).toEqual({ tick: 0, length: 0, type: 2, flags: 1, msTime: 0, msLength: 0 })
		expect(gameplay.timeSignatures[1]).toEqual({ tick: 500, msTime: expect.any(Number), numerator: 3, denominator: 4 })
		expect(gameplay.settings).not.toHaveProperty('song_length')
		expect(gameplay.vocals).toBeNull()
	})

	it('throws ChartReadError when the song has no readable chart', () => {
		expect(() => resolveChart(parseSong([files[1]]))).toThrow(ChartReadError)
		expect(() => resolveChart(parseSong([{ fileName: 'notes.chart', data: encode('[Song]\r\n{\r\n}\r\n') }]))).toThrow('resolution not found')
	})
})

describe('analyzing a gameplay chart', () => {
	it('finds the issues and statistics the 8.x scanner found, with times as data', () => {
		const { issues, stats } = analyzeChart(resolveChart(parseSong(files)))
		const scanned = scanChart(files, parseChartAndIni(files))
		expect(issues.map(({ instrument, difficulty, code, msTime, message }) => ({
			instrument,
			difficulty,
			noteIssue: code,
			description: msTime === null ? message : `[${msToExactTime(msTime)}]: ${message}`,
		}))).toEqual(scanned.notesData!.chartIssues)
		expect(issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['misalignedTimeSignature', 'brokenNote', 'babySustain', 'difficultyForbiddenNote', 'emptyStarPower', 'noSections', 'difficultyNotReduced']))
		expect(issues.every(issue => issue.scope === 'chart')).toBe(true)
		const notesData = scanned.notesData!
		expect(stats).toEqual({
			instruments: notesData.instruments,
			drumType: notesData.drumType,
			hasSolos: notesData.hasSoloSections,
			hasLyrics: notesData.hasLyrics,
			hasVocals: notesData.hasVocals,
			hasForcedNotes: notesData.hasForcedNotes,
			hasTapNotes: notesData.hasTapNotes,
			hasOpenNotes: notesData.hasOpenNotes,
			has2xKick: notesData.has2xKick,
			hasFlexLanes: notesData.hasFlexLanes,
			noteCounts: notesData.noteCounts,
			maxNps: notesData.maxNps.map(({ instrument, difficulty, nps, time }) => ({ instrument, difficulty, nps, msTime: time })),
			noteSpanMs: notesData.effectiveLength,
			tempoMarkerCount: notesData.tempoMarkerCount,
		})
	})

	it('needs a chart that resolveChart returned', () => {
		const gameplay = resolveChart(parseSong(files))
		expect(() => analyzeChart({ ...gameplay })).toThrow(TypeError)
	})
})
