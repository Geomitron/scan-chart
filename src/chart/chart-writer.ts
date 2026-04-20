/**
 * `.chart` file writer — serializes a ParsedChart back to chart text.
 *
 * This PR covers the non-instrument-track half of the writer:
 * - `[Song]` section
 * - `[SyncTrack]` section (tempo + time-signature events)
 * - `[Events]` section (sections, endEvents, unrecognized global events,
 *   vocal phrase/lyric events)
 * - Pass-through of unrecognizedChartSections
 *
 * Instrument track emission (`[ExpertSingle]` etc.) lands in a follow-up PR.
 */

import type { ParsedChart } from './parse-chart-and-ini'

/**
 * Serialize a {@link ParsedChart} to `.chart` file text (CRLF line endings).
 * Emits `[Song]`, `[SyncTrack]`, and `[Events]` sections plus any chart sections
 * the parser didn't recognize (preserved verbatim for round-trip).
 *
 * Note: instrument track sections (`[ExpertSingle]`, `[HardDrums]`, etc.) are
 * emitted by a follow-up PR. This entry point currently skips them.
 */
export function writeChartFile(chart: ParsedChart): string {
	const sections: string[][] = []
	sections.push(serializeSongSection(chart))
	sections.push(serializeSyncTrack(chart))
	sections.push(serializeEventsSection(chart))

	// Re-emit any [Section] blocks the parser didn't recognize as standard
	// (Song/SyncTrack/Events) or as a track section. Stored verbatim by
	// scan-chart's unrecognizedChartSections fallback for round-trip preservation.
	for (const us of chart.unrecognizedChartSections) {
		const sec: string[] = [`[${us.name}]`, '{']
		for (const ln of us.lines) sec.push(`  ${ln}`)
		sec.push('}')
		sections.push(sec)
	}

	// Flatten without using spread (which would exceed stack size on large arrays).
	const out: string[] = []
	for (const section of sections) {
		for (const line of section) out.push(line)
	}
	return out.join('\r\n') + '\r\n'
}

// ---------------------------------------------------------------------------
// [Song] section
// ---------------------------------------------------------------------------

/**
 * The subset of `song.ini` fields that the `[Song]` section in a `.chart`
 * file supports. Values for these fields in {@link ParsedChart.metadata} get
 * re-emitted here; all other ini fields live exclusively in `song.ini`.
 */
function serializeSongSection(chart: ParsedChart): string[] {
	const lines: string[] = ['[Song]', '{']
	const m = chart.metadata

	if (m.name != null) lines.push(`  Name = "${m.name}"`)
	if (m.artist != null) lines.push(`  Artist = "${m.artist}"`)
	if (m.charter != null) lines.push(`  Charter = "${m.charter}"`)
	if (m.album != null) lines.push(`  Album = "${m.album}"`)
	if (m.genre != null) lines.push(`  Genre = "${m.genre}"`)
	// [Song]'s `Year` is historically written with a leading `, ` separator
	// (a GHTCP quirk the scan-chart parser strips back out — see chart-parser).
	if (m.year != null) lines.push(`  Year = ", ${m.year}"`)

	lines.push(`  Resolution = ${chart.resolution}`)

	// `[Song].Offset` is a .chart-only field — distinct from ini's `delay`,
	// which games recognize only in song.ini. Read from `metadata.chart_offset`
	// (populated by the parser from [Song].Offset) so that ini's `delay`
	// never overrides it on the ini-wins merge. `PreviewStart` is seconds in
	// the file, ms on ParsedChart.
	if (m.chart_offset != null && m.chart_offset !== 0) {
		lines.push(`  Offset = ${m.chart_offset / 1000}`)
	}
	if (m.preview_start_time != null) {
		lines.push(`  PreviewStart = ${m.preview_start_time / 1000}`)
	}
	if (m.diff_guitar != null) lines.push(`  Difficulty = ${m.diff_guitar}`)

	lines.push('}')
	return lines
}

// ---------------------------------------------------------------------------
// [SyncTrack] section
// ---------------------------------------------------------------------------

function serializeSyncTrack(chart: ParsedChart): string[] {
	const lines: string[] = ['[SyncTrack]', '{']

	type SyncEvent =
		| { tick: number; order: 0; kind: 'ts'; numerator: number; denominator: number }
		| { tick: number; order: 1; kind: 'bpm'; beatsPerMinute: number }

	const events: SyncEvent[] = [
		...chart.timeSignatures.map(
			(ts): SyncEvent => ({
				tick: ts.tick,
				order: 0,
				kind: 'ts',
				numerator: ts.numerator,
				denominator: ts.denominator,
			}),
		),
		...chart.tempos.map(
			(t): SyncEvent => ({ tick: t.tick, order: 1, kind: 'bpm', beatsPerMinute: t.beatsPerMinute }),
		),
	]

	// Sort by tick, then TS before B at the same tick. Duplicates preserved.
	events.sort((a, b) => {
		if (a.tick !== b.tick) return a.tick - b.tick
		return a.order - b.order
	})

	for (const ev of events) {
		if (ev.kind === 'bpm') {
			const millibeats = Math.round(ev.beatsPerMinute * 1000)
			lines.push(`  ${ev.tick} = B ${millibeats}`)
		} else if (ev.denominator === 4) {
			lines.push(`  ${ev.tick} = TS ${ev.numerator}`)
		} else {
			lines.push(`  ${ev.tick} = TS ${ev.numerator} ${Math.log2(ev.denominator)}`)
		}
	}

	lines.push('}')
	return lines
}

// ---------------------------------------------------------------------------
// [Events] section
// ---------------------------------------------------------------------------

function serializeEventsSection(chart: ParsedChart): string[] {
	const lines: string[] = ['[Events]', '{']

	// Typed events: sections (wrapped as `[section name]`), endEvents.
	// Wrapping: scan-chart's section regex `^\[?(?:section|prc)[ _](.*?)\]?$`
	// is greedy for the trailing `\]?$` and lazy for `(.*?)`, so an unwrapped
	// `section [name]` would have its trailing `]` eaten as the optional
	// closing bracket. Wrapping in outer brackets preserves the name.
	const events: { tick: number; text: string }[] = []
	for (const s of chart.sections) events.push({ tick: s.tick, text: `[section ${s.name}]` })
	for (const e of chart.endEvents) events.push({ tick: e.tick, text: 'end' })

	// Unrecognized global events (crowd events, music_start/end, coda, etc.).
	// If the chart was originally parsed from .mid, these came in as `[text]`
	// (square-bracketed MIDI text meta events) — strip the brackets so the
	// .chart output writes the naked text between quotes (the .chart E-event
	// convention).
	const sourceIsMidi = chart.format === 'mid'
	for (const ge of chart.unrecognizedEventsTrackTextEvents) {
		let text = ge.text
		if (sourceIsMidi) {
			const trimmed = text.trimEnd()
			if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
				text = trimmed.slice(1, -1)
			}
		}
		// endEvents are already emitted above; skip duplicates here.
		if (text.trim() === 'end') continue
		events.push({ tick: ge.tick, text })
	}

	// Vocal phrases + lyrics from the normalized `vocals` part. .chart supports
	// only one vocal track (harmonies are MIDI-only).
	type TaggedEvent = { tick: number; text: string; subKey: number }
	const eventPriority = (text: string): number => {
		if (text === 'phrase_end') return 0
		if (text.startsWith('lyric ')) return 1
		if (text === 'coda') return 2
		if (text.startsWith('section ')) return 3
		if (text === 'phrase_start') return 4
		if (text === 'end') return 5
		return 4
	}
	const tagged: TaggedEvent[] = events.map(e => ({
		tick: e.tick,
		text: e.text,
		subKey: 1_000_000 + eventPriority(e.text),
	}))

	const vocalsPart = chart.vocalTracks.parts.vocals
	if (vocalsPart) {
		// Emit phrase_start for every phrase. Omit phrase_end when the next
		// phrase starts at exactly the same tick: the .chart parser closes the
		// current phrase implicitly on the next phrase_start, so an explicit
		// phrase_end would round-trip as a spurious duplicate.
		const phrases = vocalsPart.notePhrases
		for (let i = 0; i < phrases.length; i++) {
			const phrase = phrases[i]
			const endTick = phrase.tick + phrase.length
			tagged.push({ tick: phrase.tick, text: 'phrase_start', subKey: i * 2 })
			const next = phrases[i + 1]
			const nextStartsAtOurEnd = next && next.tick === endTick
			if (!nextStartsAtOurEnd) {
				tagged.push({ tick: endTick, text: 'phrase_end', subKey: i * 2 + 1 })
			}
		}
		for (const phrase of phrases) {
			for (const lyric of phrase.lyrics) {
				tagged.push({ tick: lyric.tick, text: `lyric ${lyric.text}`, subKey: 1_000_000 + 1 })
			}
		}
	}

	tagged.sort((a, b) => {
		if (a.tick !== b.tick) return a.tick - b.tick
		return a.subKey - b.subKey
	})

	for (const ev of tagged) {
		lines.push(`  ${ev.tick} = E "${ev.text}"`)
	}

	lines.push('}')
	return lines
}
