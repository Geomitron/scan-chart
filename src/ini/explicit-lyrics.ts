import { type LyricEvent, lyricFlags, type VocalTrack } from '../chart/types'
import { toLowerInvariant } from '../shared/text'

/**
 * The strong words, written for scan-chart and released under its MIT license, not taken from another list. They're
 * the strong profanities and slurs that make a song's lyrics explicit by common rating practice, as a parental
 * advisory label or a radio edit treats them, with their inflections written out. English only. Mild words, such as
 * "hell", "damn", "crap", "ass" and "bitch", and words with a common innocent sense, such as "cock" and "pussy", aren't
 * listed, so a lyric with only those isn't reported. An entry of several words matches those words in a row.
 */
const strongWords: ReadonlySet<string> = new Set([
	'fuck', 'fucks', 'fucked', 'fucker', 'fuckers', 'fucking', 'fuckhead', 'fuckface', 'clusterfuck',
	'motherfucker', 'motherfuckers', 'motherfucking', 'mothafucka', 'mothafuckas', 'muthafucka', 'muthafuckas',
	'shit', 'shits', 'shitty', 'shitting', 'shithead', 'shitheads', 'shitless', 'bullshit', 'horseshit', 'dipshit',
	'cunt', 'cunts', 'cocksucker', 'cocksuckers',
	'nigger', 'niggers', 'nigga', 'niggas', 'niggaz', 'faggot', 'faggots', 'kike', 'kikes', 'spic', 'spics', 'wetback', 'wetbacks',
	'gook', 'gooks', 'porch monkey', 'porch monkeys',
])

/** A lyric phrase that holds a strong word. */
export interface ExplicitLyricMatch {
	/** The vocal part, such as `vocals` or `harmony1`. */
	readonly part: string
	/** When the phrase starts, in milliseconds. */
	readonly msTime: number
	/** The phrase's text, rebuilt from its syllables. */
	readonly text: string
	/** The strong words it holds, as listed, in the order they come. */
	readonly words: readonly string[]
}

/** Every phrase of every vocal part that holds a strong word, by start time. */
export function explicitLyricMatches(vocals: VocalTrack): ExplicitLyricMatch[] {
	const matches: ExplicitLyricMatch[] = []
	for (const [part, { notePhrases }] of Object.entries(vocals.parts)) {
		for (const phrase of notePhrases) {
			const text = phraseText(phrase.lyrics)
			const words = strongWordsIn(lyricWords(text))
			if (words.length > 0) matches.push({ part, msTime: phrase.msTime, text, words })
		}
	}
	return matches.sort((a, b) => a.msTime - b.msTime)
}

/**
 * A phrase's text, rebuilt from its syllables as games show it: each syllable without its style tags and lyric symbols,
 * joined to the one before it by its "-" or "=" or its own leading "+", and otherwise after a space.
 */
export function phraseText(lyrics: readonly LyricEvent[]): string {
	let text = ''
	let joinNext = false
	for (const lyric of lyrics) {
		if (text !== '' && !joinNext && !lyric.text.startsWith('+')) text += ' '
		text += syllableText(lyric.text)
		joinNext = (lyric.flags & (lyricFlags.joinWithNext | lyricFlags.hyphenateWithNext)) !== 0
	}
	return text
}

/**
 * A syllable as shown: without style tags, the symbols at its end, which a "=" among them shows as a hyphen, and the
 * symbols `+ # ^ * % / $ "` anywhere else. "_" and "§" show as spaces.
 */
function syllableText(text: string): string {
	const untagged = text.replace(/<[^>]*>/g, '')
	const end = /[-=+#^*%/$]*$/.exec(untagged)![0]
	const shown = untagged.slice(0, untagged.length - end.length).replace(/[+#^*%/$"]/g, '') + end.replace(/[^=]/g, '')
	return shown.replace(/=/g, '-').replace(/[_§]/g, ' ')
}

/** The words of a phrase's text, in lowercase: runs of letters, marks, digits and apostrophes, without apostrophes at either end. */
export function lyricWords(text: string): string[] {
	return toLowerInvariant(text.normalize('NFKC')).replace(/[‘’´`]/g, '\'').split(/[^\p{L}\p{M}\p{N}']+/u)
		.map(word => word.replace(/^'+|'+$/g, ''))
		.filter(word => word !== '')
}

/**
 * The strong words among `words`, as listed, each once. A word matches whole, or without a final "'s", or with a "g"
 * after a final "in", for "fuckin'"; an entry of two or three words matches them in a row.
 */
export function strongWordsIn(words: readonly string[]): string[] {
	const found: string[] = []
	const match = (candidate: string) => {
		const forms = [candidate, ...candidate.endsWith('\'s') ? [candidate.slice(0, -2)] : [], ...candidate.endsWith('in') ? [`${candidate}g`] : []]
		const form = forms.find(form => strongWords.has(form))
		if (form !== undefined && !found.includes(form)) found.push(form)
	}
	words.forEach((_, index) => {
		for (let length = 1; length <= 3 && index + length <= words.length; length++) match(words.slice(index, index + length).join(' '))
	})
	return found
}
