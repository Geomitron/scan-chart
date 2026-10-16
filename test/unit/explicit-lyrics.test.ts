import { describe, expect, it } from 'vitest'

import { parseLyricFlags } from 'src/chart/lyric-parser'
import { lyricWords, phraseText, strongWordsIn } from 'src/ini/explicit-lyrics'
import { scanSongFolder } from 'src/scan-song-folder'

const encode = (text: string) => new TextEncoder().encode(text)
/** Lyrics as the parser keeps them: their text, with the flags its symbols set. */
const lyrics = (...texts: string[]) => texts.map((text, index) => ({ tick: index, msTime: index, text, flags: parseLyricFlags(text) }))
const strong = (text: string) => strongWordsIn(lyricWords(text))

describe('rebuilding a lyric phrase from its syllables', () => {
	it('joins a syllable to the next after "-", and after "=" with a hyphen, which separates words', () => {
		expect(phraseText(lyrics('Mo-', 'ther-', 'fuck-', 'er', 'Spi-', 'der=', 'Man'))).toBe('Motherfucker Spider-Man')
		expect(lyricWords('Motherfucker Spider-Man')).toEqual(['motherfucker', 'spider', 'man'])
	})

	it('joins a syllable that starts with "+" to the one before it, and other syllables after a space', () => {
		expect(phraseText(lyrics('oh', '+oh', 'yeah'))).toBe('ohoh yeah')
	})

	it('removes style tags and lyric symbols, and shows "_" and "§" as spaces', () => {
		expect(phraseText(lyrics('<i>Hold#</i>', '$on^', '"to"*', 'what_we%', 'had§now/'))).toBe('Hold on to what we had now')
	})

	it('reads words in lowercase and full width as plain letters, with apostrophes inside them only', () => {
		expect(lyricWords('Don’t STOP, ‘runnin’ ＦＵＣＫ 2nd!')).toEqual(['don\'t', 'stop', 'runnin', 'fuck', '2nd'])
	})
})

describe('matching the strong words', () => {
	it('matches a whole word, without a final "\'s", with a "g" after a final "in", and an entry of several words', () => {
		expect(strong('What the fuck')).toEqual(['fuck'])
		expect(strong('FUCKIN\' shit\'s on fire, you porch monkey')).toEqual(['fucking', 'shit', 'porch monkey'])
		expect(phraseText(lyrics('Fuck-', 'in\'', 'bull-', 'shit'))).toBe('Fuckin\' bullshit')
		expect(strong('Fuckin\' bullshit')).toEqual(['fucking', 'bullshit'])
	})

	it('doesn\'t match a word inside another', () => {
		expect(strong('Scunthorpe cocktail class assassin spicy shiitake Dickens')).toEqual([])
		expect(strong('porch and monkey')).toEqual([])
	})

	it('leaves out mild words, words with an innocent sense, and censored spellings', () => {
		expect(strong('Hell damn crap ass bitch cock pussy balls')).toEqual([])
		expect(strong('Kike canta con Spic and Span')).toEqual([])
		expect(strong(phraseText(lyrics('f*ck', 'sh#t', 'f**king')))).toEqual([])
	})
})

describe('missingExplicitLyrics', () => {
	/** A `.chart` song whose lyric phrases each take a measure, from 2 seconds in, with song.ini's `lines`. */
	const song = (phrases: readonly (readonly string[])[], lines: readonly string[] = []) => {
		const events = phrases.flatMap((syllables, index) => {
			const start = (index + 1) * 768
			return [`${start} = E "phrase_start"`, ...syllables.map((syllable, at) => `${start + at * 48} = E "lyric ${syllable}"`), `${start + 700} = E "phrase_end"`]
		})
		const chart = ['[Song]', '{', '  Resolution = 192', '}', '[SyncTrack]', '{', '  0 = TS 4', '  0 = B 120000', '}',
			'[Events]', '{', ...events.map(event => `  ${event}`), '}', '[ExpertSingle]', '{', '  768 = N 0 0', '}', '']
		return [{ fileName: 'notes.chart', data: encode(chart.join('\r\n')) }, { fileName: 'song.ini', data: encode(['[song]', 'name = Song', ...lines, ''].join('\r\n')) }]
	}
	const explicit = async (phrases: readonly (readonly string[])[], lines?: readonly string[]) => {
		const scanned = await scanSongFolder(song(phrases, lines))
		return scanned.issues.filter(issue => issue.code === 'missingExplicitLyrics').map(({ severity, scope, file, message }) => ({ severity, scope, file, message }))
	}

	it('recommends explicit_lyrics = True for lyrics with a strong word, in every scan, naming the first phrase', async () => {
		expect(await explicit([['We', 'don\'t', 'give', 'a'], ['fuck-', 'in\'', 'damn']])).toEqual([{ severity: 'recommendation', scope: 'metadata', file: 'song.ini',
			message: 'The lyrics have a word that may be explicit, at 0:04: "fuckin\' damn". If they\'re explicit, set "explicit_lyrics = True".' }])
		expect((await explicit([['shit'], ['clean'], ['Shit-', 'ty']]))[0].message)
			.toBe('The lyrics have words that may be explicit in 2 phrases, the first at 0:02: "shit". If they\'re explicit, set "explicit_lyrics = True".')
	})

	it('reports explicit_lyrics = False, blank or not a boolean, but never True, and nothing for lyrics without a strong word', async () => {
		const phrases = [['Oh', 'shit']]
		for (const value of ['False', '', 'maybe']) expect(await explicit(phrases, [`explicit_lyrics = ${value}`.trim()])).toHaveLength(1)
		expect(await explicit(phrases, ['explicit_lyrics = True'])).toEqual([])
		expect(await explicit([['What', 'the', 'hell'], ['Damn', 'it']])).toEqual([])
	})

	it('is silenced for a song whose ignored_issues lists it', async () => {
		const scanned = await scanSongFolder(song([['Oh', 'shit']], ['ignored_issues = missingExplicitLyrics']))
		expect(scanned.issues.map(issue => issue.code)).not.toContain('missingExplicitLyrics')
		expect(scanned.ignoredIssues.map(issue => issue.code)).toEqual(['missingExplicitLyrics'])
	})
})
