import { blake3 } from '@awasm/noble'

import { base64url } from 'rfc4648'

import { defaultMetadata } from '../ini/metadata'
import { IniChartModifiers } from './types'

/** BLAKE3 of the chart file and the non-default parse settings, as unpadded base64url. */
export function getChartHash(chartBytes: Uint8Array, iniChartModifiers: IniChartModifiers) {
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

	const hashedIniModifiersLength = hashedIniModifiers.reduce((length, modifier) => length + modifier.name.length + modifier.value.length, 0)
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
