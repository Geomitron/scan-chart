/**
 * scan-chart/competitive: the hashes that decide whether scores were played on the same chart (TrackHashes, the
 * SongHash, durations, BTracks and Clone Hero's tempo map hash), and the specification API they're defined by.
 */
import { canonicalChartFromParse } from './chart/identity/canonical-source'
import { canonical20260801 } from './chart/identity/public'
import { calculateTempoMapHash } from './chart/identity/tempo-map-hash'
import { songContext } from './song-context'
import type { SongDocument } from './song-document'
import type { Difficulty, Instrument } from './types'

/** A song's competitive hashes, or the reason the canonical rules reject its chart. */
export type CompetitiveHashes =
	| {
		readonly accepted: true
		/** The canonical SongHash, as unpadded base64url. */
		readonly songHash: string
		/** The canonical song duration in milliseconds: the latest note end at speed 1.0 plus a quarter-note, rounded up. */
		readonly songDurationMs: number
		/** Clone Hero's tempo map hash, which the leaderboard backend compares across scores. */
		readonly tempoMapHash: string
		/** Every track's TrackHash, in SongHash order: by instrument, then Easy to Expert. */
		readonly tracks: readonly CompetitiveTrackHash[]
	}
	| { readonly accepted: false; readonly reason: string }

export interface CompetitiveTrackHash {
	readonly instrument: Instrument
	readonly difficulty: Difficulty
	/** The canonical TrackHash, as unpadded base64url. */
	readonly trackHash: string
	readonly durationMs: number
	/** The track's `CHNF/20260801` BTrack, which `trackHash` is derived from; `null` unless asked for. */
	readonly btrack: Uint8Array | null
}

/** Calculates a song's competitive hashes from its document, reusing the parse its gameplay chart is resolved from. */
export function calculateCompetitiveHashes(song: SongDocument, options: { readonly btracks?: boolean } = {}): CompetitiveHashes {
	const { chart, songHashMetadata } = songContext(song)
	if (chart.kind === 'none') return { accepted: false, reason: 'The song has no chart file.' }
	if (chart.kind === 'failed') return { accepted: false, reason: chart.error }
	const parsed = canonicalChartFromParse(chart.source.format, chart.parsed)
	if (parsed.kind === 'rejected') return { accepted: false, reason: parsed.errors.map(error => error.message).join(' ') }
	try {
		const bundle = canonical20260801.calculateSongBundle({ chart: parsed.chart, metadata: songHashMetadata })
		return {
			accepted: true,
			songHash: bundle.song.songHash.value,
			songDurationMs: Number(bundle.duration.durationMs),
			tempoMapHash: calculateTempoMapHash(parsed.chart.tempoMap),
			tracks: bundle.tracks.map(track => ({
				instrument: track.instrument,
				difficulty: track.difficulty,
				trackHash: track.identity.trackHash.value,
				durationMs: Number(track.duration.durationMs),
				btrack: options.btracks ? track.identity.physicalBTrack.bytes : null,
			})),
		}
	} catch (error) {
		return { accepted: false, reason: error instanceof Error ? error.message : String(error) }
	}
}

export {
	calculateCanonicalChartDuration,
	calculateCanonicalTrackDuration,
	canonicalChartDurationDefinition,
	trackDurationDefinition,
} from './chart/chart-duration'
export { canonical20260801, frozenLegacy6142, songBundle20251010 } from './chart/identity/public'
export type {
	Canonical20260801Api,
	CanonicalBundleTrackIdentity,
	CanonicalSongBundle,
	CanonicalSongBundleRequest,
	ChartSource,
	FrozenLegacy6142Api,
	SongBundle20251010Api,
	SongBundleIdentityOutcome,
	SongBundleIdentityRequest,
	SourceParseError,
	SourceParseRequest,
} from './chart/identity/public'
export type { CanonicalChartDuration, TrackDuration } from './chart/chart-duration'
export type { CanonicalChartDurationMs, TrackDurationMs } from './chart/identity/duration-types'
export type {
	CanonicalSongHash,
	CanonicalSongIdentity,
	CanonicalSongHashMember,
	CanonicalSongIdentityRequest,
	SongHashMetadata,
} from './chart/identity/song-hash-20251010'
export type {
	CanonicalBlake3Digest,
	CanonicalBTrackReadOutcome,
	CanonicalDrumFreestyle,
	CanonicalFlexLane,
	CanonicalNote,
	CanonicalPhysicalBTrack,
	CanonicalRangeShift,
	CanonicalTempo,
	CanonicalTickRange,
	CanonicalTimeSignature,
	CanonicalTrackHash,
	CanonicalTrackHashProjection,
	CanonicalTrackIdentity,
	CanonicalTrackSemantics,
	FiveFretRange,
} from './chart/identity/btrack-20260801'
export type {
	CanonicalParsedChart,
	CanonicalParsedTrack,
	CanonicalParseOutcome,
	CanonicalSourceNotice,
	CanonicalTrackKey,
	RangeShiftSourceLocation,
} from './chart/identity/canonical-source'
export type { CanonicalTempoMap } from './chart/identity/tempo-map-hash'
