import { defaultIniChartModifiers } from './note-parsing-interfaces'
import type { ParsedChart } from './parse-chart-and-ini'

/**
 * Build a minimal valid {@link ParsedChart} from scratch, without parsing any
 * source bytes. Useful for programmatic chart generation and as the counterpart
 * to `parseChartAndIni`.
 *
 * The returned chart has:
 * - the requested resolution (default 480)
 * - a single tempo event at tick 0 (default 120 BPM)
 * - a single time signature at tick 0 (default 4/4)
 * - empty metadata, tracks, sections, vocal parts, and unrecognized events
 * - `chartBytes` set to an empty `Uint8Array` — there is no source file.
 *   `scanChart()` will hash empty bytes (deterministic but not an identity);
 *   callers that need a meaningful `chartHash` should serialize via
 *   `writeChartFile`/`writeMidiFile` and re-parse.
 * - `format` defaults to `'chart'` — the text format is the simpler target
 *   for programmatic construction; pass `format: 'mid'` when the caller
 *   needs `.mid` output.
 * - `iniChartModifiers` set to the library defaults
 */
export function createEmptyChart(options?: {
	format?: 'chart' | 'mid'
	resolution?: number
	bpm?: number
	timeSignature?: { numerator: number; denominator: number }
}): ParsedChart {
	const resolution = options?.resolution ?? 480
	const bpm = options?.bpm ?? 120
	const numerator = options?.timeSignature?.numerator ?? 4
	const denominator = options?.timeSignature?.denominator ?? 4
	const format = options?.format ?? 'chart'

	return {
		resolution,
		drumType: null,
		metadata: {},
		parseIssues: [],
		vocalTracks: { parts: {}, rangeShifts: [], lyricShifts: [] },
		endEvents: [],
		unrecognizedEventsTrackTextEvents: [],
		unrecognizedEventsTrackMidiEvents: [],
		unrecognizedMidiTracks: [],
		unrecognizedChartSections: [],
		tempos: [{ tick: 0, beatsPerMinute: bpm, msTime: 0 }],
		timeSignatures: [{ tick: 0, numerator, denominator, msTime: 0, msLength: 0 }],
		unrecognizedSyncTrackEvents: [],
		sections: [],
		trackData: [],
		chartBytes: new Uint8Array(0),
		format,
		iniChartModifiers: defaultIniChartModifiers,
	}
}
