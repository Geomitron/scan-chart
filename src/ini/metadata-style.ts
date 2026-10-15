import type { MetadataFinding } from '../issues'
import type { MetadataIssueType } from '../types'
import { defaultMetadata } from './metadata'

/** Title tag words that tell charts of one song apart, which go after the other title tags. */
const chartTagWords = /overchart|\b6[- ]?fret|open notes|\b2x (kick|bass pedal)|expert\+|pro drums|\b(full|band|drums?|guitar|bass|keys) (chart|only)\b/i
/** Title tag words that belong to the song whatever the chart, which go first. */
const songTagWords = /\b(ft\.|feat\.|featuring|remix(ed)?|full album|live|acoustic|cover|demo|instrumental|remaster(ed)?|version|edit|mix)\b/i
const featuring = /(^|\s)(ft\.|feat\.|featuring\s)/i

/** Whether an album value marks a single, or no album: "Single", "N/A", "None", "-", or a name ending in "Single" or "(Single)". */
export function marksSingle(album: string) {
	const value = album.trim()
	return /^(singles?|n\/?a|none|-|no album|non[- ]album (single|track))$/i.test(value) || /\bsingle\)?$/i.test(value)
}

/**
 * Guesses about the metadata's text against the charting guidelines' style: credits joined with "&", single spaces, where
 * featured artists and title tags go, one genre, a four-digit year, and how a single's album is written. Each is a guess,
 * so they're reported only when asked for. `metadata`'s text has its style tags removed.
 */
export function metadataStyleIssues(metadata: typeof defaultMetadata): MetadataFinding[] {
	const issues: MetadataFinding[] = []
	const add = (metadataIssue: MetadataIssueType, description: string) => issues.push({ metadataIssue, description })
	// A value that isn't the default, such as "Unknown Artist", is the chart's own.
	const isGiven = (key: 'name' | 'artist' | 'album' | 'genre' | 'year' | 'charter') => metadata[key] !== defaultMetadata[key]
	const { name, artist, album, genre, year, charter } = metadata

	if (isGiven('charter') && /\s*[,/+;]\s*|\s+and\s+/i.test(charter)) {
		add('creditSeparator', `The charter value "${charter}" lists several names. Join them with " & ".`)
	}

	for (const key of ['name', 'artist', 'album', 'genre', 'charter'] as const) {
		if (isGiven(key) && / {2}/.test(metadata[key])) add('textSpacing', `The ${key} value "${metadata[key]}" has two spaces in a row.`)
	}

	const outsideParentheses = name.replace(/\([^)]*\)|\[[^\]]*\]/g, '')
	if (isGiven('name') && featuring.test(outsideParentheses)) {
		add('featuringFormat', `The song name "${name}" names a featured artist outside a title tag. Write it as "Song (ft. Artist)".`)
	} else if (isGiven('artist') && featuring.test(artist)) {
		add('featuringFormat', `The artist value "${artist}" names a featured artist. Move it to a title tag on the song name, such as "Song (ft. Artist)".`)
	}

	const tags = name.match(/\([^)]*\)/g) ?? []
	const chartTag = tags.findIndex(tag => chartTagWords.test(tag))
	const songTag = tags.slice(chartTag + 1).find(tag => songTagWords.test(tag) && !chartTagWords.test(tag))
	if (chartTag !== -1 && songTag !== undefined) {
		add('titleTagOrder', `In the song name "${name}", "${tags[chartTag]}" tells charts apart, so it goes after "${songTag}".`)
	}
	// Brackets inside a word, such as "[re]connect", are part of the title.
	if (isGiven('name') && /\s\[[^\]]*\]/.test(name)) {
		add('bracketTitleTag', `The song name "${name}" has a title tag in brackets. Use parentheses, unless the brackets are part of the title.`)
	}

	if (isGiven('genre') && /[,;/]/.test(genre)) {
		add('multipleGenres', `The genre value "${genre}" lists more than one genre. List one, as specific as possible.`)
	}
	if (isGiven('year') && !/^\d{4}$/.test(year)) {
		add('yearFormat', `The year value "${year}" should be only the year, such as "2004".`)
	}
	// The song name with or without its title tags.
	const single = `${name.replace(/(\s*(\([^)]*\)|\[[^\]]*\]))+$/, '')} - (Single)`
	if (isGiven('album') && marksSingle(album) && album !== single && album !== `${name} - (Single)`) {
		add('singleAlbum', `The album value "${album}" marks a single. A single's album is its name followed by " - (Single)": "${single}".`)
	}
	return issues
}
