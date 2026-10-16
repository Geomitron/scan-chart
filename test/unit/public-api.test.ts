import { describe, expect, it } from 'vitest'

import * as publicApi from 'src'
import * as competitive from 'src/competitive'
import { songBundle20251010 } from 'src/chart/identity/public'
import { defaultMetadata } from 'src/ini/metadata'

const chart = new TextEncoder().encode([
	'[Song]', '{', '  Resolution = 192', '}',
	'[SyncTrack]', '{', '  0 = B 120000', '}',
	'[ExpertSingle]', '{', '  0 = N 0 0', '  192 = N 1 96', '}',
	'[EasySingle]', '{', '  0 = N 0 0', '}',
	'[HardSingle]', '{', '}',
].join('\r\n'))

const metadata = { name: 'Name', artist: 'Artist', album: null, genre: null, year: '0', charter: 'Charter', icon: 'charter' }

describe('public API', () => {
	it('exports the 9.0.0 functions and constants, and none of 8.x\'s', () => {
		expect(Object.keys(publicApi).sort()).toEqual([
			'ChartReadError', 'ConversionError', 'analyzeChart', 'authoredSongEvents', 'authoredTracks', 'byteSourceFromBlob', 'chartCapabilities',
			'convertChart', 'createSong', 'defaultChartParseSettings', 'defaultMetadata', 'difficulties', 'drumTypes', 'editSong', 'fixIssues',
			'getInstrumentType', 'instrumentTypes', 'instruments', 'issueFixes', 'lyricFlags', 'noteFlags', 'noteTypes', 'parseSong',
			'parseSongMetadata', 'resolveChart', 'savePlanToBlobs', 'scanSongFolder', 'serializeSong', 'songMetadata',
			'writeSavePlanFile',
		])
	})

	it('offers editSong\'s batch without the raw additions by token position', () => {
		publicApi.editSong(publicApi.createSong({ format: 'chart' }), batch => {
			// @ts-expect-error The additions by token position and numeric event type are internal.
			expect(typeof batch.addToChartSection).toBe('function')
		})
	})

	it('keeps the competitive hashes and the specification API in scan-chart/competitive', () => {
		const names = Object.keys(competitive)
		for (const name of ['calculateCompetitiveHashes', 'canonical20260801', 'frozenLegacy6142', 'songBundle20251010']) {
			expect(names).toContain(name)
			expect(Object.keys(publicApi)).not.toContain(name)
		}
	})

	it('calculates canonical song identity from the canonical profile alone', () => {
		const parsed = competitive.canonical20260801.parseSource({ source: { format: 'chart', bytes: chart }, modifiers: defaultMetadata })
		if (parsed.kind !== 'accepted') throw new Error(parsed.errors[0].message)
		const bundle = competitive.canonical20260801.calculateSongBundle({ chart: parsed.chart, metadata })
		expect(bundle.tracks.map(track => `${track.instrument}:${track.difficulty}`)).toEqual(['guitar:easy', 'guitar:expert'])
		expect(bundle.duration).toEqual(parsed.chart.duration)
		expect(bundle.song.metadata).toMatchObject({ year: 'Unknown Year', icon: '' })

		const internal = songBundle20251010.calculate({
			source: { format: 'chart', bytes: chart },
			modifiers: defaultMetadata,
			legacyModifiers: defaultMetadata,
			legacyMetadata: metadata,
			canonicalMetadata: metadata,
		})
		if (internal.kind !== 'accepted') throw new Error('Expected the internal bundle to accept the chart')
		expect(bundle.song.songHash.value).toBe(internal.canonical20260801.song.songHash.value)
		expect(bundle.tracks.map(track => track.identity.trackHash.value))
			.toEqual(internal.canonical20260801.tracks.map(track => track.identity.trackHash.value))
	})
})
