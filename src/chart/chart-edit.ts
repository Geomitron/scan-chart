import type { Instrument } from '../types'
import { ChartFileTokens, chartSectionLines, chartSectionTrack, ChartLineToken, getNEventType, getSEventType, tokenizeChartFile } from './chart-file-parser'
import type { ChartAuthoredSource } from './authored-view'
import { EventType, eventTypes } from './raw-types'

/** One line edit of a `.chart` section. `text` is the line's content, without indentation or line ending. */
export type ChartLineEdit =
	| { readonly kind: 'replace'; readonly section: number; readonly line: number; readonly text: string }
	| { readonly kind: 'delete'; readonly section: number; readonly line: number }
	| { readonly kind: 'insert'; readonly section: number; readonly beforeLine: number; readonly text: string }

/**
 * Applies line edits to a tokenized `.chart` file and returns the edited file, tokenized. Every byte outside the edited
 * lines is copied unchanged. A replaced line keeps its indentation and line ending; an inserted line copies them from
 * the section's first line with content.
 *
 * Throws if two edits touch the same line, or if an edited line's bytes don't decode to its text.
 */
export function editChartLines(tokens: ChartFileTokens, edits: readonly ChartLineEdit[]): ChartFileTokens {
	const offsets = byteOffsets(tokens)
	const sectionLines = new Map<number, ChartLineToken[]>()
	const linesOf = (section: number) => {
		let lines = sectionLines.get(section)
		if (lines === undefined) {
			lines = chartSectionLines(tokens, tokens.sections[section])
			sectionLines.set(section, lines)
		}
		return lines
	}

	const splices: LineSplice[] = []
	edits.forEach((edit, order) => {
		const lines = linesOf(edit.section)
		if (edit.kind === 'insert') {
			if (edit.beforeLine < 1 || edit.beforeLine >= lines.length) throw new RangeError('A line can be inserted only between a section\'s braces')
			const textAt = lines[edit.beforeLine].start
			const at = offsets(textAt)
			const { indent, ending } = lineStyle(tokens, lines)
			const tick = Number(/^(\d+) =/.exec(edit.text)?.[1] ?? 0)
			const text = `${indent}${edit.text}${ending}\n`
			splices.push({ start: at, end: at, textStart: textAt, textEnd: textAt, text, tick, order, keepsStructure: isTickLine(edit.text) })
			return
		}
		const line = lines[edit.line]
		const raw = tokens.text.slice(line.start, line.end)
		if (edit.kind === 'replace') {
			const indent = /^[ \t]*/.exec(raw)![0]
			const trailing = /[ \t\r]*$/.exec(raw.slice(indent.length))![0]
			splices.push({
				start: offsets(line.start), end: offsets(line.end), textStart: line.start, textEnd: line.end,
				text: `${indent}${edit.text}${trailing}`, tick: 0, order, keepsStructure: isTickLine(edit.text) && isTickLine(line.text),
			})
		} else {
			const isLast = edit.line === lines.length - 1
			const textEnd = isLast ? line.end : line.end + 1
			splices.push({
				start: offsets(line.start), end: offsets(textEnd), textStart: line.start, textEnd,
				text: '', tick: 0, order, keepsStructure: !isLast && isTickLine(line.text),
			})
		}
	})

	// An insertion at a line's start goes before an edit of that line, so it doesn't overlap it. Insertions at one place
	// go in tick order.
	splices.sort((a, b) => a.start - b.start || (a.end - a.start === 0 ? 0 : 1) - (b.end - b.start === 0 ? 0 : 1) || a.tick - b.tick || a.order - b.order)
	for (let i = 1; i < splices.length; i++) {
		if (splices[i].start < splices[i - 1].end) throw new RangeError('Two edits touch the same line')
	}
	const encoded = splices.map(splice => encodeText(splice.text, tokens.encoding))
	const bytes = splicedBytes(tokens, splices, encoded)
	// Tick lines can't change where sections start or end, since the section reader skips each line after its `=`.
	// So the edited file's tokens follow from these, without reading the file again.
	if (tokens.structureError === null && splices.every(splice => splice.keepsStructure)) return withSplicedLines(tokens, bytes, splices, encoded)
	return tokenizeChartFile(bytes)
}

/** One edit of a whole line or a line boundary, in byte offsets (`start`, `end`) and in text offsets. */
interface LineSplice {
	readonly start: number
	readonly end: number
	readonly textStart: number
	readonly textEnd: number
	readonly text: string
	readonly tick: number
	readonly order: number
	/** Whether the lines it removes and writes are all tick lines, which can't change the file's sections. */
	readonly keepsStructure: boolean
}

/** A section line of the form `tick = value`, without line breaks. */
function isTickLine(text: string): boolean {
	return /^\d+ = [^\r\n]*$/.test(text)
}

/**
 * The tokens of `bytes`, which are `tokens`' bytes with `splices` applied, made from `tokens` instead of decoding and
 * reading the sections again: the text is spliced the same way, each section's offsets shift by the splices before
 * them, and the line index shifts with them.
 */
function withSplicedLines(tokens: ChartFileTokens, bytes: Uint8Array, splices: readonly LineSplice[], encoded: readonly Uint8Array[]): ChartFileTokens {
	const textParts: string[] = []
	let copied = 0
	for (const splice of splices) {
		textParts.push(tokens.text.slice(copied, splice.textStart), splice.text)
		copied = splice.textEnd
	}
	textParts.push(tokens.text.slice(copied))

	let next = 0, shift = 0
	const sections = tokens.sections.map(section => {
		const bodyStart = section.bodyStart + shift
		while (next < splices.length && splices[next].textStart <= section.bodyEnd) {
			shift += splices[next].text.length - (splices[next].textEnd - splices[next].textStart)
			next++
		}
		return { name: section.name, bodyStart, bodyEnd: section.bodyEnd + shift }
	})

	const edited: ChartFileTokens = { bytes, encoding: tokens.encoding, text: textParts.join(''), sections, structureError: null }
	lineIndexes.set(edited, splicedLineIndex(lineIndexOf(tokens), splices, encoded, tokens.encoding))
	return edited
}

/** The line index after `splices`: starts inside a replaced range go, the inserted text's starts come in, and later ones shift. */
function splicedLineIndex(index: LineIndex, splices: readonly LineSplice[], encoded: readonly Uint8Array[], encoding: ChartFileTokens['encoding']): LineIndex {
	const { textLineStarts, byteLineStarts } = index
	const unit = encoding === 'utf-8' ? 1 : 2
	const textStarts: number[] = [], byteStarts: number[] = []
	let line = 0, textShift = 0, byteShift = 0
	splices.forEach((splice, k) => {
		for (; line < textLineStarts.length && textLineStarts[line] <= splice.textStart; line++) {
			textStarts.push(textLineStarts[line] + textShift)
			byteStarts.push(byteLineStarts[line] + byteShift)
		}
		while (line < textLineStarts.length && textLineStarts[line] <= splice.textEnd) line++
		for (let i = splice.text.indexOf('\n'); i !== -1; i = splice.text.indexOf('\n', i + 1)) textStarts.push(splice.textStart + textShift + i + 1)
		for (let i = 0; i + unit <= encoded[k].length; i += unit) {
			if (isLineFeedAt(encoded[k], i, encoding)) byteStarts.push(splice.start + byteShift + i + unit)
		}
		textShift += splice.text.length - (splice.textEnd - splice.textStart)
		byteShift += encoded[k].length - (splice.end - splice.start)
	})
	for (; line < textLineStarts.length; line++) {
		textStarts.push(textLineStarts[line] + textShift)
		byteStarts.push(byteLineStarts[line] + byteShift)
	}
	return { textLineStarts: textStarts, byteLineStarts: byteStarts }
}

/**
 * Replaces ranges of a tokenized `.chart` file's decoded text and returns the edited file, tokenized. Every byte
 * outside the ranges is copied unchanged. Ranges are offsets in the text, in order and not overlapping.
 *
 * Throws if a range boundary's bytes don't decode to the text before it.
 */
export function spliceChartText(tokens: ChartFileTokens, splices: readonly { start: number; end: number; text: string }[]): ChartFileTokens {
	const offsets = byteOffsets(tokens)
	return spliceBytes(tokens, splices.map(splice => {
		const start = offsets(splice.start), end = offsets(splice.end)
		// Text decoded from invalid bytes holds replacement characters; writing it back would change those bytes.
		if (splice.text !== '' && !sameBytes(encodeText(tokens.text.slice(splice.start, splice.end), tokens.encoding), tokens.bytes.subarray(start, end))) {
			throw new RangeError('The text being replaced holds bytes that aren\'t valid in the file\'s encoding')
		}
		return { start, end, text: splice.text }
	}))
}

/**
 * Adds an empty section for each name at the end of a tokenized `.chart` file, with the file's line ending, and
 * returns the edited file, tokenized. The existing sections keep their indexes, and the new ones follow in order.
 */
export function appendChartSections(tokens: ChartFileTokens, names: readonly string[]): ChartFileTokens {
	if (names.length === 0) return tokens
	const ending = tokens.text.includes('\r\n') || !tokens.text.includes('\n') ? '\r\n' : '\n'
	const separator = tokens.text.length === 0 || tokens.text.endsWith('\n') ? '' : ending
	const text = names.map(name => `[${name}]${ending}{${ending}}${ending}`).join('')
	return spliceChartText(tokens, [{ start: tokens.text.length, end: tokens.text.length, text: separator + text }])
}

/**
 * Whether a range of whole lines of a `.chart` file is exactly its decoded text, encoded again: no invalid bytes that
 * decoding replaced. `start` and `end` are offsets of line starts in the text, or the text's end.
 */
export function chartTextRoundTrips(tokens: ChartFileTokens, start: number, end: number): boolean {
	const offsets = byteOffsets(tokens)
	return sameBytes(encodeText(tokens.text.slice(start, end), tokens.encoding), tokens.bytes.subarray(offsets(start), offsets(end)))
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
	return true
}

/** Splices text into the file's bytes and tokenizes the result. `start` and `end` are byte offsets, in order. */
function spliceBytes(tokens: ChartFileTokens, splices: readonly { start: number; end: number; text: string }[]): ChartFileTokens {
	return tokenizeChartFile(splicedBytes(tokens, splices, splices.map(splice => encodeText(splice.text, tokens.encoding))))
}

/** The file's bytes with each splice's range replaced by its encoded text. `start` and `end` are byte offsets, in order. */
function splicedBytes(tokens: ChartFileTokens, splices: readonly { start: number; end: number }[], encoded: readonly Uint8Array[]): Uint8Array {
	const parts: Uint8Array[] = []
	let copied = 0
	splices.forEach((splice, k) => {
		parts.push(tokens.bytes.subarray(copied, splice.start), encoded[k])
		copied = splice.end
	})
	parts.push(tokens.bytes.subarray(copied))
	const edited = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
	let at = 0
	for (const part of parts) {
		edited.set(part, at)
		at += part.length
	}
	return edited
}

/** The `.chart` line content for an authored event of an instrument, or `null` if `.chart` can't write that event. */
export function chartEventLineText(instrument: Instrument, tick: number, type: EventType, length: number): string | null {
	if (type === eventTypes.soloSectionStart) return `${tick} = E solo`
	if (type === eventTypes.soloSectionEnd) return `${tick} = E soloend`
	for (let value = 0; value < 256; value++) {
		if (getNEventType(String(value), instrument) === type) return `${tick} = N ${value} ${length}`
		if (getSEventType(String(value)) === type) return `${tick} = S ${value} ${length}`
	}
	return null
}

/** A new value for a tempo, time signature or text event. */
export type ChartValueChange =
	| { readonly beatsPerMinute: number }
	| { readonly numerator: number; readonly denominator: number }
	| { readonly text: string }

/**
 * The line edits that change an authored element's tick, length or value, keeping the rest of its line's written form.
 * Any `tick = value` line can move; only an `N` or `S` line has a length. A tick change moves the line to its place in
 * tick order, which Clone Hero needs.
 */
export function chartEventEdits(
	tokens: ChartFileTokens,
	event: { readonly tick: number; readonly length?: number; readonly source: ChartAuthoredSource },
	change: { readonly tick?: number; readonly length?: number; readonly value?: ChartValueChange },
): ChartLineEdit[] {
	const { section, line } = event.source
	const lines = chartSectionLines(tokens, tokens.sections[section])
	const match = /^(\d+) = (.*)$/.exec(lines[line].text)
	if (match === null) throw new RangeError('The event\'s line isn\'t a tick = value line')
	const lineEnd = line + 1 < lines.length ? lines[line + 1].start : lines[line].end
	if (!chartTextRoundTrips(tokens, lines[line].start, lineEnd)) {
		throw new RangeError('The event\'s line holds bytes that aren\'t valid in the file\'s encoding, so it can only be removed')
	}
	const writtenTick = Number(match[1])
	const tick = change.tick ?? writtenTick
	let value = change.value ? chartValueText(match[2], change.value) : match[2]
	if (change.length !== undefined && change.length !== event.length) {
		const note = /^([NS]) (\d+)(?: \d+)?$/.exec(value)
		if (note === null) throw new RangeError(value.startsWith('E ') ? 'A .chart text event has no length' : 'Only a .chart N or S event has a length')
		value = `${note[1]} ${note[2]} ${change.length}`
	}
	const text = `${tick} = ${value}`
	if (tick === writtenTick) return [{ kind: 'replace', section, line, text }]
	return [{ kind: 'delete', section, line }, chartEventInsert(tokens, section, tick, text, line)]
}

/**
 * The value of a `.chart` line (after `tick = `) with a new tempo, time signature or text, in the form `written` has:
 * a time signature keeps an explicit denominator of 4, and a text event keeps or omits its quotes. Without `written`,
 * the value of a new line.
 */
export function chartValueText(written: string | null, change: ChartValueChange): string {
	if ('beatsPerMinute' in change) {
		const millibeats = Math.round(change.beatsPerMinute * 1000)
		if (written !== null && !written.startsWith('B ')) throw new RangeError('The line isn\'t a tempo')
		if (!(millibeats >= 1 && Number.isSafeInteger(millibeats))) throw new RangeError('A .chart tempo must be at least 0.001 BPM')
		return `B ${millibeats}`
	}
	if ('numerator' in change) {
		const exponent = Math.log2(change.denominator)
		if (written !== null && !written.startsWith('TS ')) throw new RangeError('The line isn\'t a time signature')
		if (!Number.isSafeInteger(change.numerator) || change.numerator < 1 || !Number.isInteger(exponent) || exponent < 0) {
			throw new RangeError('A time signature needs a positive numerator and a power-of-two denominator')
		}
		const writesDenominator = exponent !== 2 || (written !== null && /^TS \d+ \d+$/.test(written))
		return `TS ${change.numerator}${writesDenominator ? ` ${exponent}` : ''}`
	}
	if (written !== null && !written.startsWith('E ')) throw new RangeError('The line isn\'t a text event')
	if (/[\r\n]/.test(change.text)) throw new RangeError('A .chart text event can\'t hold a line break')
	return written === null || /^E ".*"$/.test(written) ? `E "${change.text}"` : `E ${change.text}`
}

/** The edit that inserts a line at its place in tick order. `value` is the line's content after `tick = `. */
export function chartLineInsertEdit(tokens: ChartFileTokens, section: number, tick: number, value: string): ChartLineEdit {
	return chartEventInsert(tokens, section, tick, `${tick} = ${value}`)
}

/** The edit that inserts a line for a new authored event at its place in tick order. */
export function chartEventInsertEdit(tokens: ChartFileTokens, section: number, tick: number, type: EventType, length: number): ChartLineEdit {
	const track = chartSectionTrack(tokens.sections[section].name)
	if (track === null) throw new RangeError('Events can only be added to an instrument section')
	const text = chartEventLineText(track.instrument, tick, type, length)
	if (text === null) throw new RangeError('.chart has no way to write this event')
	return chartEventInsert(tokens, section, tick, text)
}

function chartEventInsert(tokens: ChartFileTokens, section: number, tick: number, text: string, skipLine?: number): ChartLineEdit {
	const lines = chartSectionLines(tokens, tokens.sections[section])
	let beforeLine = lines.length - 1
	for (let index = 1; index < lines.length - 1; index++) {
		if (index === skipLine) continue
		const lineTick = /^(\d+) =/.exec(lines[index].text)
		if (lineTick !== null && Number(lineTick[1]) > tick) {
			beforeLine = index
			break
		}
	}
	return { kind: 'insert', section, beforeLine, text }
}

function lineStyle(tokens: ChartFileTokens, lines: readonly ChartLineToken[]): { indent: string; ending: string } {
	const sample = lines.find(line => line.text !== '')
	if (sample === undefined) return { indent: '  ', ending: tokens.text.includes('\r\n') ? '\r' : '' }
	const raw = tokens.text.slice(sample.start, sample.end)
	return { indent: /^[ \t]*/.exec(raw)![0], ending: raw.endsWith('\r') ? '\r' : '' }
}

/** Where each line starts, in the decoded text and in the file's bytes. */
interface LineIndex {
	readonly textLineStarts: readonly number[]
	readonly byteLineStarts: readonly number[]
}

const lineIndexes = new WeakMap<ChartFileTokens, LineIndex>()

/**
 * The line index of a tokenized `.chart` file, built once per tokens. Lines align: a line feed is never part of a
 * multi-byte UTF-8 sequence and is its own UTF-16 code unit.
 */
function lineIndexOf(tokens: ChartFileTokens): LineIndex {
	const cached = lineIndexes.get(tokens)
	if (cached !== undefined) return cached
	const { bytes, text, encoding } = tokens
	const unit = encoding === 'utf-8' ? 1 : 2
	const bom = encoding === 'utf-8' ? (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0) : 2
	const textLineStarts = [0]
	for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) textLineStarts.push(i + 1)
	const byteLineStarts = [bom]
	for (let i = bom; i + unit <= bytes.length; i += unit) {
		if (isLineFeedAt(bytes, i, encoding)) byteLineStarts.push(i + unit)
	}
	if (textLineStarts.length !== byteLineStarts.length) throw new RangeError('The file\'s lines don\'t match its decoded text')
	const index = { textLineStarts, byteLineStarts }
	lineIndexes.set(tokens, index)
	return index
}

function isLineFeedAt(bytes: Uint8Array, i: number, encoding: ChartFileTokens['encoding']): boolean {
	return encoding === 'utf-8' ? bytes[i] === 0x0a
		: encoding === 'utf-16le' ? bytes[i] === 0x0a && bytes[i + 1] === 0 : bytes[i] === 0 && bytes[i + 1] === 0x0a
}

/**
 * Maps offsets in the decoded text to offsets in the file's bytes, through the line index. Within a line, the prefix
 * is re-encoded and checked.
 */
function byteOffsets(tokens: ChartFileTokens): (textOffset: number) => number {
	const { bytes, text, encoding } = tokens
	const { textLineStarts, byteLineStarts } = lineIndexOf(tokens)

	return textOffset => {
		let low = 0, high = textLineStarts.length - 1
		while (low < high) {
			const middle = (low + high + 1) >> 1
			if (textLineStarts[middle] <= textOffset) low = middle; else high = middle - 1
		}
		const prefix = text.slice(textLineStarts[low], textOffset)
		const encoded = encodeText(prefix, encoding)
		const start = byteLineStarts[low]
		const decoded = new TextDecoder(encoding, { ignoreBOM: true }).decode(bytes.subarray(start, start + encoded.length))
		if (decoded !== prefix) throw new RangeError('An edited line\'s bytes don\'t decode to its text')
		return start + encoded.length
	}
}

function encodeText(text: string, encoding: ChartFileTokens['encoding']): Uint8Array {
	if (encoding === 'utf-8') return new TextEncoder().encode(text)
	const out = new Uint8Array(text.length * 2)
	const view = new DataView(out.buffer)
	for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), encoding === 'utf-16le')
	return out
}
