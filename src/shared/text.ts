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
		newText = newText.replace(new RegExp(`<\\s*\\/?\\s*(?:#|${tagPattern})[^>]*>`, 'gi'), '').trim()
	} while (newText !== oldText)
	return newText
}

/**
 * @returns `true` if `value` is an array of `T` items.
 */
export function isArray<T>(value: T | readonly T[]): value is readonly T[] {
	return Array.isArray(value)
}
