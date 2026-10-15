import { describe, expect, it } from 'vitest'

import { analyzeChart } from 'src/analyze-chart'
import { authoredSongEvents, chartAuthoredTracks } from 'src/chart/authored-view'
import { tokenizeChartFile } from 'src/chart/chart-file-parser'
import { chartLineSpelling, chartSectionSpellings, chartSongSpellings } from 'src/chart/chart-line-spelling'
import { chartNormalizations } from 'src/chart/chart-normalize'
import { parseChartFileCanonicalIdentity, parseChartFileFrozenLegacyIdentity } from 'src/chart/parse-chart-file'
import { calculateCompetitiveHashes } from 'src/competitive'
import { resolveChart } from 'src/gameplay-chart'
import { editSong, parseSongFiles } from 'src/song-document'
import { fileBytes } from 'src/song-files'
import { saveSong, songHashes } from 'src/song-save'

const encode = (text: string) => new TextEncoder().encode(text)
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const songIni = { fileName: 'song.ini', data: encode('[song]\r\nname = Test\r\nsong_length = 60000\r\n') }
const chartText = (sections: [string, string[]][]) => sections.map(([name, lines]) => [`[${name}]`, '{', ...lines.map(line => `  ${line}`), '}'].join('\r\n')).join('\r\n') + '\r\n'
const song = (sections: [string, string[]][]) => parseSongFiles([{ fileName: 'notes.chart', data: encode(chartText(sections)) }, songIni])
const head: [string, string[]][] = [['Song', ['Resolution = 192']], ['SyncTrack', ['0 = TS 4', '0 = B 120000']]]

describe('reading a nonstandard .chart line', () => {
	it('respells a line with one probable meaning in the standard spelling', () => {
		const respelled = (text: string, section: 'sync' | 'events' | 'track') => {
			const spelling = chartLineSpelling(text, section)
			return spelling?.kind === 'respelled' ? spelling.line : spelling
		}
		expect(respelled('14592 N 5 0', 'track')).toBe('14592 = N 5 0')
		expect(respelled('0=N 1 0', 'track')).toBe('0 = N 1 0')
		expect(respelled('0 =  N  1\t0', 'track')).toBe('0 = N 1 0')
		expect(respelled('54466 = N 3 1103.9999999999927', 'track')).toBe('54466 = N 3 1104')
		expect(respelled('0 = N 1', 'track')).toBe('0 = N 1 0')
		expect(respelled('11520 = E  [idle', 'track')).toBe('11520 = E [idle')
		expect(respelled('0 = X  1 2', 'track')).toBe('0 = X 1 2')
		expect(respelled('0 =  B 120000', 'sync')).toBe('0 = B 120000')
		expect(respelled('0 = E section Intro', 'events')).toBe('0 = E "section Intro"')
		expect(respelled('768 = E "section Ocean breeze\r"', 'events')).toBe('768 = E "section Ocean breeze"')
	})

	it('gives null for a standard line', () => {
		for (const [text, section] of [['0 = N 1 0', 'track'], ['0 = E solo', 'track'], ['0 = X 1 2', 'track'], ['0 = TS 4 2', 'sync'], ['0 = A 500000', 'sync'],
			['0 = E "section Intro"', 'events']] as const) {
			expect(chartLineSpelling(text, section)).toBeNull()
		}
	})

	it('reads as the games do a line they load but don\'t read as it probably means', () => {
		expect(chartLineSpelling('79009 = E "phrase_end', 'events')).toEqual({ kind: 'asWritten' })
		expect(chartLineSpelling('0 = E a\rb', 'track')).toEqual({ kind: 'asWritten' })
	})

	it('can\'t read a line with no probable meaning', () => {
		for (const [text, section] of [['52952 = S 2 -1649', 'track'], ['73344  85632 = E "section The Next Chapter"', 'events'], ['419040', 'track'],
			['0 = N 1 0 0', 'track'], ['0 = E', 'track'], ['-5 = N 0 0', 'track'], ['0 = TS', 'sync']] as const) {
			expect(chartLineSpelling(text, section)).toEqual({ kind: 'unreadable' })
		}
	})

	it('joins a text that runs onto the next line', () => {
		expect(chartSectionSpellings(['264480 = E "lyric Saa', '"', '264576 = E "lyric yo"'], 'events')).toEqual([
			{ kind: 'respelled', line: '264480 = E "lyric Saa"' },
			{ kind: 'continued' },
			null,
		])
		expect(chartSongSpellings(['Genre = "Alternative/Indie', '"', 'MediaType = "cd"'])).toEqual([
			{ kind: 'respelled', line: 'Genre = "Alternative/Indie"' },
			{ kind: 'continued' },
			null,
		])
	})

	it('reads [Song] number keys: other spacing respelled, a decimal comma as the games read it, anything else unreadable', () => {
		expect(chartSongSpellings(['Resolution=480', 'Offset = 0,1', 'PreviewStart = omaewamoushindeiru', 'Name = "A"', 'Offset = "0.5"', '"'])).toEqual([
			{ kind: 'respelled', line: 'Resolution = 480' },
			{ kind: 'asWritten' },
			{ kind: 'unreadable' },
			null,
			null,
			{ kind: 'unreadable' },
		])
	})
})

describe('parsing a nonstandard .chart file', () => {
	const standard = song([...head, ['Events', ['0 = E "section Intro"', '96 = E "lyric Saa"']], ['ExpertSingle', ['0 = N 0 0', '96 = N 1 1104', '192 = E solo', '384 = E soloend']]])
	const nonstandard = song([
		['SyncTrack', ['0 = TS 4', '0 =  B 120000']],
		['Song', ['Resolution=192']],
		['Events', ['0 = E "section Intro\r"', '96 = E "lyric Saa', '"', '200 = E "phrase_end']],
		['ExpertSingle', ['0 N 0 0', '96 = N 1 1103.9999999999927', '192 = E  solo', '384 = E soloend', '400 = S 2 -1649']],
	])

	it('gives the canonical hashes of the standard spelling', () => {
		expect(calculateCompetitiveHashes(nonstandard)).toEqual(calculateCompetitiveHashes(standard))
	})

	it('reads the same chart as the standard spelling: notes, solo, tempo map, sections and lyrics', () => {
		const read = (document: ReturnType<typeof song>) => JSON.parse(JSON.stringify(resolveChart(document)))
		expect(read(nonstandard)).toEqual(read(standard))
		expect(resolveChart(nonstandard).sections.map(section => section.name)).toEqual(['Intro'])
	})

	it('keeps the frozen legacy reading: a nonstandard line is skipped there', () => {
		const bytes = (sections: [string, string[]][]) => encode(chartText(sections))
		const legacy = parseChartFileFrozenLegacyIdentity(bytes([...head, ['ExpertSingle', ['0 = N 0 0', '192 N 1 0', '384 = E  solo']]]), 'chart')
		const without = parseChartFileFrozenLegacyIdentity(bytes([...head, ['ExpertSingle', ['0 = N 0 0']]]), 'chart')
		expect(legacy.trackData[0].noteEventGroups).toEqual(without.trackData[0].noteEventGroups)
		expect(legacy.trackData[0].textEvents.map(event => event.text)).toEqual([' solo'])
		const canonical = parseChartFileCanonicalIdentity(bytes([...head, ['ExpertSingle', ['0 = N 0 0', '192 N 1 0']]]), 'chart')
		expect(canonical.trackData[0].noteEventGroups).toHaveLength(2)
	})

	it('reads a file without a resolution with 192, and one written as Resolution=480 with 480; the frozen profile refuses both', () => {
		const noSong = encode(chartText([['SyncTrack', ['0 = B 120000']], ['ExpertSingle', ['0 = N 0 0']]]))
		expect(parseChartFileCanonicalIdentity(noSong, 'chart').resolution).toBe(192)
		expect(() => parseChartFileFrozenLegacyIdentity(noSong, 'chart')).toThrow('resolution not found')
		const spaced = encode(chartText([['Song', ['Resolution=480']], ['SyncTrack', ['0 = B 120000']], ['ExpertSingle', ['0 = N 0 0']]]))
		expect(parseChartFileCanonicalIdentity(spaced, 'chart').resolution).toBe(480)
		for (const written of ['Resolution = abc', 'Resolution=abc', 'Resolution = 0']) {
			const invalid = encode(chartText([['Song', [written]], ['SyncTrack', ['0 = B 120000']], ['ExpertSingle', ['0 = N 0 0']]]))
			expect(() => parseChartFileCanonicalIdentity(invalid, 'chart')).toThrow('resolution not found')
		}
		// Read by its leading digits, as Clone Hero reads it. The frozen profile keeps scan-chart 8's reading.
		const withResolution = (written: string) => encode(chartText([['Song', [written]], ['SyncTrack', ['0 = B 120000']], ['ExpertSingle', ['0 = N 0 0']]]))
		expect(parseChartFileCanonicalIdentity(withResolution('Resolution = 480.5'), 'chart').resolution).toBe(480)
		expect(parseChartFileCanonicalIdentity(withResolution('Resolution = 1e3'), 'chart').resolution).toBe(1)
		expect(parseChartFileCanonicalIdentity(withResolution('Resolution = "480"'), 'chart').resolution).toBe(480)
		expect(() => parseChartFileCanonicalIdentity(withResolution('Resolution = -192'), 'chart')).toThrow('resolution not found')
		expect(parseChartFileFrozenLegacyIdentity(withResolution('Resolution = 480.5'), 'chart').resolution).toBe(480.5)
		const offset = encode(chartText([['Song', ['Resolution = 192', 'Offset=0.5']], ['SyncTrack', ['0 = B 120000']], ['ExpertSingle', ['0 = N 0 0']]]))
		expect(parseChartFileCanonicalIdentity(offset, 'chart').metadata.chart_offset).toBe(500)
	})

	it('gives the authored view the respelled lines, with the written line as their source', () => {
		const chart = nonstandard.chart?.format === 'chart' ? nonstandard.chart : null
		const expert = chartAuthoredTracks(chart!.tokens).find(track => track.sectionName === 'ExpertSingle')!
		expect(expert.events.map(event => [event.tick, event.length, event.source.line])).toEqual([[0, 0, 1], [96, 1104, 2], [192, 0, 3], [384, 0, 4]])
		const songEvents = authoredSongEvents(chart!)
		expect(songEvents.tempos.map(tempo => [tempo.tick, tempo.beatsPerMinute, tempo.source])).toEqual([[0, 120, { format: 'chart', section: 0, line: 2 }]])
		expect(songEvents.textEvents?.map(event => [event.tick, event.text])).toEqual([[0, 'section Intro'], [96, 'lyric Saa']])
	})
})

describe('the issues of a nonstandard .chart file', () => {
	it('name the first line of each kind, and the sections', () => {
		const document = song([
			['SyncTrack', ['0 = B 120000']],
			['Song', ['Name = "Test"', 'Offset = 0,1']],
			['ExpertSingle', ['0 N 0 0', '192 N 1 0', '400 = S 2 -1649']],
		])
		const issues = analyzeChart(resolveChart(document)).issues
			.filter(issue => ['nonstandardChartLine', 'unreadableChartLine', 'nonstandardChartSections'].includes(issue.code))
			.map(({ code, instrument, message }) => ({ code, instrument, message }))
		expect(issues).toEqual([
			{
				code: 'nonstandardChartLine',
				instrument: null,
				message: 'The line "Offset = 0,1" isn\'t written the standard way, and Clone Hero doesn\'t read what it probably means. scan-chart reads it as Clone Hero does, and saving leaves it as written, to be fixed by hand.',
			},
			{
				code: 'nonstandardChartLine',
				instrument: 'guitar',
				message: '2 lines, such as "0 N 0 0", aren\'t written the standard way. scan-chart reads that one as "0 = N 0 0", and saving an edit writes them that way.',
			},
			{
				code: 'unreadableChartLine',
				instrument: 'guitar',
				message: 'The line "400 = S 2 -1649" can\'t be read, so scan-chart ignores it. Saving an edit removes it: fix it first to keep what it meant.',
			},
			{
				code: 'nonstandardChartSections',
				instrument: null,
				message: 'The [Song] section has no Resolution. scan-chart reads it as 192, and saving an edit adds it. [Song] and [SyncTrack] aren\'t the first two sections, which YARG needs. Saving an edit moves them.',
			},
		])
	})

	it('aren\'t reported for a standard file', () => {
		const document = song([...head, ['Events', ['0 = E "section Intro"']], ['ExpertSingle', ['0 = N 0 0', '0 = A 1', '192 = E solo']]])
		expect(analyzeChart(resolveChart(document)).issues.map(issue => issue.code)).not.toEqual(expect.arrayContaining(['nonstandardChartLine']))
		expect(analyzeChart(resolveChart(document)).issues.filter(issue => /nonstandard|unreadable/.test(issue.code))).toEqual([])
	})
})

describe('saving a nonstandard .chart file', () => {
	const normalized = (text: string) => {
		let tokens = tokenizeChartFile(encode(text))
		for (const normalization of chartNormalizations(tokens)) tokens = normalization.apply(tokens)
		return { text: tokens.text, kinds: chartNormalizations(tokenizeChartFile(encode(text))).map(({ kind, section }) => `${kind}:${section}`) }
	}

	it('writes every line the way scan-chart reads it, removes what it can\'t read, and puts [Song] and [SyncTrack] first', () => {
		const text = chartText([
			['SyncTrack', ['0 = TS 4', '0 =  B 120000']],
			['Song', ['Name = "Test"', 'Genre = "Rock', '"', 'Offset = 0,1', 'PreviewStart = junk']],
			['Events', ['96 = E "lyric Saa', '"', '200 = E "phrase_end']],
			['ExpertSingle', ['0 N 0 0', '192 = N 1', '400 = S 2 -1649']],
		])
		const result = normalized(text)
		expect(result.text).toBe(chartText([
			['Song', ['Resolution = 192', 'Name = "Test"', 'Genre = "Rock"', 'Offset = 0,1']],
			['SyncTrack', ['0 = TS 4', '0 = B 120000']],
			['Events', ['96 = E "lyric Saa"', '200 = E "phrase_end']],
			['ExpertSingle', ['0 = N 0 0', '192 = N 1 0']],
		]))
		expect(result.kinds).toEqual([
			'lineSpelling:SyncTrack', 'lineSpelling:Song', 'unreadableLines:Song', 'lineSpelling:Events', 'lineSpelling:ExpertSingle',
			'unreadableLines:ExpertSingle', 'sectionOrder:null',
		])
	})

	it('adds a [Song] section to a file without one, and gives what\'s left of a cut-off line before } a line of its own, then removes it', () => {
		const text = '[SyncTrack]\r\n{\r\n  0 = B 120000\r\n}\r\n[ExpertSingle]\r\n{\r\n  0 = N 0 0\r\n  419040}\r\n'
		expect(normalized(text).text).toBe('[Song]\r\n{\r\n  Resolution = 192\r\n}\r\n[SyncTrack]\r\n{\r\n  0 = B 120000\r\n}\r\n[ExpertSingle]\r\n{\r\n  0 = N 0 0\r\n}\r\n')
	})

	it('removes the earlier of two tempo markers or time signatures at a tick, which readers don\'t use', () => {
		const text = chartText([
			['Song', ['Resolution = 192']],
			['SyncTrack', ['0 = TS 4', '0 = B 100000', '0 = TS 3', '0 = B 120000', '768 = B 140000', '768 = B 140000', '768 = B 150000', '960 = B x']],
			['ExpertSingle', ['0 = N 0 0', '960 = N 1 0']],
		])
		const result = normalized(text)
		expect(result.kinds).toEqual(['unreadableLines:SyncTrack', 'order:SyncTrack', 'duplicateLines:SyncTrack', 'repeatedMarkers:SyncTrack'])
		expect(result.text).toBe(chartText([
			['Song', ['Resolution = 192']],
			['SyncTrack', ['0 = TS 3', '0 = B 120000', '768 = B 150000']],
			['ExpertSingle', ['0 = N 0 0', '960 = N 1 0']],
		]))
		const hashes = (chartFile: string) => songHashes(parseSongFiles([{ fileName: 'notes.chart', data: encode(chartFile) }, songIni]))
		expect(hashes(result.text)).toEqual(hashes(text))
	})

	// [Song] agrees with song.ini, so the [Song] normalization has nothing to do.
	const savedHead: [string, string[]][] = [['Song', ['Resolution = 192', 'Name = "Test"', 'Length = 60']], head[1]]

	it('respells the lines of a track the edit didn\'t change: that changes only its legacy hashes', () => {
		const original = song([...savedHead, ['ExpertSingle', ['0 N 0 0', '192 = N 1 0']], ['HardSingle', ['0 N 0 0']]])
		const tokens = original.chart?.format === 'chart' ? original.chart.tokens : null
		const expert = chartAuthoredTracks(tokens!).find(track => track.sectionName === 'ExpertSingle')!
		const edited = editSong(original, batch => batch.setLength(expert.events.find(event => event.tick === 192)!, 96))
		const { files, report } = saveSong(original, edited)
		expect(report.withheld).toEqual([])
		expect(decode(fileBytes(files[0]))).toBe(chartText([...savedHead, ['ExpertSingle', ['0 = N 0 0', '192 = N 1 96']], ['HardSingle', ['0 = N 0 0']]]))
		expect(songHashes(parseSongFiles(files))?.get('canonical:guitar:hard')).toBe(songHashes(original)?.get('canonical:guitar:hard'))
	})

	it('normalizes an edited file the frozen profile refuses, such as one without a [Song] section', () => {
		const original = song([head[1], ['ExpertSingle', ['0 N 0 0', '192 = N 1 0']]])
		const tokens = original.chart?.format === 'chart' ? original.chart.tokens : null
		const expert = chartAuthoredTracks(tokens!).find(track => track.sectionName === 'ExpertSingle')!
		const edited = editSong(original, batch => batch.setLength(expert.events.find(event => event.tick === 192)!, 96))
		const { files, report } = saveSong(original, edited)
		expect(report.withheld).toEqual([])
		expect(decode(fileBytes(files[0]))).toBe(chartText([['Song', ['Resolution = 192']], head[1], ['ExpertSingle', ['0 = N 0 0', '192 = N 1 96']]]))
	})

	it('edits a nonstandard line from the standard spelling it\'s read as', () => {
		const original = song([...head, ['ExpertSingle', ['0 = N 0 0', '192 N 1 0']]])
		const tokens = original.chart?.format === 'chart' ? original.chart.tokens : null
		const expert = chartAuthoredTracks(tokens!).find(track => track.sectionName === 'ExpertSingle')!
		const edited = editSong(original, batch => batch.setLength(expert.events.find(event => event.tick === 192)!, 48))
		const editedTokens = edited.chart?.format === 'chart' ? edited.chart.tokens : null
		expect(editedTokens!.text).toContain('  192 = N 1 48\r\n')
	})
})
