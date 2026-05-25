export { scanChart, scanChartFolder } from './scan-chart'
export { parseChartAndIni } from './chart/parse-chart-and-ini'
export { parseChartFile } from './chart/parse-chart-file'
export { calculateTrackHash } from './chart/track-hasher'
export { scanIni } from './ini/scan-ini'

export type {
	File,
	ScanChartFolderConfig,
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

export type { ParsedChart, ParseChartAndIniResult } from './chart/parse-chart-and-ini'
export type { ParsedChartFile } from './chart/parse-chart-file'
export type {
	IniChartModifiers,
	NoteEvent,
	NoteType,
	NormalizedLyricEvent,
	NormalizedVocalNote,
	NormalizedVocalPhrase,
	NormalizedVocalPart,
	NormalizedVocalTrack,
} from './chart/types'
export { defaultIniChartModifiers, noteTypes, noteFlags, noteTypeCount, lyricFlags } from './chart/types'
