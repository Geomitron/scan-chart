import { blake3 } from '@awasm/noble'
import { base64url } from 'rfc4648'

import type { CanonicalTempo, CanonicalTimeSignature } from './btrack-20260801'

/** A chart's tempo map as the canonical rules read it: one tempo and one time signature at most per tick, by tick. */
export interface CanonicalTempoMap {
	readonly tempos: readonly CanonicalTempo[]
	readonly timeSignatures: readonly CanonicalTimeSignature[]
}

/**
 * Clone Hero's tempo map hash (`Song.ComputeTempoMapHash`), which the leaderboard backend compares across scores:
 * BLAKE3 over the tempo count (uint32), each tempo's tick (int64) and exact BPM (float64), the time signature count
 * (uint32), and each signature's tick (int64), numerator and denominator (uint32), all little-endian, encoded as
 * unpadded base64url. Unlike the TrackHash, it keeps the exact tempo, and it keeps the default tempo and time signature
 * a chart without one at tick 0 is given.
 */
export function calculateTempoMapHash(tempoMap: CanonicalTempoMap): string {
	const { tempos, timeSignatures } = tempoMap
	const bytes = new Uint8Array(8 + 16 * tempos.length + 16 * timeSignatures.length)
	const view = new DataView(bytes.buffer)
	let offset = 0
	view.setUint32(offset, tempos.length, true)
	offset += 4
	for (const tempo of tempos) {
		view.setBigInt64(offset, tempo.tick, true)
		view.setFloat64(offset + 8, tempo.beatsPerMinute, true)
		offset += 16
	}
	view.setUint32(offset, timeSignatures.length, true)
	offset += 4
	for (const signature of timeSignatures) {
		view.setBigInt64(offset, signature.tick, true)
		view.setUint32(offset + 8, signature.numerator, true)
		view.setUint32(offset + 12, signature.denominator, true)
		offset += 16
	}
	return base64url.stringify(blake3(bytes), { pad: false })
}
