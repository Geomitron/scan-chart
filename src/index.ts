
/**
 * Main scan-chart API functions
 */
export { parseChartAndIni } from './chart/parse-chart-and-ini'
export { scanChart } from './scan-chart'
export { parseChartFile } from './chart/parse-chart-file'
export { calculateTrackHash } from './chart/track-hasher'
export { canonical20260801, frozenLegacy6142 } from './chart/identity/public'
export { scanIni } from './ini/scan-ini'

/**
 * Result types, enums, and helper functions
 */
export type { ParsedChart, ParseChartAndIniResult } from './chart/parse-chart-and-ini'
export type { ParsedChartFile } from './chart/parse-chart-file'
export type {
	ChartSource,
	Canonical20260801Api,
	FrozenLegacy6142Api,
	FrozenLegacyParseOutcome,
	FrozenLegacyParsedChart,
	FrozenLegacyTrackIdentity,
	LegacyBlake3Digest,
	LegacyPhysicalBTrack,
	LegacyTrackHash,
	LegacyTrackHashProjection,
	SourceParseError,
	SourceParseRequest,
} from './chart/identity/public'
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
