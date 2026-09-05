const historicalSongHashDurationToken: unique symbol = Symbol('historicalSongHashDuration')
const canonicalChartDurationToken: unique symbol = Symbol('canonicalChartDuration')
const trackDurationToken: unique symbol = Symbol('trackDuration')

export type HistoricalSongHashDurationMs = bigint & {
	readonly [historicalSongHashDurationToken]: 'historical-song-hash-duration-ms'
}

export type CanonicalChartDurationMs = bigint & {
	readonly [canonicalChartDurationToken]: 'canonical-chart-duration-ms'
}

export type TrackDurationMs = bigint & {
	readonly [trackDurationToken]: 'track-duration-ms'
}

const minimumInt64 = -(BigInt(1) << BigInt(63))
const maximumInt64 = (BigInt(1) << BigInt(63)) - BigInt(1)

function requireInt64(value: bigint, field: string): bigint {
	if (value < minimumInt64 || value > maximumInt64) throw new RangeError(`${field} must fit signed int64`)
	return value
}

export function historicalSongHashDurationMs(value: bigint): HistoricalSongHashDurationMs {
	return requireInt64(value, 'historical SongHash duration') as HistoricalSongHashDurationMs
}

export function canonicalChartDurationMs(value: bigint): CanonicalChartDurationMs {
	if (value < BigInt(0)) throw new RangeError('canonical chart duration must be nonnegative')
	return requireInt64(value, 'canonical chart duration') as CanonicalChartDurationMs
}

export function trackDurationMs(value: bigint): TrackDurationMs {
	if (value < BigInt(1)) throw new RangeError('track duration must be at least one millisecond')
	return requireInt64(value, 'track duration') as TrackDurationMs
}
