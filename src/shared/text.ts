const allowedTags = [
	'align',
	'allcaps',
	'alpha',
	'b',
	'br',
	'color',
	'cspace',
	'font',
	'font-weight',
	'gradient',
	'i',
	'indent',
	'line-height',
	'line-indent',
	'link',
	'lowercase',
	'margin',
	'mark',
	'mspace',
	'nobr',
	'noparse',
	'page',
	'pos',
	'rotate',
	's',
	'size',
	'smallcaps',
	'space',
	'sprite',
	'strikethrough',
	'style',
	'sub',
	'sup',
	'u',
	'uppercase',
	'voffset',
	'width',
]
const tagPattern = allowedTags.map(tag => `\\b${tag}\\b`).join('|')

/**
 * .NET's `char.IsWhiteSpace` set, which Clone Hero uses for `Trim()`, `IsNullOrWhiteSpace()`, and regex `\s`.
 * Unlike JavaScript's `trim()` and `\s`, it includes U+0085 and excludes U+FEFF.
 */
const dotnetWhitespace = '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const dotnetTrimPattern = new RegExp(`^[${dotnetWhitespace}]+|[${dotnetWhitespace}]+$`, 'g')
const dotnetWhitespaceOnlyPattern = new RegExp(`^[${dotnetWhitespace}]*$`)
const styleTagPattern = new RegExp(`<[${dotnetWhitespace}]*\\/?[${dotnetWhitespace}]*(?:#|${tagPattern})[^>]*>`, 'gi')

/** @returns `text` without leading or trailing whitespace, as .NET's `String.Trim()` removes it. */
export function trimDotnet(text: string) {
	return text.replace(dotnetTrimPattern, '')
}

/** @returns `true` if `text` is `null`, empty, or only whitespace, as .NET's `String.IsNullOrWhiteSpace()` decides. */
export function isNullOrWhiteSpaceDotnet(text: string | null | undefined) {
	return text === null || text === undefined || dotnetWhitespaceOnlyPattern.test(text)
}

/**
 * @returns the most likely text encoding for text in `buffer`.
 */
export function getEncoding(buffer: Uint8Array) {
	if (buffer.length < 2) {
		return 'utf-8'
	}

	if (buffer[0] === 0xff && buffer[1] === 0xfe) {
		return 'utf-16le'
	}

	if (buffer[0] === 0xfe && buffer[1] === 0xff) {
		return 'utf-16be'
	}

	return 'utf-8'
}

/**
 * @returns `text` with all style tags removed. (e.g. "<color=#AEFFFF>Aren Eternal</color> & Geo" -> "Aren Eternal & Geo")
 */
export function removeStyleTags(text: string) {
	let oldText = text
	let newText = text
	do {
		oldText = newText
		newText = trimDotnet(newText.replace(styleTagPattern, ''))
	} while (newText !== oldText)
	return newText
}

/**
 * @returns `true` if `value` is an array of `T` items.
 */
export function isArray<T>(value: T | readonly T[]): value is readonly T[] {
	return Array.isArray(value)
}
