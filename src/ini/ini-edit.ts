import { toLowerInvariant, trimDotnet } from '../shared/text'
import { standardTagOrder } from './ini-checks'
import { tagRank } from './metadata'
import { IniTokens, tokenizeIni } from './parse-ini'

/**
 * Sets a key of a song.ini's `[song]` section where Clone Hero reads it: the section of that name in any letter case,
 * and the key's last line there. That line keeps how it's written up to its value; a key that isn't there is added
 * with the file's line ending, before the first `[song]` key `goesBefore` accepts, or else after the last key line of
 * the last `[song]` section. A `null` value removes every line of the key in `[song]` sections. Returns `null` when
 * the file has no `[song]` section.
 *
 * Only a UTF-8 file can be edited, so every other byte stays as written.
 */
export function setSongIniValue(tokens: IniTokens, key: string, value: string | null, goesBefore?: (other: string) => boolean): IniTokens | null {
	const text = editableText(tokens)
	if (value !== null) assertIniValue(value)
	const { lines, lastSongLine, keyLines, songKeys } = scanSongSections(text, key)
	if (lastSongLine === -1) return null

	if (value === null) {
		for (const index of keyLines) lines[index] = ''
	} else if (keyLines.length > 0) {
		const index = keyLines[keyLines.length - 1]
		const line = lines[index]
		const lineEnd = line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : ''
		const written = line.slice(0, line.length - lineEnd.length)
		const separator = written.indexOf('=')
		// A blank value gets the spacing written before the "=".
		const after = written.slice(separator + 1)
		const spacing = /^[ \t]*/.exec(trimDotnet(after) === '' ? written.slice(0, separator).replace(/^.*?([ \t]*)$/, '$1') : after)![0]
		lines[index] = `${written.slice(0, separator + 1)}${spacing}${value}${lineEnd}`
	} else if (goesBefore !== undefined && songKeys.some(other => goesBefore(other.key))) {
		const index = songKeys.find(other => goesBefore(other.key))!.index
		lines.splice(index, 0, `${key} = ${value}${lineEnding(text)}`)
	} else {
		const ending = lineEnding(text)
		const after = lines[lastSongLine]
		// The line before the new one may be the file's last, without a line ending.
		if (!after.endsWith('\n')) lines[lastSongLine] = after + ending
		lines.splice(lastSongLine + 1, 0, `${key} = ${value}${ending}`)
	}
	return encodeLike(tokens, lines.join(''))
}

/**
 * A song.ini that can be edited: as it is when it's UTF-8, or else its decoded text written as UTF-8, which Clone Hero
 * reads the same. Throws for a file that can't be decoded.
 */
export function asUtf8Ini(tokens: IniTokens): IniTokens {
	if (tokens.text === null) throw new RangeError('song.ini can\'t be decoded, so it can\'t be edited')
	try {
		editableText(tokens)
		return tokens
	} catch {
		return tokenizeIni(new TextEncoder().encode(tokens.text))
	}
}

/** Whether a song.ini has a `[song]` section, in any letter case, as Clone Hero reads sections. */
export function hasSongIniSection(tokens: IniTokens): boolean {
	return tokens.text !== null && scanSongSections(tokens.text, null).lastSongLine !== -1
}

/**
 * The file's lines, the last line of its last `[song]` section (its header or its last key line), the lines of `key`
 * in `[song]` sections, and every `[song]` key line with its key.
 */
function scanSongSections(text: string, key: string | null) {
	const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
	const wanted = key === null ? null : toLowerInvariant(key)
	let inSong = false
	let lastSongLine = -1
	const keyLines: number[] = []
	const songKeys: { index: number; key: string }[] = []
	lines.forEach((line, index) => {
		// As parseIniTokens reads lines: comments, then sections, then keys.
		const trimmed = trimDotnet(index === 0 ? line.replace(/^\uFEFF/, '') : line)
		if (trimmed.length === 0 || trimmed.startsWith(';') || trimmed.startsWith('#')) return
		if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
			inSong = toLowerInvariant(trimmed.slice(1, -1)) === 'song'
			if (inSong) lastSongLine = index
		} else if (inSong && trimmed.includes('=')) {
			lastSongLine = index
			const lineKey = toLowerInvariant(trimDotnet(trimmed.slice(0, trimmed.indexOf('='))))
			songKeys.push({ index, key: lineKey })
			if (lineKey === wanted) keyLines.push(index)
		}
	})
	return { lines, lastSongLine, keyLines, songKeys }
}

/** What `rewriteSongIni` changes. */
export interface SongIniRewrite {
	/** `[song]` first, comments starting with ";", and the lines games don't read, before it or in other sections, as comments. */
	readonly layout: boolean
	/** The `[song]` tags in the standard order (`standardTagOrder`). */
	readonly order: boolean
	/** Keys to remove from `[song]`. */
	readonly remove: ReadonlySet<string>
	/** Values to set in `[song]`, which win over `remove`. */
	readonly set: ReadonlyMap<string, string>
}

/**
 * Sets and removes song.ini `[song]` values. With `layout` or `order`, the file is written again: the lines before
 * `[song]`, then one `[song]` section holding each tag as Clone Hero reads it, `key = value`, after the comments
 * before it, then the other sections. Without either, only the changed lines change, as `setSongIniValue` edits them.
 * A new tag goes before the first tag the standard order puts after it. Only a UTF-8 file can be rewritten.
 */
export function rewriteSongIni(tokens: IniTokens, rewrite: SongIniRewrite): IniTokens {
	const text = editableText(tokens)
	for (const value of rewrite.set.values()) assertIniValue(value)
	if (!rewrite.layout && !rewrite.order) {
		let edited = tokens
		for (const key of rewrite.remove) if (!rewrite.set.has(key)) edited = setSongIniValue(edited, key, null) ?? edited
		for (const [key, value] of rewrite.set) edited = setSongIniValue(edited, key, value, other => tagRank(other) > tagRank(key)) ?? edited
		return edited
	}

	const { layout } = rewrite
	// A "#" comment keeps its hashes after the ";".
	const asComment = (line: string) => line.startsWith(';') ? line : line.startsWith('#') ? `;${line}` : line.startsWith('//') ? `;${line.slice(2)}` : `; ${line}`
	const before: string[] = []
	const others: string[] = []
	const tags = new Map<string, { value: string; comments: string[] }>()
	let header: string | null = null
	let pending: string[] = []
	let section: 'before' | 'song' | 'other' = 'before'
	// As parseIniTokens reads lines: comments, then sections, then keys.
	for (const raw of text.split(/\r?\n/)) {
		const line = trimDotnet(raw)
		if (line.startsWith('[') && line.endsWith(']')) {
			const isSong = toLowerInvariant(line.slice(1, -1)) === 'song'
			if (isSong) header ??= line
			else others.push(layout ? asComment(line) : raw)
			section = isSong ? 'song' : 'other'
		} else if (section !== 'song') {
			// Games don't read these lines: with `layout`, they're kept as comments.
			if (!layout) (section === 'before' ? before : others).push(raw)
			else if (line !== '') (section === 'before' ? before : others).push(asComment(line))
		} else if (line.startsWith(';') || line.startsWith('#') || line.startsWith('//') || !line.includes('=')) {
			// A line that isn't a key goes with the next key; a "//" comment is read as a key only when it holds "=".
			if (line !== '') pending.push(layout && (line.startsWith('#') || line.startsWith('//')) ? asComment(line) : line)
		} else {
			const key = toLowerInvariant(trimDotnet(line.slice(0, line.indexOf('='))))
			const value = trimDotnet(line.slice(line.indexOf('=') + 1))
			const tag = tags.get(key)
			if (tag === undefined) tags.set(key, { value, comments: pending })
			else {
				tag.value = value
				tag.comments.push(...pending)
			}
			pending = []
		}
	}
	const keys = [...tags.keys()]
	for (const key of rewrite.set.keys()) {
		if (tags.has(key)) continue
		tags.set(key, { value: '', comments: [] })
		const after = keys.findIndex(other => tagRank(other) > tagRank(key))
		keys.splice(after === -1 ? keys.length : after, 0, key)
	}

	const tagLine = (key: string, value: string) => value === '' ? `${key} =` : `${key} = ${value}`
	const lines = [...withoutBlankEnd(before), layout || header === null ? '[song]' : header]
	for (const key of rewrite.order ? standardTagOrder(keys) : keys) {
		const { value, comments } = tags.get(key)!
		lines.push(...comments)
		if (rewrite.set.has(key)) lines.push(tagLine(key, rewrite.set.get(key)!))
		else if (!rewrite.remove.has(key)) lines.push(tagLine(key, value))
	}
	lines.push(...pending, ...withoutBlankEnd(others))
	return encodeLike(tokens, lines.join(lineEnding(text)) + lineEnding(text))
}

/** How many `[song]` sections a song.ini has, and the tags written more than once in them, which a rewrite merges. */
export function songIniRepeats(tokens: IniTokens): { sections: number; keys: string[] } {
	const counts = new Map<string, number>()
	let [sections, inSong] = [0, false]
	// As parseIniTokens reads lines: comments, then sections, then keys.
	for (const raw of (tokens.text ?? '').split(/\r?\n/)) {
		const line = trimDotnet(raw)
		if (line.length === 0 || line.startsWith(';') || line.startsWith('#')) continue
		if (line.startsWith('[') && line.endsWith(']')) {
			inSong = toLowerInvariant(line.slice(1, -1)) === 'song'
			if (inSong) sections++
		} else if (inSong && line.includes('=') && !line.startsWith('//')) {
			const key = toLowerInvariant(trimDotnet(line.slice(0, line.indexOf('='))))
			counts.set(key, (counts.get(key) ?? 0) + 1)
		}
	}
	return { sections, keys: [...counts].filter(([, count]) => count > 1).map(([key]) => key) }
}

function withoutBlankEnd(lines: readonly string[]): string[] {
	let end = lines.length
	while (end > 0 && trimDotnet(lines[end - 1]) === '') end--
	return lines.slice(0, end)
}

/** Adds a `[song]` section holding `entries` at the end of a song.ini, with the file's line ending. UTF-8 only. */
export function appendSongIniSection(tokens: IniTokens, entries: readonly (readonly [key: string, value: string])[]): IniTokens {
	const text = editableText(tokens)
	const ending = lineEnding(text)
	return encodeLike(tokens, `${text}${text.length === 0 || text.endsWith('\n') ? '' : ending}${songIniSection(entries, ending)}`)
}

/** A `[song]` section holding `entries`, by default with Windows line endings, as Clone Hero writes song.ini. */
export function songIniSection(entries: readonly (readonly [key: string, value: string])[], ending = '\r\n'): string {
	for (const [, value] of entries) assertIniValue(value)
	return ['[song]', ...entries.map(([key, value]) => `${key} = ${value}`)].join(ending) + ending
}

/** The file's text, if it can be edited: only UTF-8 text is written back exactly as read. */
function editableText(tokens: IniTokens): string {
	const { text } = tokens
	if (text === null || new TextDecoder('utf-8').decode(tokens.bytes) !== text) throw new RangeError('song.ini isn\'t UTF-8, so it can\'t be edited')
	return text
}

/** song.ini values are read a line at a time and trimmed, so a value is refused unless it reads back as written. */
function assertIniValue(value: string) {
	if (/[\r\n]/.test(value) || trimDotnet(value) !== value) {
		throw new RangeError(`song.ini can't hold ${JSON.stringify(value)}: a value has no line breaks or spaces at either end`)
	}
}

function lineEnding(text: string) {
	return text.includes('\r\n') || !text.includes('\n') ? '\r\n' : '\n'
}

/** `text` as the file's bytes. The decoded text leaves out a UTF-8 byte order mark, and the file keeps it. */
function encodeLike(tokens: IniTokens, text: string): IniTokens {
	const { bytes } = tokens
	const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? [0xef, 0xbb, 0xbf] : []
	const encoded = new TextEncoder().encode(text)
	const edited = new Uint8Array(bom.length + encoded.length)
	edited.set(bom)
	edited.set(encoded, bom.length)
	return tokenizeIni(edited)
}
