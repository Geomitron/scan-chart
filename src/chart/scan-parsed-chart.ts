import { blake3 } from '@awasm/noble'

import { md5 } from 'js-md5'
import * as _ from 'lodash'
import { base64url } from 'rfc4648'

import { defaultMetadata } from '../ini/metadata'
import { msToExactTime } from '../shared/time'
import { NotesData } from '../types'
import { chartIssueMessages, chartStats, findChartIssues, sameAsExpert } from './chart-analysis'
import { canonicalChartFromParse, CanonicalParsedChart } from './identity/canonical-source'
import { canonical20260801, CanonicalSongBundle } from './identity/public'
import { ParsedChart, parsedCharts } from './parse-chart-and-ini'
import { IniChartModifiers } from './types'

/**
 * Compute the chart-derived hashes and `notesData` from an already-parsed
 * chart. The output is the same chart-only subset of `ScannedChart` that
 * the previous `scanChart(files, …)` returned; this version takes a
 * `ParsedChart` so callers can reuse a parse result without redoing it.
 *
 * `trackHashes` and `songHash` come from the canonical 20260801 identity profile, which reuses the scanner's parse
 * when it can. `identityError` is set when that profile rejects the chart.
 */
export function scanParsedChart(parsedChart: ParsedChart, includeBTrack = false) {
	const result = parsedChart
	const iniChartModifiers = result.iniChartModifiers

	const identity = calculateCanonicalIdentity(result)
	const bundle = identity.kind === 'accepted' ? identity.bundle : null
	const trackHashes = (bundle?.tracks ?? []).map(track => ({
		instrument: track.instrument,
		difficulty: track.difficulty,
		hash: track.identity.trackHash.value,
		btrack: includeBTrack ? track.identity.physicalBTrack.bytes : null,
	}))
	const stats = chartStats(result, iniChartModifiers, result.format)
	const chartIssues: NotesData['chartIssues'] = findChartIssues(result, sameAsExpert(identity.kind === 'accepted' ? identity.chart : null))
		.map(({ code, instrument, difficulty, msTime }) => ({
			instrument,
			difficulty,
			noteIssue: code,
			description: msTime !== null ? `[${msToExactTime(msTime)}]: ${chartIssueMessages[code]}` : chartIssueMessages[code],
		}))

	return {
		chartHash: getChartHash(result.chartBytes, iniChartModifiers),
		songHash: bundle?.song.songHash.value ?? null,
		songDurationMs: bundle === null ? null : Number(bundle.duration.durationMs),
		identityError: identity.kind === 'rejected' ? identity.error : null,
		notesData: {
			instruments: [...stats.instruments],
			drumType: stats.drumType,
			hasSoloSections: stats.hasSolos,
			hasLyrics: stats.hasLyrics,
			hasVocals: stats.hasVocals,
			hasForcedNotes: stats.hasForcedNotes,
			hasTapNotes: stats.hasTapNotes,
			hasOpenNotes: stats.hasOpenNotes,
			has2xKick: stats.has2xKick,
			hasFlexLanes: stats.hasFlexLanes,
			chartIssues,
			noteCounts: [...stats.noteCounts],
			maxNps: stats.maxNps.map(({ instrument, difficulty, msTime, nps }) => ({ instrument, difficulty, nps, time: msTime })),
			trackHashes,
			tempoMapHash: md5
				.create()
				.update(result.tempos.map(t => `${t.tick}_${t.beatsPerMinute * 1000}`).join(':'))
				.update(result.timeSignatures.map(t => `${t.tick}_${t.numerator}_${t.denominator}`).join(':'))
				.hex(),
			tempoMarkerCount: stats.tempoMarkerCount,
			effectiveLength: stats.noteSpanMs,
		},
	}
}

function calculateCanonicalIdentity(parsedChart: ParsedChart):
	| { readonly kind: 'accepted'; readonly chart: CanonicalParsedChart; readonly bundle: CanonicalSongBundle }
	| { readonly kind: 'rejected'; readonly error: string } {
	// The scanner's parse uses the canonical rules (E2) and the same settings, so the identity reuses it.
	const reusable = parsedCharts.get(parsedChart)
	const parsed = reusable
		? canonicalChartFromParse(parsedChart.format, reusable.parsed)
		: canonical20260801.parseSource({
			source: { format: parsedChart.format, bytes: parsedChart.chartBytes },
			modifiers: parsedChart.iniChartModifiers,
		})
	if (parsed.kind === 'rejected') return { kind: 'rejected', error: parsed.errors.map(error => error.message).join(' ') }
	try {
		return { kind: 'accepted', chart: parsed.chart, bundle: canonical20260801.calculateSongBundle({ chart: parsed.chart, metadata: parsedChart.songHashMetadata }) }
	} catch (error) {
		return { kind: 'rejected', error: error instanceof Error ? error.message : String(error) }
	}
}

function getChartHash(chartBytes: Uint8Array, iniChartModifiers: IniChartModifiers) {
	const hashedIniModifiers = (
		[
			{ name: 'hopo_frequency', value: iniChartModifiers.hopo_frequency },
			{ name: 'eighthnote_hopo', value: iniChartModifiers.eighthnote_hopo },
			{ name: 'multiplier_note', value: iniChartModifiers.multiplier_note },
			{ name: 'sustain_cutoff_threshold', value: iniChartModifiers.sustain_cutoff_threshold },
			{ name: 'chord_snap_threshold', value: iniChartModifiers.chord_snap_threshold },
			{ name: 'five_lane_drums', value: iniChartModifiers.five_lane_drums },
			{ name: 'pro_drums', value: iniChartModifiers.pro_drums },
		] as const
	)
		.filter(modifier => modifier.value !== defaultMetadata[modifier.name])
		.map(modifier => ({
			name: new TextEncoder().encode(modifier.name),
			value: int32ToUint8Array(
				typeof modifier.value === 'number' ? modifier.value
				: modifier.value === true ? 1
				: 0,
			),
		}))

	const hashedIniModifiersLength = _.sumBy(hashedIniModifiers, modifier => modifier.name.length + modifier.value.length)
	const buffer = new ArrayBuffer(chartBytes.length + hashedIniModifiersLength)
	const uint8Array = new Uint8Array(buffer)
	uint8Array.set(chartBytes)

	let offset = chartBytes.length
	for (const modifier of hashedIniModifiers) {
		uint8Array.set(modifier.name, offset)
		offset += modifier.name.length
		uint8Array.set(modifier.value, offset)
		offset += modifier.value.length
	}

	return base64url.stringify(blake3(uint8Array), { pad: false })
}

function int32ToUint8Array(num: number) {
	const buffer = new ArrayBuffer(4)
	const view = new DataView(buffer)
	view.setInt32(0, num, true)

	return new Uint8Array(buffer)
}

/**
 * Included for legacy testing purposes
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function legacyGetChartHash(chartBytes: Uint8Array, iniChartModifiers: IniChartModifiers) {
	const iniChartModifierSize = 4 + 1 + 4 + 4 + 1 + 1
	const buffer = new ArrayBuffer(chartBytes.length + iniChartModifierSize)
	const uint8Array = new Uint8Array(buffer)
	uint8Array.set(chartBytes)
	const view = new DataView(buffer, chartBytes.length)

	view.setInt32(0, iniChartModifiers.hopo_frequency, true)
	view.setInt8(4, iniChartModifiers.eighthnote_hopo ? 1 : 0)
	view.setInt32(5, iniChartModifiers.multiplier_note, true)
	view.setInt32(9, iniChartModifiers.sustain_cutoff_threshold, true)
	view.setInt8(13, iniChartModifiers.five_lane_drums ? 1 : 0)
	view.setInt8(14, iniChartModifiers.pro_drums ? 1 : 0)

	return base64url.stringify(blake3(uint8Array), { pad: false })
}
