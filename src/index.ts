/**
 * scan-chart 9.0.0: reads a song folder as Clone Hero does, analyzes it, edits it and saves it. The competitive hashes
 * are in `scan-chart/competitive`.
 */
import { editSong as editSongWithRawAdditions, type SongDocument, type SongEditBatch } from './song-document'

/** Inputs: a song folder's files, as bytes or byte sources. */
export { byteSourceFromBlob } from './song-files'
export type { ByteSource, SongFile } from './song-files'

/** Reading a song folder. */
export { parseSong } from './song-document'
export type { ChartDocument, IniDocument, SongDocument } from './song-document'
export { parseSongMetadata, songMetadata } from './song-metadata'
export type { SongMetadata } from './song-metadata'

/** The chart as Clone Hero plays it, its issues and its statistics. */
export { ChartReadError, defaultChartParseSettings, resolveChart } from './gameplay-chart'
export type {
	ChartFormat,
	ChartParseSettings,
	DrumFill,
	FlexLane,
	GameplayChart,
	Note,
	Phrase,
	Section,
	Tempo,
	TextEvent,
	TimeSignature,
	Track,
} from './gameplay-chart'
export { analyzeChart } from './analyze-chart'
export type { ChartStats } from './analyze-chart'
export type { Issue, IssueCode, IssueScope } from './issues'
export type { SpellingIssueType } from './spelling-issues'
export type { ChartIssueType, FolderIssueType, MetadataIssueType } from './types'

/** Everything in one call. */
export { scanSongFolder } from './scan-song-folder'
export type { AlbumArt, FileHashes, ScannedSong, ScanOptions } from './scan-song-folder'

/** Editing: the chart as written, one batch of edits at a time. */
export { authoredSongEvents, authoredTracks, chartCapabilities } from './authored'
export type { AuthoredEvent, AuthoredEventType, AuthoredTrack, ChartCapabilities } from './authored'
export type {
	AuthoredSongEvents,
	AuthoredSource,
	AuthoredTempo,
	AuthoredTextEvent,
	AuthoredTimeSignature,
	FormatSupport,
} from './chart/authored-view'
export type { AuthoredElement, SongEditBatch, SongMetadataKey } from './song-document'

/**
 * Applies a batch of edits to a song's chart and song.ini and returns the edited song, leaving `song` unchanged: the
 * earlier document is the undo step. Every byte the edits don't touch is kept, and an empty batch returns `song`.
 *
 * Throws if an edit doesn't fit the chart's format, such as a length on a `.chart` text event.
 */
export const editSong: (song: SongDocument, edit: (batch: SongEditBatch) => void) => SongDocument = editSongWithRawAdditions

/** Saving and creating songs. */
export { savePlanToBlobs, serializeSong, writeSavePlanFile } from './save-plan'
export type { ByteRange, PlannedFile, SavePlan } from './save-plan'
export type { SaveReport } from './song-save'
export { createSong } from './create-song'

/** Names and constants shared by every part of the API. */
export { difficulties, drumTypes, getInstrumentType, instruments, instrumentTypes } from './types'
export type { Difficulty, DrumType, Instrument, InstrumentType } from './types'
export { lyricFlags, noteFlags, noteTypes } from './chart/types'
export type { LyricEvent, NoteType, VocalNote, VocalPart, VocalPhrase, VocalTrack } from './chart/types'
export { defaultMetadata } from './ini/metadata'
