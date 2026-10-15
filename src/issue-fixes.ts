import type { FixReport } from './fix-issues'
import { keyList } from './ini/ini-checks'
import type { IssueCode } from './issues'
import type { SongDocument } from './song-document'

/**
 * What a fix does to the canonical hashes. `keepsHashes`: it keeps them, and is made by default. `mayChangeHashes`: it's
 * made by default where it keeps them, and otherwise only with `changeHashes`. `changesHashes`: it's made only with
 * `changeHashes`.
 */
export type FixHashes = 'keepsHashes' | 'mayChangeHashes' | 'changesHashes'

/** A song.ini fix as its description names it: the tag or line it's about, and the value it wrote. */
export interface IniFixSubject {
	readonly subject: string
	readonly value?: string
}

/** How `fixIssues` fixes one code. */
interface IssueFix {
	readonly hashes: FixHashes
	/** The steps that fix it: the chart's, song.ini's or the files'. */
	readonly steps: readonly ('chart' | 'songIni' | 'files')[]
	/** Whether only a scan that reads the media files finds its issue. */
	readonly media?: true
	/** What a song.ini step's fixes of the code did. */
	readonly describe?: (fixes: readonly IniFixSubject[]) => string
	/** The phrases a phrase fix removes, and their name. */
	readonly phrases?: { readonly field: 'starPowerSections' | 'soloSections' | 'flexLanes'; readonly name: string }
}

const removed = (why: string, whyOne = why) => (fixes: readonly IniFixSubject[]) =>
	`Removed ${keyList(fixes.map(fix => fix.subject))}, which ${fixes.length === 1 ? whyOne : why}.`

/** Each code `fixIssues` fixes. */
export const issueFixTable: { readonly [code in IssueCode]?: IssueFix } = {
	fileNameCase: { hashes: 'keepsHashes', steps: ['files'] },
	extensionMismatch: { hashes: 'keepsHashes', steps: ['files'], media: true },
	albumArtSize: { hashes: 'keepsHashes', steps: ['files'], media: true },
	iniLayout: { hashes: 'keepsHashes', steps: ['songIni'], describe: () => 'Wrote "[song]" first, comments with ";", and the lines games don\'t read as comments.' },
	iniTagOrder: { hashes: 'keepsHashes', steps: ['songIni'], describe: () => 'Put the tags in the standard order.' },
	blankIniValue: { hashes: 'keepsHashes', steps: ['songIni'], describe: removed('were blank or -1', 'was blank or -1') },
	blankIniNumber: { hashes: 'keepsHashes', steps: ['songIni'], describe: removed('were blank', 'was blank') },
	quotedIniValue: { hashes: 'mayChangeHashes', steps: ['songIni'], describe: fixes => `Removed the quotes around ${keyList(fixes.map(fix => fix.subject))}.` },
	defaultIniValue: { hashes: 'keepsHashes', steps: ['songIni'], describe: removed('changed nothing') },
	iconName: { hashes: 'mayChangeHashes', steps: ['songIni'], describe: ([fix]) => `Changed "icon" to "${fix.value}".` },
	deprecatedIniTag: {
		hashes: 'keepsHashes',
		steps: ['chart', 'songIni'],
		describe: fixes => `Renamed ${fixes.map(fix => `"${fix.subject}" to "${fix.value}"`).join(' and ')}.`,
	},
	redundantDrumType: { hashes: 'keepsHashes', steps: ['songIni'], describe: removed('games read the drums the same without') },
	missingSongLength: { hashes: 'keepsHashes', steps: ['songIni'], describe: ([fix]) => `Set "song_length" to ${fix.value}, the length of the longest audio file in milliseconds.` },
	songLengthMismatch: {
		hashes: 'keepsHashes',
		steps: ['songIni'],
		media: true,
		describe: ([fix]) => `Set "song_length" to ${fix.value}, the length of the longest audio file in milliseconds.`,
	},
	emptyTrack: { hashes: 'keepsHashes', steps: ['chart'] },
	emptyStarPower: { hashes: 'keepsHashes', steps: ['chart'], phrases: { field: 'starPowerSections', name: 'star power' } },
	emptySoloSection: { hashes: 'keepsHashes', steps: ['chart'], phrases: { field: 'soloSections', name: 'solo' } },
	emptyFlexLane: { hashes: 'keepsHashes', steps: ['chart'], phrases: { field: 'flexLanes', name: 'flex lane' } },
	badSustainGap: { hashes: 'changesHashes', steps: ['chart'] },
	babySustain: { hashes: 'changesHashes', steps: ['chart'] },
}

/** For each issue code `fixIssues` fixes, what its fix does to the canonical hashes. Each is proven by hashing. */
export const issueFixes: { readonly [code in IssueCode]?: FixHashes } = Object.fromEntries(
	Object.entries(issueFixTable).map(([code, fix]) => [code, fix.hashes]),
)

/** The report as the fixes add to it. */
export interface FixRecord {
	readonly fixed: FixReport['fixed'][number][]
	readonly renamed: { from: string; to: string }[]
	skip(code: IssueCode, file: string | null, reason: string): void
}

/** The hashes that differ between two songs' `songHashes`. */
export function hashChanges(before: ReadonlyMap<string, string> | null, after: ReadonlyMap<string, string> | null): FixReport['hashes'] {
	const keys = [...new Set([...before?.keys() ?? [], ...after?.keys() ?? []])].sort()
	return keys.flatMap(key => {
		const [was, is] = [before?.get(key) ?? null, after?.get(key) ?? null]
		return was === is ? [] : [{ key, before: was, after: is }]
	})
}

/** Hashes in a message: "the SongHash", "a TrackHash", "the SongHash and 2 TrackHashes". */
export function hashNames(changes: FixReport['hashes']): string {
	const tracks = changes.filter(change => change.key !== 'canonical:song').length
	const names = [...changes.some(change => change.key === 'canonical:song') ? ['the SongHash'] : [], ...tracks === 0 ? [] : [tracks === 1 ? 'a TrackHash' : `${tracks} TrackHashes`]]
	return names.join(' and ')
}

/**
 * Makes the edits `problem` accepts: all of them, or each that passes alone, if those pass together. `problem` ends a
 * sentence about an edit, such as "would change the drum type", and each edit left out is skipped with it.
 */
export function chooseEdits<T>(
	song: SongDocument,
	edits: readonly T[],
	apply: (chosen: readonly T[]) => SongDocument,
	problem: (edited: SongDocument, chosen: readonly T[]) => string | null,
	skip: (edit: T, problem: string) => void,
): { song: SongDocument; chosen: readonly T[] } {
	const check = (chosen: readonly T[]) => {
		try {
			const edited = apply(chosen)
			return { edited, reason: problem(edited, chosen) }
		} catch (error) {
			return { edited: song, reason: `fails: ${error instanceof Error ? error.message : String(error)}` }
		}
	}
	if (edits.length === 0) return { song, chosen: [] }
	const all = check(edits)
	if (all.reason === null) return { song: all.edited, chosen: edits }
	if (edits.length === 1) {
		skip(edits[0], all.reason)
		return { song, chosen: [] }
	}
	const chosen = edits.filter(edit => {
		const { reason } = check([edit])
		if (reason !== null) skip(edit, reason)
		return reason === null
	})
	if (chosen.length === 0) return { song, chosen }
	const together = check(chosen)
	if (together.reason === null) return { song: together.edited, chosen }
	for (const edit of chosen) skip(edit, `${together.reason}, with the other fixes`)
	return { song, chosen: [] }
}
