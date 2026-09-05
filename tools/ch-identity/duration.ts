import {
	historicalSongHashDurationMs,
	HistoricalSongHashDurationMs,
} from '../../src/chart/identity/duration-types'

export interface HistoricalDurationAvailable {
	readonly kind: 'available'
	readonly source: 'song.ini:song_length'
	readonly durationMs: HistoricalSongHashDurationMs
}

export interface HistoricalDurationUnavailable {
	readonly kind: 'unavailable'
	readonly reason: 'missingSongLength' | 'zeroSongLength' | 'invalidSongLength'
}

export type HistoricalDuration = HistoricalDurationAvailable | HistoricalDurationUnavailable

/**
 * Reads the historical Clone Hero `song_length` claim used by the frozen
 * SongHash profile. This value is never used for canonical identity.
 */
export function parseHistoricalDuration(iniText: string | null): HistoricalDuration {
	if (iniText === null) return { kind: 'unavailable', reason: 'missingSongLength' }
	let inSong = false
	for (const rawLine of iniText.split(/\r?\n/)) {
		const line = rawLine.trim()
		if (line.startsWith('[') && line.endsWith(']')) {
			inSong = line.slice(1, -1).trim().toLowerCase() === 'song'
			continue
		}
		if (!inSong) continue
		const assignment = /^song_length\s*=\s*(.*?)\s*$/i.exec(line)
		if (!assignment) continue
		if (!/^[+-]?\d+$/.test(assignment[1])) {
			return { kind: 'unavailable', reason: 'invalidSongLength' }
		}
		const value = Number(assignment[1])
		if (!Number.isInteger(value) || value < -2_147_483_648 || value > 2_147_483_647) {
			return { kind: 'unavailable', reason: 'invalidSongLength' }
		}
		if (value === 0) return { kind: 'unavailable', reason: 'zeroSongLength' }
		return {
			kind: 'available',
			source: 'song.ini:song_length',
			durationMs: historicalSongHashDurationMs(BigInt(value)),
		}
	}
	return { kind: 'unavailable', reason: 'missingSongLength' }
}
