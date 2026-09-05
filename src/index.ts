
/**
 * Main scan-chart API functions
 */
export { parseChartAndIni } from './chart/parse-chart-and-ini'
export { scanChart } from './scan-chart'
export { parseChartFile } from './chart/parse-chart-file'
export {
	calculateCanonicalChartDuration,
	calculateCanonicalTrackDuration,
	calculateParsedTrackDuration,
	canonicalChartDurationDefinition,
	trackDurationDefinition,
} from './chart/chart-duration'
export { canonicalChartDurationMs, historicalSongHashDurationMs, trackDurationMs } from './chart/identity/duration-types'
export { calculateTrackHash } from './chart/track-hasher'
export { canonical20260801, frozenLegacy6142, songBundle20251010 } from './chart/identity/public'
export { scanIni } from './ini/scan-ini'

/**
 * Result types, enums, and helper functions
 */
export type { ParsedChart, ParseChartAndIniResult } from './chart/parse-chart-and-ini'
export type { ParsedChartFile } from './chart/parse-chart-file'
export type {
	ChartSource,
	Canonical20260801Api,
	CanonicalBundleTrackIdentity,
	FrozenLegacy6142Api,
	FrozenLegacyParseOutcome,
	FrozenLegacyParsedChart,
	FrozenLegacyTrackIdentity,
	FrozenLegacySongBundleIdentity,
	LegacyBlake3Digest,
	LegacyPhysicalBTrack,
	LegacyTrackHash,
	LegacyTrackHashProjection,
	LegacyBundleTrackIdentity,
	SongBundle20251010Api,
	SongBundleIdentityOutcome,
	SongBundleIdentityRequest,
	SourceParseError,
	SourceParseRequest,
} from './chart/identity/public'
export type { CanonicalChartDuration, TrackDuration } from './chart/chart-duration'
export type {
	CanonicalChartDurationMs,
	HistoricalSongHashDurationMs,
	TrackDurationMs,
} from './chart/identity/duration-types'
export type {
	CanonicalSongHash,
	CanonicalSongIdentity,
	CanonicalSongHashMember,
	LegacySongHash,
	LegacySongIdentity,
	LegacySongHashMember,
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
export type {
	IniChartModifiers,
	LyricEvent,
	NoteEvent,
	NoteType,
	VocalNote,
	VocalPhrase,
	VocalPart,
	VocalTrack,
} from './chart/types'
export { noteTypes, noteFlags, lyricFlags } from './chart/types'
export { defaultMetadata } from './ini/metadata'

export type {
	File,
	ScanChartConfig,
	ScannedChart,
	AlbumArt,
	NotesData,
	Instrument,
	InstrumentType,
	DrumType,
	Difficulty,
	ChartIssueType,
	FolderIssueType,
	MetadataIssueType,
} from './types'
export { instruments, instrumentTypes, getInstrumentType, drumTypes, difficulties } from './types'
