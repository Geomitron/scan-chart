import { toLowerInvariant, trimDotnet } from '../shared/text'
import type { MetadataIssueType } from '../types'
import { defaultMetadata } from './metadata'
import type { IniTokens } from './parse-ini'
import { knownIniKeys } from './scan-ini'

type MetadataFinding = { metadataIssue: MetadataIssueType; description: string }
type SongSection = { readonly [key: string]: string }

/** The tags of GuitarGame_ChartFormats' song.ini standard, besides the ones scan-chart reads. */
const standardTags = [
	'name', 'artist', 'album', 'genre', 'year', 'rating', 'charter', 'frets', 'version', 'preview_start_time', 'preview_end_time', 'playlist',
	'sub_playlist', 'album_track', 'track', 'playlist_track', 'song_length', 'modchart', 'loading_phrase', 'diff_band', 'diff_guitar', 'diff_guitarghl',
	'diff_guitar_coop', 'diff_guitar_coop_ghl', 'diff_guitar_real', 'diff_guitar_real_22', 'diff_rhythm', 'diff_rhythm_ghl', 'diff_bass', 'diff_bassghl',
	'diff_bass_real', 'diff_bass_real_22', 'diff_drums', 'diff_drums_real', 'diff_drums_real_ps', 'diff_keys', 'diff_keys_real', 'diff_keys_real_ps',
	'diff_vocals', 'diff_vocals_harm', 'diff_dance', 'pro_drums', 'five_lane_drums', 'vocal_gender', 'real_guitar_tuning', 'real_guitar_22_tuning',
	'real_bass_tuning', 'real_bass_22_tuning', 'vocal_scroll_speed', 'tuning_offset_cents', 'lyrics', 'delay', 'sustain_cutoff_threshold',
	'hopo_frequency', 'eighthnote_hopo', 'multiplier_note', 'star_power_note', 'icon', 'background', 'video', 'video_loop', 'video_start_time',
	'video_end_time', 'cover',
]
/** The tags a reader documents: the standard's, scan-chart's, and `explicit_lyrics`, which Clone Hero reads and the charting guidelines describe. */
const knownTags = new Set([...standardTags, ...knownIniKeys, 'explicit_lyrics'])
/** The order the charting guidelines list tags in, which scan-chart writes them in. */
const tagOrder = Object.keys(defaultMetadata)

/**
 * The charting recommendations about how song.ini is written: its layout, its tags' order, blank and quoted values,
 * and tags no reader documents. `songSection` is the `[song]` section as read; `extraIniKeys` are tags a caller's game reads.
 */
export function songIniIssues(tokens: IniTokens, songSection: SongSection, extraIniKeys: readonly (string | RegExp)[]): MetadataFinding[] {
	const isExtra = (key: string) => extraIniKeys.some(extra => typeof extra === 'string' ? toLowerInvariant(extra) === key : extra.test(key))
	// A line starting with "//" is reported as a comment, though readers read one with "=" in it as a key.
	const keys = Object.keys(songSection).filter(key => !key.startsWith('//'))
	const known = keys.filter(key => knownTags.has(key) || isExtra(key))
	const unknown = keys.filter(key => !known.includes(key))
	const issues = layoutIssues(tokens)

	const ranked = known.filter(key => tagOrder.includes(key))
	for (let index = 1; index < ranked.length; index++) {
		const later = ranked.slice(0, index).find(key => tagOrder.indexOf(key) > tagOrder.indexOf(ranked[index]))
		if (later !== undefined) {
			issues.push({ metadataIssue: 'iniTagOrder', description: `In "song.ini", "${ranked[index]}" should come before "${later}".` })
			break
		}
	}

	const blank = known.filter(key => songSection[key] === '' || songSection[key] === '-1')
	if (blank.length > 0) {
		issues.push({ metadataIssue: 'blankIniValue', description: `In "song.ini", ${keyList(blank)} ${blank.length === 1 ? 'is' : 'are'} blank or -1. Remove ${blank.length === 1 ? 'that line' : 'those lines'} instead.` })
	}
	const quoted = known.filter(key => songSection[key].length >= 2 && songSection[key].startsWith('"') && songSection[key].endsWith('"'))
	if (quoted.length > 0) {
		issues.push({
			metadataIssue: 'quotedIniValue',
			description: `In "song.ini", ${keyList(quoted)} ${quoted.length === 1 ? 'is' : 'are'} in quotes. Games show the quotes, and don't read a number in quotes, so remove them.`,
		})
	}
	if (unknown.length > 0) {
		issues.push({
			metadataIssue: 'unknownIniTag',
			description: `"song.ini" has tags that aren't in the song.ini standard: ${keyList(unknown)}. Remove them, unless a game you chart for reads them.`,
		})
	}
	return issues
}

/** A line before `[song]`, a section other than `[song]`, and comments that don't start with ";": the first of each kind. */
function layoutIssues(tokens: IniTokens): MetadataFinding[] {
	if (tokens.text === null) return []
	// As parseIniTokens reads lines: without one leading byte order mark, and trimmed.
	const lines = tokens.text.replace(/^\uFEFF/, '').split(/\r?\n/g).map(trimDotnet)
	const found = new Map<string, string>()
	const report = (kind: string, description: string) => {
		if (!found.has(kind)) found.set(kind, description)
	}
	let seenSong = false
	lines.forEach((line, index) => {
		const at = `Line ${index + 1} of "song.ini"`
		if (line.startsWith('#')) report('#', `${at} is a comment that starts with "#". Start comments with ";".`)
		else if (line.startsWith('//')) report('//', `${at} is a comment that starts with "//", which some readers read as a tag. Start comments with ";".`)
		else if (line.startsWith('[') && line.endsWith(']')) {
			if (toLowerInvariant(line.slice(1, -1)) === 'song') seenSong = true
			else report(`[${line}`, `"song.ini" has a "${line}" section. Games read only "[song]": move its tags there, or remove it.`)
		} else if (line.length > 0 && !line.startsWith(';') && !seenSong) {
			report('before', `${at} comes before "[song]". Start the file with "[song]".`)
		}
	})
	return [...found.values()].map(description => ({ metadataIssue: 'iniLayout', description }))
}

/** Keys for a message: up to four, quoted, then how many more. */
export function keyList(keys: readonly string[]) {
	const named = keys.slice(0, keys.length > 4 ? 3 : 4).map(key => `"${key}"`)
	const rest = keys.length - named.length
	if (rest > 0) return `${named.join(', ')} and ${rest} more`
	return named.length === 1 ? named[0] : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`
}
