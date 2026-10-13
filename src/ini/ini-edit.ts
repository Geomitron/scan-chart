import { toLowerInvariant, trimDotnet } from '../shared/text'
import { IniTokens, tokenizeIni } from './parse-ini'

/**
 * Sets a key of a song.ini's `[song]` section where Clone Hero reads it: the section of that name in any letter case,
 * and the key's last line there. That line keeps how it's written up to its value; a key that isn't there is added
 * after the last key line of the last `[song]` section, with the file's line ending. A `null` value removes every
 * line of the key in `[song]` sections. Returns `null` when the file has no `[song]` section.
 *
 * Only a UTF-8 file can be edited, so every other byte stays as written.
 */
export function setSongIniValue(tokens: IniTokens, key: string, value: string | null): IniTokens | null {
	const text = editableText(tokens)
	if (value !== null) assertIniValue(value)
	const { lines, lastSongLine, keyLines } = scanSongSections(text, key)
	if (lastSongLine === -1) return null

	if (value === null) {
		for (const index of keyLines) lines[index] = ''
	} else if (keyLines.length > 0) {
		const index = keyLines[keyLines.length - 1]
		const line = lines[index]
		const lineEnd = line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : ''
		const written = line.slice(0, line.length - lineEnd.length)
		const separator = written.indexOf('=')
		const spacing = /^[ \t]*/.exec(written.slice(separator + 1))![0]
		lines[index] = `${written.slice(0, separator + 1)}${spacing}${value}${lineEnd}`
	} else {
		const ending = lineEnding(text)
		const after = lines[lastSongLine]
		// The line before the new one may be the file's last, without a line ending.
		if (!after.endsWith('\n')) lines[lastSongLine] = after + ending
		lines.splice(lastSongLine + 1, 0, `${key} = ${value}${ending}`)
	}
	return encodeLike(tokens, lines.join(''))
}

/** Whether a song.ini has a `[song]` section, in any letter case, as Clone Hero reads sections. */
export function hasSongIniSection(tokens: IniTokens): boolean {
	return tokens.text !== null && scanSongSections(tokens.text, null).lastSongLine !== -1
}

/**
 * The file's lines, the last line of its last `[song]` section (its header or its last key line), and the lines of
 * `key` in `[song]` sections.
 */
function scanSongSections(text: string, key: string | null) {
	const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
	const wanted = key === null ? null : toLowerInvariant(key)
	let inSong = false
	let lastSongLine = -1
	const keyLines: number[] = []
	lines.forEach((line, index) => {
		// As parseIniTokens reads lines: comments, then sections, then keys.
		const trimmed = trimDotnet(index === 0 ? line.replace(/^\uFEFF/, '') : line)
		if (trimmed.length === 0 || trimmed.startsWith(';') || trimmed.startsWith('#')) return
		if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
			inSong = toLowerInvariant(trimmed.slice(1, -1)) === 'song'
			if (inSong) lastSongLine = index
		} else if (inSong && trimmed.includes('=')) {
			lastSongLine = index
			if (wanted !== null && toLowerInvariant(trimDotnet(trimmed.slice(0, trimmed.indexOf('=')))) === wanted) keyLines.push(index)
		}
	})
	return { lines, lastSongLine, keyLines }
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
