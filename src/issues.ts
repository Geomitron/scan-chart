import type { SpellingIssueType } from './spelling-issues'
import type { ChartIssueType, Difficulty, FolderIssueType, Instrument, MetadataIssueType } from './types'

/** Where an issue is: the song folder's files, the song's metadata, or its chart. */
export type IssueScope = 'folder' | 'metadata' | 'chart'
export type IssueCode = FolderIssueType | MetadataIssueType | ChartIssueType | SpellingIssueType

/** A problem found in a song folder. Every issue has this shape, whatever its scope. */
export interface Issue {
	readonly scope: IssueScope
	readonly code: IssueCode
	/** The instrument it's about, or `null` when it's about more than one. */
	readonly instrument: Instrument | null
	/** The difficulty it's about, or `null` when it's about more than one. */
	readonly difficulty: Difficulty | null
	/** Where in the chart, or `null` for an issue about a whole track, chart or file. */
	readonly tick: number | null
	readonly msTime: number | null
	readonly message: string
}

/** A folder issue as the folder and song.ini scans report it, in the one issue shape. */
export function folderIssue({ folderIssue, description }: { folderIssue: FolderIssueType; description: string }): Issue {
	return { scope: 'folder', code: folderIssue, instrument: null, difficulty: null, tick: null, msTime: null, message: description }
}

/** A metadata issue as the song.ini scan reports it, in the one issue shape. */
export function metadataIssue({ metadataIssue, description }: { metadataIssue: MetadataIssueType; description: string }): Issue {
	return { scope: 'metadata', code: metadataIssue, instrument: null, difficulty: null, tick: null, msTime: null, message: description }
}
