/**
 * Tests for createEmptyChart: the programmatic-build counterpart to parseChartAndIni.
 */

import { describe, expect, it } from 'vitest'

import { createEmptyChart } from '../chart/create-chart'
import { defaultIniChartModifiers } from '../chart/note-parsing-interfaces'

describe('createEmptyChart', () => {
	it('uses defaults when no options are provided', () => {
		const chart = createEmptyChart()

		expect(chart.resolution).toBe(480)
		expect(chart.tempos).toEqual([{ tick: 0, beatsPerMinute: 120, msTime: 0 }])
		expect(chart.timeSignatures).toEqual([
			{ tick: 0, numerator: 4, denominator: 4, msTime: 0, msLength: 0 },
		])
		expect(chart.format).toBe('chart')
	})

	it('honors resolution, bpm, and time signature overrides', () => {
		const chart = createEmptyChart({
			resolution: 192,
			bpm: 150,
			timeSignature: { numerator: 6, denominator: 8 },
		})

		expect(chart.resolution).toBe(192)
		expect(chart.tempos[0].beatsPerMinute).toBe(150)
		expect(chart.timeSignatures[0]).toMatchObject({ numerator: 6, denominator: 8 })
	})

	it('honors format override', () => {
		const chart = createEmptyChart({ format: 'mid' })
		expect(chart.format).toBe('mid')
	})

	it('produces a chart with empty metadata, tracks, and sections', () => {
		const chart = createEmptyChart()

		expect(chart.metadata).toEqual({})
		expect(chart.drumType).toBeNull()
		expect(chart.trackData).toEqual([])
		expect(chart.sections).toEqual([])
		expect(chart.endEvents).toEqual([])
		expect(chart.unrecognizedEventsTrackTextEvents).toEqual([])
		expect(chart.unrecognizedEventsTrackMidiEvents).toEqual([])
		expect(chart.unrecognizedMidiTracks).toEqual([])
		expect(chart.unrecognizedChartSections).toEqual([])
		expect(chart.unrecognizedSyncTrackEvents).toEqual([])
		expect(chart.parseIssues).toEqual([])
	})

	it('produces a chart with empty vocal tracks', () => {
		const chart = createEmptyChart()
		expect(chart.vocalTracks).toEqual({ parts: {}, rangeShifts: [], lyricShifts: [] })
	})

	it('produces a chart with empty chartBytes and default ini modifiers', () => {
		const chart = createEmptyChart()
		expect(chart.chartBytes).toBeInstanceOf(Uint8Array)
		expect(chart.chartBytes.length).toBe(0)
		expect(chart.iniChartModifiers).toBe(defaultIniChartModifiers)
	})
})
