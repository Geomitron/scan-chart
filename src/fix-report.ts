import type { IssueCode } from './issues'

/** What `fixIssues` did. The hashes are the canonical ones, keyed as `canonical:guitar:expert` and `canonical:song`. */
export interface FixReport {
	/** Each fix made: the code of the issue it fixes, the file it changes, and what it does. */
	readonly fixed: readonly { readonly code: IssueCode; readonly file: string; readonly description: string }[]
	/** Each issue found that wasn't fixed, and why. */
	readonly skipped: readonly { readonly code: IssueCode; readonly file: string | null; readonly reason: string }[]
	/** Files renamed. Writing the song back to its folder, remove each `from` file. */
	readonly renamed: readonly { readonly from: string; readonly to: string }[]
	/** Each hash the fixes changed, with its value before and after, or `null` where the song had or has no such hash. */
	readonly hashes: readonly { readonly key: string; readonly before: string | null; readonly after: string | null }[]
}

/** A report as the fixes add to it. */
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
