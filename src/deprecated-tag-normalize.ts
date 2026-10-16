import { chartStats } from './chart/chart-analysis'
import { reportsDeprecatedTag, rewriteHopoTags, rewriteMultiplierNote } from './fix-chart'
import { IniFix, iniFixRewrite, removalFix, renameFix } from './fix-issues'
import { deprecatedTags, hopoTags, ignoredIssueCodes } from './ini/ini-checks'
import { asUtf8Ini, rewriteSongIni } from './ini/ini-edit'
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
	if (!Object.keys(written).some(key => deprecatedTags.has(key))) return []

	const found = songIniFindingsOf(song)
	const normalizations: DeprecatedTagNormalization[] = []
	const add = (kind: DeprecatedTagNormalizationKind, rewrite: (current: SongDocument, found: readonly MetadataFinding[]) => SongDocument | null) => {
		const rewritten = rewrite(song, found)
		if (rewritten === null) return
		normalizations.push({ kind, apply: current => (current === song ? rewritten : rewrite(current, songIniFindingsOf(current))) ?? current })
	}
	add('hopoTags', (current, found) => {
		if (!reportsDeprecatedTag(found, hopoTags)) return null
		const rewritten = rewriteHopoTags(current)
		return 'song' in rewritten ? rewritten.song : null
	})
	add('multiplierNote', (current, found) => {
		if (!reportsDeprecatedTag(found, ['multiplier_note'])) return null
		const rewritten = rewriteMultiplierNote(current)
		return 'song' in rewritten ? rewritten.song : null
	})
	// Renaming a tag, or removing one that changes nothing, reads the song as before, so the tags found for the song are
	// rewritten as song.ini sets them once the other normalizations have run: a chart rewrite may have removed one.
	const tags = renamedOrRemoved(found)
	if (tagFixes(tags, written).length > 0) {
		normalizations.push({
			kind: 'deprecatedTags',
			apply: current => {
				if (current.ini === null) return current
				const fixes = tagFixes(tags, parseIniTokens(current.ini.tokens).iniObject.song ?? {})
				return fixes.length === 0 ? current : { ...current, ini: { ...current.ini, tokens: rewriteSongIni(current.ini.tokens, iniFixRewrite(fixes)) } }
			},
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

/** A tag saving rewrites song.ini for, and the code of its finding. */
interface TagFinding {
	readonly code: 'deprecatedIniTag' | 'defaultIniValue'
	readonly key: string
}

/** The tags of `found` saving rewrites: each `deprecatedIniTag` names, and each deprecated tag `defaultIniValue` names. */
function renamedOrRemoved(found: readonly MetadataFinding[]): TagFinding[] {
	return found.flatMap(({ metadataIssue: code, keys = [] }) => code === 'deprecatedIniTag' || code === 'defaultIniValue'
		? keys.filter(key => code === 'deprecatedIniTag' || deprecatedTags.has(key)).map(key => ({ code, key }))
		: [])
}

/**
 * The song.ini fixes of `tags` as `songSection` sets them, as `fixIssues` makes them: each older name renamed, and each
 * tag that changes nothing removed.
 */
function tagFixes(tags: readonly TagFinding[], songSection: { readonly [key: string]: string }): IniFix[] {
	return tags.flatMap(({ code, key }) => code === 'deprecatedIniTag' ? renameFix(key, songSection) ?? [] : [removalFix(code, key, songSection)])
}

/** Whether a song.ini is UTF-8, so a rewrite keeps every byte it doesn't change. */
function isUtf8(tokens: IniTokens): boolean {
	try {
		return asUtf8Ini(tokens) === tokens
	} catch {
		return false
	}
}
