import { toLowerInvariant, trimDotnet } from '../shared/text'
import { IniTokens, tokenizeIni } from './parse-ini'

/** A kind of nonstandard song.ini spelling: a key written more than once in a section, of which Clone Hero reads the last. */
export type IniNormalizationKind = 'duplicateKeys'

/** One normalization of a song.ini file. */
export interface IniNormalization {
	readonly kind: IniNormalizationKind
	/** Rewrites the file as it is now. Returns `tokens` unchanged when there's nothing left to rewrite. */
	readonly apply: (tokens: IniTokens) => IniTokens
}

/**
 * Every normalization a song.ini file needs. A repeated key keeps its last line, the one Clone Hero reads, as keys and
 * section names are read regardless of letter case. Only a UTF-8 file is normalized: its lines are removed from the
 * bytes, so every other byte stays as written.
 */
export function iniNormalizations(tokens: IniTokens): IniNormalization[] {
	if (repeatedKeyLines(tokens).length === 0) return []
	return [{
		kind: 'duplicateKeys',
		apply: current => {
			const ranges = repeatedKeyLines(current)
			if (ranges.length === 0) return current
			const kept: Uint8Array[] = []
			let from = 0
			for (const { start, end } of ranges) {
				kept.push(current.bytes.subarray(from, start))
				from = end
			}
			kept.push(current.bytes.subarray(from))
			const bytes = new Uint8Array(kept.reduce((total, part) => total + part.length, 0))
			let at = 0
			for (const part of kept) {
				bytes.set(part, at)
				at += part.length
			}
			return tokenizeIni(bytes)
		},
	}]
}

/** The byte ranges, line feed included, of every key line that a later line of the same key in its section replaces. */
function repeatedKeyLines(tokens: IniTokens): { start: number; end: number }[] {
	const { bytes, text } = tokens
	if (text === null || new TextDecoder('utf-8').decode(bytes) !== text) return []
	const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
	const lastLineOfKey = new Map<string, number>()
	const keyLines: { key: string; start: number; end: number }[] = []
	let section = '\u0000no section'
	for (let start = 0; start < bytes.length;) {
		const lineFeed = bytes.indexOf(0x0a, start)
		const end = lineFeed === -1 ? bytes.length : lineFeed + 1
		const line = trimDotnet(decoder.decode(bytes.subarray(start, lineFeed === -1 ? end : lineFeed)).replace(/^\uFEFF/, ''))
		// As parseIniTokens reads lines: comments, then sections, then keys.
		if (line.length > 0 && !line.startsWith(';') && !line.startsWith('#')) {
			if (line.startsWith('[') && line.endsWith(']')) section = toLowerInvariant(line.slice(1, -1))
			else if (line.includes('=')) {
				const key = `${section}\u0000${toLowerInvariant(trimDotnet(line.slice(0, line.indexOf('='))))}`
				lastLineOfKey.set(key, keyLines.length)
				keyLines.push({ key, start, end })
			}
		}
		start = end
	}
	return keyLines.filter(({ key }, index) => lastLineOfKey.get(key) !== index).map(({ start, end }) => ({ start, end }))
}
