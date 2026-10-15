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
const asciiPattern = /^[\x00-\x7f]*$/
const styleTagPattern = new RegExp(`<[${dotnetWhitespace}]*\\/?[${dotnetWhitespace}]*(?:#|${tagPattern})[^>]*>`, 'gi')

/** @returns `text` without leading or trailing whitespace, as .NET's `String.Trim()` removes it. */
export function trimDotnet(text: string) {
	return text.replace(dotnetTrimPattern, '')
}

/**
 * @returns `text` lowercased as .NET's `ToLowerInvariant()` does: each character on its own, by its simple case
 * mapping. Unlike `toLowerCase()`, a final capital sigma becomes "σ" and "İ" becomes "i".
 */
export function toLowerInvariant(text: string) {
	if (asciiPattern.test(text)) return text.toLowerCase()
	let lowered = ''
	for (const char of text) lowered += String.fromCodePoint(char.toLowerCase().codePointAt(0)!)
	return lowered
}

/** @returns `true` if `name` is one of `names`: a string that's `name` in any letter case, or a pattern that matches it. */
export function isNameListed(names: readonly (string | RegExp)[], name: string) {
	return names.some(listed => typeof listed === 'string' ? toLowerInvariant(listed) === toLowerInvariant(name) : listed.test(name))
}

/** @returns `true` if `text` is `null`, empty, or only whitespace, as .NET's `String.IsNullOrWhiteSpace()` decides. */
export function isNullOrWhiteSpaceDotnet(text: string | null | undefined) {
	return text === null || text === undefined || dotnetWhitespaceOnlyPattern.test(text)
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
