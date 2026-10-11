import { historicalSongHashDurationMs, HistoricalSongHashDurationMs } from '../../src/chart/identity/duration-types'
import { parseIni } from '../../src/ini/parse-ini'
import { calculateLegacyChartFallbackDurationMs } from '../../src/chart/chart-duration'
import type { ParsedChartFile } from '../../src/chart/parse-chart-file'

export interface HistoricalDurationAvailable {
	readonly kind: 'available'
	readonly source: 'song.ini:song_length' | 'chart-fallback'
	readonly durationMs: HistoricalSongHashDurationMs
}

export interface HistoricalDurationUnavailable {
	readonly kind: 'unavailable'
	readonly reason: 'missingSongLength' | 'zeroSongLength' | 'invalidSongLength' | 'audioLengthUnavailable'
}

/** Cache.TryUpdateChartMetadata tries non-crowd audio before GetLastTick(). */
export function resolveHistoricalDuration(
	iniBytes: Uint8Array | null,
	fileNames: readonly string[],
	legacyChart: ParsedChartFile,
): HistoricalDuration {
	const claimed = parseHistoricalDuration(iniBytes)
	if (claimed.kind === 'available') return claimed
	const hasAudio = fileNames.some(name => /^(?:guitar|bass|rhythm|vocals(?:_[12])?|drums(?:_[1-4])?|keys|song)\.(?:opus|ogg|mp3|wav)$/i.test(name))
	if (hasAudio) return { kind: 'unavailable', reason: 'audioLengthUnavailable' }
	return {
		kind: 'available',
		source: 'chart-fallback',
		durationMs: historicalSongHashDurationMs(calculateLegacyChartFallbackDurationMs(legacyChart)),
	}
}

export type HistoricalDuration = HistoricalDurationAvailable | HistoricalDurationUnavailable

/**
 * Reads the historical Clone Hero `song_length` claim used by the frozen
 * SongHash profile. This value is never used for canonical identity.
 */
export function parseHistoricalDuration(iniBytes: Uint8Array | null): HistoricalDuration {
	if (iniBytes === null) return { kind: 'unavailable', reason: 'missingSongLength' }
	const valueText = parseIni(iniBytes).iniObject.song?.song_length
	if (valueText === undefined) return { kind: 'unavailable', reason: 'missingSongLength' }
	if (!/^[+-]?\d+\0*$/.test(valueText)) {
		return { kind: 'unavailable', reason: 'invalidSongLength' }
	}
	const value = Number(valueText.replace(/\0+$/, ''))
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
