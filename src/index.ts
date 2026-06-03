
/**
 * Main scan-chart API functions
 */
export { parseChartAndIni } from './chart/parse-chart-and-ini'
export { scanChart } from './scan-chart'
export { parseChartFile } from './chart/parse-chart-file'
export { calculateTrackHash } from './chart/track-hasher'
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
