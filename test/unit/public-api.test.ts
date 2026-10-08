import { describe, expect, it } from 'vitest'

import * as publicApi from 'src'
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
	it('exports only the canonical identity profile', () => {
		const names = Object.keys(publicApi)
		expect(names).toContain('canonical20260801')
		for (const legacy of ['frozenLegacy6142', 'songBundle20251010', 'calculateTrackHash', 'historicalSongHashDurationMs']) {
			expect(names).not.toContain(legacy)
		}
	})

	it('calculates canonical song identity from the canonical profile alone', () => {
		const parsed = publicApi.canonical20260801.parseSource({ source: { format: 'chart', bytes: chart }, modifiers: defaultMetadata })
		if (parsed.kind !== 'accepted') throw new Error(parsed.errors[0].message)
		const bundle = publicApi.canonical20260801.calculateSongBundle({ chart: parsed.chart, metadata })
		expect(bundle.tracks.map(track => `${track.instrument}:${track.difficulty}`)).toEqual(['guitar:easy', 'guitar:expert'])
		expect(bundle.duration).toEqual(parsed.chart.duration)
		expect(bundle.song.metadata).toMatchObject({ year: 'Unknown Year', icon: '' })

		const internal = songBundle20251010.calculate({
			source: { format: 'chart', bytes: chart },
			modifiers: defaultMetadata,
			legacyMetadata: metadata,
			canonicalMetadata: metadata,
		})
		if (internal.kind !== 'accepted') throw new Error('Expected the internal bundle to accept the chart')
		expect(bundle.song.songHash.value).toBe(internal.canonical20260801.song.songHash.value)
		expect(bundle.tracks.map(track => track.identity.trackHash.value))
			.toEqual(internal.canonical20260801.tracks.map(track => track.identity.trackHash.value))
	})
})
