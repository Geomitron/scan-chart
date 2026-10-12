import type { Instrument } from '../types'
import { ChartFileTokens, chartSectionLines, chartSectionTrack, ChartLineToken, getNEventType, getSEventType, tokenizeChartFile } from './chart-file-parser'
import type { AuthoredEvent, ChartAuthoredSource } from './authored-view'
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

	const splices: { start: number; end: number; text: string; order: number }[] = []
	edits.forEach((edit, order) => {
		const lines = linesOf(edit.section)
		if (edit.kind === 'insert') {
			if (edit.beforeLine < 1 || edit.beforeLine >= lines.length) throw new RangeError('A line can be inserted only between a section\'s braces')
			const at = offsets(lines[edit.beforeLine].start)
			const { indent, ending } = lineStyle(tokens, lines)
			splices.push({ start: at, end: at, text: `${indent}${edit.text}${ending}\n`, order })
			return
		}
		const line = lines[edit.line]
		const raw = tokens.text.slice(line.start, line.end)
		if (edit.kind === 'replace') {
			const indent = /^[ \t]*/.exec(raw)![0]
			const trailing = /[ \t\r]*$/.exec(raw.slice(indent.length))![0]
			splices.push({ start: offsets(line.start), end: offsets(line.end), text: `${indent}${edit.text}${trailing}`, order })
		} else {
			const isLast = edit.line === lines.length - 1
			splices.push({ start: offsets(line.start), end: isLast ? offsets(line.end) : offsets(line.end + 1), text: '', order })
		}
	})

	// An insertion at a line's start goes before an edit of that line, so it doesn't overlap it.
	splices.sort((a, b) => a.start - b.start || (a.end - a.start === 0 ? 0 : 1) - (b.end - b.start === 0 ? 0 : 1) || a.order - b.order)
	for (let i = 1; i < splices.length; i++) {
		if (splices[i].start < splices[i - 1].end) throw new RangeError('Two edits touch the same line')
	}

	const parts: Uint8Array[] = []
	let copied = 0
	for (const splice of splices) {
		parts.push(tokens.bytes.subarray(copied, splice.start), encodeText(splice.text, tokens.encoding))
		copied = splice.end
	}
	parts.push(tokens.bytes.subarray(copied))
	const edited = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
	let at = 0
	for (const part of parts) {
		edited.set(part, at)
		at += part.length
	}
	return tokenizeChartFile(edited)
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

/**
 * The line edits that change an authored event's tick or length, keeping its line's written form. A tick change moves
 * the line to its place in tick order, which Clone Hero needs.
 */
export function chartEventEdits(
	tokens: ChartFileTokens,
	event: AuthoredEvent & { readonly source: ChartAuthoredSource },
	change: { readonly tick?: number; readonly length?: number },
): ChartLineEdit[] {
	const { section, line } = event.source
	const lines = chartSectionLines(tokens, tokens.sections[section])
	const tick = change.tick ?? event.tick
	const length = change.length ?? event.length
	const match = /^(\d+) = ([NSE]) (.*?)( \d+)?$/.exec(lines[line].text)
	if (match === null) throw new RangeError('The event\'s line isn\'t a tick = N, S or E line')
	const [, , letter, value, lengthPart] = match
	if (letter === 'E' && length !== event.length) throw new RangeError('A .chart text event has no length')
	const text = letter === 'E' ? `${tick} = E ${value}${lengthPart ?? ''}`
		: `${tick} = ${letter} ${value}${lengthPart === undefined && length === 0 ? '' : ` ${length}`}`
	if (tick === event.tick) return [{ kind: 'replace', section, line, text }]
	return [{ kind: 'delete', section, line }, chartEventInsert(tokens, section, tick, text, line)]
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

/**
 * Maps offsets in the decoded text to offsets in the file's bytes. Lines align: a line feed is never part of a
 * multi-byte UTF-8 sequence and is its own UTF-16 code unit. Within a line, the prefix is re-encoded and checked.
 */
function byteOffsets(tokens: ChartFileTokens): (textOffset: number) => number {
	const { bytes, text, encoding } = tokens
	const unit = encoding === 'utf-8' ? 1 : 2
	const bom = encoding === 'utf-8' ? (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0) : 2
	const textLineStarts = [0]
	for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) textLineStarts.push(i + 1)
	const byteLineStarts = [bom]
	for (let i = bom; i + unit <= bytes.length; i += unit) {
		const isLineFeed = encoding === 'utf-8' ? bytes[i] === 0x0a
			: encoding === 'utf-16le' ? bytes[i] === 0x0a && bytes[i + 1] === 0 : bytes[i] === 0 && bytes[i + 1] === 0x0a
		if (isLineFeed) byteLineStarts.push(i + unit)
	}
	if (textLineStarts.length !== byteLineStarts.length) throw new RangeError('The file\'s lines don\'t match its decoded text')

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
