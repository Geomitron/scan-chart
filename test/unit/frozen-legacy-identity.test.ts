import { describe, expect, it } from 'vitest'

import { frozenLegacy6142 } from 'src/chart/identity/public'
import { parseChartFile } from 'src/chart/parse-chart-file'
import { calculateTrackHash } from 'src/chart/track-hasher'
import { defaultMetadata } from 'src/ini/metadata'

const source = new TextEncoder().encode([
	'[Song]',
	'{',
	'  Resolution = 192',
	'}',
	'[SyncTrack]',
	'{',
	'  0 = B 120001',
	'  0 = TS 4',
	'}',
	'[Events]',
	'{',
	'}',
	'[ExpertSingle]',
	'{',
	'  0 = N 0 0',
	'}',
	'',
].join('\r\n'))

const expectedPhysicalHex =
	'43484e46c0d73401c0000000010000000000000000000000f2d24d6210005e40' +
	'0100000000000000000000000400000004000000000000000000000000000000' +
	'0000000001000000000000000000000000000000000000000200000001000000'

describe('frozen legacy identity', () => {
	it('characterizes the pinned parser and TrackHash bytes', () => {
		const parsed = parseChartFile(source, 'chart')
		const identity = calculateTrackHash(parsed, 'guitar', 'expert')

		expect(parsed.resolution).toBe(192)
		expect(parsed.tempos.map(tempo => ({ tick: tempo.tick, beatsPerMinute: tempo.beatsPerMinute }))).toEqual([
			{ tick: 0, beatsPerMinute: 120.001 },
		])
		expect(parsed.timeSignatures.map(signature => ({
			tick: signature.tick,
			numerator: signature.numerator,
			denominator: signature.denominator,
		}))).toEqual([{ tick: 0, numerator: 4, denominator: 4 }])
		expect(Buffer.from(identity.btrack).toString('hex')).toBe(expectedPhysicalHex)
		expect(identity.hash).toBe('8xKtZjlIAXr9Cnd8cCTt6ka4Uo5CRBIY9bM73Qj7LWQ')
	})

	it('exposes the same calculation through an explicit profile', () => {
		const parsed = frozenLegacy6142.parseSource({
			source: { format: 'chart', bytes: source },
			modifiers: defaultMetadata,
		})

		expect(parsed.kind).toBe('accepted')
		if (parsed.kind !== 'accepted') return

		const identity = frozenLegacy6142.calculateTrackIdentity({
			chart: parsed.chart,
			instrument: 'guitar',
			difficulty: 'expert',
		})
		expect(identity.profile).toBe('clone-hero-1.1.0.6142')
		expect(identity.physicalBTrack.physicalVersion).toBe(20240320)
		expect(Buffer.from(identity.physicalBTrack.bytes).toString('hex')).toBe(expectedPhysicalHex)
		expect(Buffer.from(identity.projection.bytes).toString('hex')).toBe(expectedPhysicalHex)
		expect(Buffer.from(identity.digest.bytes).toString('hex')).toBe(
			'f312ad663948017afd0a777c7024edea46b8528e42441218f5b33bdd08fb2d64',
		)
		expect(identity.trackHash.value).toBe('8xKtZjlIAXr9Cnd8cCTt6ka4Uo5CRBIY9bM73Qj7LWQ')
	})

	it('does not expose mutable identity bytes', () => {
		const parsed = frozenLegacy6142.parseSource({
			source: { format: 'chart', bytes: source },
			modifiers: defaultMetadata,
		})
		if (parsed.kind !== 'accepted') throw new Error('Expected source to parse')

		const identity = frozenLegacy6142.calculateTrackIdentity({
			chart: parsed.chart,
			instrument: 'guitar',
			difficulty: 'expert',
		})
		const firstRead = identity.physicalBTrack.bytes
		firstRead[0] = 0

		expect(identity.physicalBTrack.bytes[0]).toBe(0x43)
		expect(identity.trackHash.value).toBe('8xKtZjlIAXr9Cnd8cCTt6ka4Uo5CRBIY9bM73Qj7LWQ')
	})
})
