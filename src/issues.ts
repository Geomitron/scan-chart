import type { SpellingIssueType } from './spelling-issues'
import type { ChartIssueType, Difficulty, FolderIssueType, Instrument, MetadataIssueType } from './types'

/** Where an issue is: the song folder's files, the song's metadata, or its chart. */
export type IssueScope = 'folder' | 'metadata' | 'chart'
export type IssueCode = FolderIssueType | MetadataIssueType | ChartIssueType | SpellingIssueType

/**
 * How much an issue matters:
 * - `error`: a game can't read the file, or games read it differently;
 * - `warning`: games read it alike, but it's probably a mistake;
 * - `recommendation`: it works, but doesn't follow a charting recommendation, such as the Chorus Encore guidelines'.
 */
export type IssueSeverity = 'error' | 'warning' | 'recommendation'

/** Each code's severity. A check with two thresholds reports the lower one as a warning and the higher as a recommendation. */
export const issueSeverities: { readonly [code in IssueCode]: IssueSeverity } = {
	// Folder issues
	noMetadata: 'error',
	invalidIni: 'warning',
	invalidMetadata: 'error',
	badIniLine: 'warning',
	multipleIniFiles: 'warning',
	noAlbumArt: 'recommendation',
	albumArtSize: 'recommendation',
	badAlbumArt: 'warning',
	multipleAlbumArt: 'warning',
	noAudio: 'error',
	invalidAudio: 'warning',
	multipleAudio: 'error',
	noChart: 'error',
	invalidChart: 'error',
	badChart: 'error',
	badChartIdentity: 'error',
	multipleChart: 'warning',
	badVideo: 'warning',
	multipleVideo: 'warning',
	// Metadata issues
	missingValue: 'warning',
	invalidValue: 'warning',
	extraValue: 'warning',
	// Chart issues
	misalignedTimeSignature: 'warning',
	noNotes: 'error',
	noExpert: 'warning',
	difficultyNotReduced: 'warning',
	isDefaultBPM: 'warning',
	noSections: 'warning',
	badEndEvent: 'warning',
	smallLeadingSilence: 'warning',
	noStarPower: 'warning',
	emptyStarPower: 'warning',
	badStarPower: 'error',
	emptySoloSection: 'warning',
	noDrumActivationLanes: 'warning',
	emptyFlexLane: 'warning',
	difficultyForbiddenNote: 'warning',
	invalidChord: 'warning',
	brokenNote: 'warning',
	badSustainGap: 'warning',
	babySustain: 'warning',
	invalidLyric: 'error',
	invalidPhraseStart: 'error',
	invalidPhraseEnd: 'error',
	// Spelling issues: other programs read these differently, unless they're style notes.
	unsortedChartLines: 'error',
	quotedChartTrackEvent: 'error',
	multipleMidiTrackNames: 'error',
	overlappingMidiNotes: 'error',
	duplicateIniKey: 'error',
	duplicateChartLine: 'recommendation',
	nonstandardChartLine: 'error',
	unreadableChartLine: 'error',
	nonstandardChartSections: 'error',
}

/** A problem found in a song folder. Every issue has this shape, whatever its scope. */
export interface Issue {
	readonly scope: IssueScope
	readonly code: IssueCode
	readonly severity: IssueSeverity
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
	return { scope: 'folder', code: folderIssue, severity: issueSeverities[folderIssue], instrument: null, difficulty: null, tick: null, msTime: null, message: description }
}

/** A metadata issue as the song.ini scan reports it, in the one issue shape. */
export function metadataIssue({ metadataIssue, description }: { metadataIssue: MetadataIssueType; description: string }): Issue {
	return { scope: 'metadata', code: metadataIssue, severity: issueSeverities[metadataIssue], instrument: null, difficulty: null, tick: null, msTime: null, message: description }
}
