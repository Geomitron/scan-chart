import { chartStats } from './chart/chart-analysis'
import { rewriteHopoTags, rewriteMultiplierNote } from './fix-chart'
import { ignoredIssueCodes } from './ini/ini-checks'
import { asUtf8Ini, rewriteSongIni, SongIniRewrite } from './ini/ini-edit'
import { newerTag, olderTags } from './ini/metadata'
import { IniTokens, parseIniTokens } from './ini/parse-ini'
import type { MetadataFinding } from './issues'
import { songIniFindings } from './scan-song-folder'
import { songContext } from './song-context'
import type { SongDocument } from './song-document'

/**
 * A kind of rewrite that leaves a song without a deprecated song.ini tag, which only older charts need:
 * - `hopoTags`: the notes whose strum or HOPO `hopo_frequency` or `eighthnote_hopo` changes are forced, and the tags
 *   removed.
 * - `multiplierNote`: a `.mid` file's star power moves from note 103 to note 116, and `multiplier_note = 103` is
 *   removed.
 * - `deprecatedTags`: an older name, such as `frets`, is renamed, and a deprecated tag that changes nothing, such as
 *   `delay = 0`, is removed.
 */
export type DeprecatedTagNormalizationKind = 'hopoTags' | 'multiplierNote' | 'deprecatedTags'

/** One rewrite of a song that leaves a deprecated song.ini tag. */
export interface DeprecatedTagNormalization {
	readonly kind: DeprecatedTagNormalizationKind
	/** Rewrites the song as it is now. Returns `song` unchanged when there's nothing left to rewrite. */
	readonly apply: (song: SongDocument) => SongDocument
}

/** The deprecated song.ini tags: the settings only older charts need, and the older names of tags. */
const deprecatedTags: ReadonlySet<string> = new Set(['delay', 'hopo_frequency', 'eighthnote_hopo', 'multiplier_note', ...olderTags.values()])

/** The tags that set the HOPO threshold. */
const hopoTags = ['hopo_frequency', 'eighthnote_hopo']

/**
 * Every rewrite a song needs to leave the deprecated song.ini tags it can (`docs/ini/settings.mdx`), as `fixIssues`
 * fixes their `deprecatedIniTag` and `defaultIniValue` issues. A chart rewrite is listed only where the song plays the
 * same with it, phrases and every canonical hash included. `delay` with a value stays: removing it moves every note
 * against the audio. So does `multiplier_note = 116` where a `.mid` chart's solos would otherwise read as star power,
 * and so do the HOPO tags beside `hopofreq`, which YARG reads without them. Only a UTF-8 song.ini is rewritten, so its
 * other bytes stay as written, and a song.ini that lists `deprecatedIniTag` or `defaultIniValue` in `ignored_issues`
 * keeps those tags.
 */
export function deprecatedTagNormalizations(song: SongDocument): DeprecatedTagNormalization[] {
	const { ini } = song
	if (ini === null || ini.fileName.toLowerCase() !== 'song.ini' || !isUtf8(ini.tokens)) return []
	const written = parseIniTokens(ini.tokens).iniObject.song ?? {}
	const setsHopofreq = written.hopofreq !== undefined
	const kept = new Set(setsHopofreq ? hopoTags : [])
	if (!Object.keys(written).some(key => deprecatedTags.has(key) && !kept.has(key))) return []

	const found = songIniFindingsOf(song)
	const normalizations: DeprecatedTagNormalization[] = []
	const add = (kind: DeprecatedTagNormalizationKind, rewrite: (current: SongDocument, found: readonly MetadataFinding[]) => SongDocument | null) => {
		const rewritten = rewrite(song, found)
		if (rewritten === null) return
		normalizations.push({ kind, apply: current => (current === song ? rewritten : rewrite(current, songIniFindingsOf(current))) ?? current })
	}
	add('hopoTags', (current, found) => {
		if (setsHopofreq || !isReported(found, hopoTags)) return null
		const rewritten = rewriteHopoTags(current)
		return 'song' in rewritten ? rewritten.song : null
	})
	add('multiplierNote', (current, found) => {
		if (!isReported(found, ['multiplier_note'])) return null
		const rewritten = rewriteMultiplierNote(current)
		return 'song' in rewritten ? rewritten.song : null
	})
	// Renaming a tag, or removing one that changes nothing, reads the song as before, so the rewrite found for the song
	// applies to it as the other normalizations leave it.
	const rewrite = tagRewrite(song, found, kept)
	if (rewrite !== null) {
		normalizations.push({
			kind: 'deprecatedTags',
			apply: current => current.ini === null ? current : { ...current, ini: { ...current.ini, tokens: rewriteSongIni(current.ini.tokens, rewrite) } },
		})
	}
	return normalizations
}

/**
 * A song's song.ini findings, style notes included, which name the tags that change nothing. A code song.ini's
 * `ignored_issues` lists has none, so its tags stay, as `fixIssues` leaves them.
 */
function songIniFindingsOf(song: SongDocument): MetadataFinding[] {
	const context = songContext(song)
	const stats = context.chart.kind === 'parsed' ? chartStats(context.chart.parsed, context.settings, context.chart.source.format) : null
	const ignored = context.ini.songSection === null ? null : ignoredIssueCodes(context.ini.songSection).codes
	return songIniFindings(song, context, stats, { styleNotes: true }).filter(finding => !ignored?.has(finding.metadataIssue))
}

/** Whether song.ini sets one of `keys` in a way that changes how the chart reads (`deprecatedIniTag`). */
const isReported = (found: readonly MetadataFinding[], keys: readonly string[]) =>
	found.some(finding => finding.metadataIssue === 'deprecatedIniTag' && finding.keys?.some(key => keys.includes(key)))

/**
 * The song.ini rewrite that renames each older name of a tag and removes each deprecated tag that changes nothing,
 * other than the tags `kept`.
 */
function tagRewrite(song: SongDocument, found: readonly MetadataFinding[], kept: ReadonlySet<string>): SongIniRewrite | null {
	const songSection = songContext(song).ini.songSection ?? {}
	const remove = new Set<string>()
	const set = new Map<string, string>()
	for (const finding of found) {
		for (const key of finding.keys ?? []) {
			const newer = newerTag(key)
			if (finding.metadataIssue === 'deprecatedIniTag' && newer !== undefined) {
				set.set(newer, songSection[key])
				remove.add(key)
			} else if (finding.metadataIssue === 'defaultIniValue' && deprecatedTags.has(key) && !kept.has(key)) {
				remove.add(key)
			}
		}
	}
	return remove.size === 0 ? null : { layout: false, order: false, remove, set }
}

/** Whether a song.ini is UTF-8, so a rewrite keeps every byte it doesn't change. */
function isUtf8(tokens: IniTokens): boolean {
	try {
		return asUtf8Ini(tokens) === tokens
	} catch {
		return false
	}
}
