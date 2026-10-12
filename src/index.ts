
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
export { canonicalChartDurationMs, trackDurationMs } from './chart/identity/duration-types'
export { canonical20260801 } from './chart/identity/public'
export { scanIni } from './ini/scan-ini'

/**
 * Chart authoring / serialization API (createEmptyChart + writers).
 */
export { createEmptyChart } from './chart/create-chart'
export { writeChartFile } from './chart/chart-writer'
export { writeMidiFile } from './chart/midi-writer'
export { writeChartFolder } from './chart/chart-document'
export { writeIniFile } from './ini/ini-writer'
export type { ChartDocument } from './chart/chart-document'
export type { IniMetadata } from './ini/ini-writer'

/**
 * Result types, enums, and helper functions
 */
export type { ParsedChart, ParseChartAndIniResult } from './chart/parse-chart-and-ini'
export type { ParsedChartFile } from './chart/parse-chart-file'
export type {
	ChartSource,
	Canonical20260801Api,
	CanonicalBundleTrackIdentity,
	CanonicalSongBundle,
	CanonicalSongBundleRequest,
	SourceParseError,
	SourceParseRequest,
} from './chart/identity/public'
export type { CanonicalChartDuration, ParsedTrackDurationRequest, TrackDuration } from './chart/chart-duration'
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
export type {
	IniChartModifiers,
	LyricEvent,
	NoteEvent,
	NoteType,
	VocalNote,
	VocalPhrase,
	VocalPart,
	VocalTrack,
	NormalizedLyricEvent,
	NormalizedVocalNote,
	NormalizedVocalPhrase,
	NormalizedVocalPart,
	NormalizedVocalTrack,
} from './chart/types'
export { noteTypes, noteFlags, lyricFlags, defaultIniChartModifiers } from './chart/types'
export type { RawChartData, EventType, VocalTrackData } from './chart/raw-types'
export { eventTypes } from './chart/raw-types'
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
