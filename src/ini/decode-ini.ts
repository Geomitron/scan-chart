/** Mirrors CH ParsingTools.DetectEncoding and UnsafeIO.ReadAllText, which keep any byte order mark after the detected one. */
export function decodeIni(bytes: Uint8Array): string {
	if (
		bytes.length >= 4 &&
		((bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0) ||
			(bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff))
	) {
		if ((bytes.length - 4) % 4 !== 0) throw new Error('Invalid UTF-32 INI length')
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
		const characters: string[] = []
		for (let offset = 4; offset < bytes.length; offset += 4) {
			const point = view.getUint32(offset, bytes[0] === 0xff)
			if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) throw new Error('Invalid UTF-32 INI code point')
			characters.push(String.fromCodePoint(point))
		}
		return characters.join('')
	}
	if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(2))
	if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(2))
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(3))
	if (bytes[0] === 0x2b && bytes[1] === 0x2f && bytes[2] === 0x76) throw new Error('UTF-7 INI encoding is not supported')
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
	} catch {
		// WHATWG TextDecoder maps "latin1" to Windows-1252, unlike .NET ISO-8859-1.
		return Array.from(bytes, byte => String.fromCharCode(byte)).join('')
	}
}
