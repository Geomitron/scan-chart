/** The text encodings a `.chart` file is read in. */
export type ChartEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'utf-32le' | 'utf-32be' | 'iso-8859-1'

/**
 * A `.chart` file's encoding, by its byte order mark, checked in this order: UTF-32 big-endian, UTF-32 little-endian,
 * UTF-16 little-endian, UTF-16 big-endian, UTF-8. A file without one is UTF-8 when all of it is valid UTF-8, and
 * ISO-8859-1 otherwise.
 */
export function detectChartEncoding(bytes: Uint8Array): { encoding: ChartEncoding; bomLength: number } {
	const starts = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte)
	if (starts(0x00, 0x00, 0xfe, 0xff)) return { encoding: 'utf-32be', bomLength: 4 }
	if (starts(0xff, 0xfe, 0x00, 0x00)) return { encoding: 'utf-32le', bomLength: 4 }
	if (starts(0xff, 0xfe)) return { encoding: 'utf-16le', bomLength: 2 }
	if (starts(0xfe, 0xff)) return { encoding: 'utf-16be', bomLength: 2 }
	if (starts(0xef, 0xbb, 0xbf)) return { encoding: 'utf-8', bomLength: 3 }
	try {
		new TextDecoder('utf-8', { fatal: true }).decode(bytes)
		return { encoding: 'utf-8', bomLength: 0 }
	} catch {
		return { encoding: 'iso-8859-1', bomLength: 0 }
	}
}

/** The length of the byte order mark at the start of bytes in an encoding: 0 when there's none. */
export function bomLength(bytes: Uint8Array, encoding: ChartEncoding): number {
	if (encoding === 'iso-8859-1') return 0
	if (encoding === 'utf-8') return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
	return codeUnitBytes(encoding)
}

/** The number of bytes of each code unit of an encoding, which a line feed takes. */
export function codeUnitBytes(encoding: ChartEncoding): number {
	return encoding.startsWith('utf-32') ? 4 : encoding.startsWith('utf-16') ? 2 : 1
}

/** Decodes bytes, after any byte order mark, in an encoding. A byte sequence that isn't valid becomes U+FFFD. */
export function decodeChartText(bytes: Uint8Array, encoding: ChartEncoding): string {
	if (encoding === 'iso-8859-1') {
		// Each byte is the character of the same number. (A TextDecoder for "latin1" gives Windows-1252 instead.)
		const parts: string[] = []
		for (let start = 0; start < bytes.length; start += 0x8000) parts.push(String.fromCharCode(...bytes.subarray(start, start + 0x8000)))
		return parts.join('')
	}
	if (encoding.startsWith('utf-32')) {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
		const littleEndian = encoding === 'utf-32le'
		const characters: string[] = []
		for (let offset = 0; offset + 4 <= bytes.length; offset += 4) {
			const point = view.getUint32(offset, littleEndian)
			characters.push(point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff) ? '�' : String.fromCodePoint(point))
		}
		if (bytes.length % 4 !== 0) characters.push('�')
		return characters.join('')
	}
	return new TextDecoder(encoding, { ignoreBOM: true }).decode(bytes)
}

/** Encodes text in an encoding. Throws a `RangeError` for a character ISO-8859-1 can't hold. */
export function encodeChartText(text: string, encoding: ChartEncoding): Uint8Array {
	if (encoding === 'utf-8') return new TextEncoder().encode(text)
	if (encoding === 'iso-8859-1') {
		const out = new Uint8Array(text.length)
		for (let i = 0; i < text.length; i++) {
			const code = text.charCodeAt(i)
			if (code > 0xff) throw new RangeError(`The file is ISO-8859-1, which can't hold ${JSON.stringify(text[i])}`)
			out[i] = code
		}
		return out
	}
	if (encoding.startsWith('utf-32')) {
		const points = [...text].map(character => character.codePointAt(0)!)
		const out = new Uint8Array(points.length * 4)
		const view = new DataView(out.buffer)
		points.forEach((point, i) => view.setUint32(i * 4, point, encoding === 'utf-32le'))
		return out
	}
	const out = new Uint8Array(text.length * 2)
	const view = new DataView(out.buffer)
	for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), encoding === 'utf-16le')
	return out
}
