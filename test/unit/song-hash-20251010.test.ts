import { blake3 } from '@awasm/noble'
import { MidiData, writeMidi } from '@geomitron/midi-file'
import { base64url } from 'rfc4648'
import { describe, expect, it } from 'vitest'

import { canonical20260801, frozenLegacy6142, songBundle20251010 } from 'src/chart/identity/public'
import { historicalSongHashDurationMs } from 'src/chart/identity/duration-types'
import { serializeSongHash20251010 } from 'src/chart/identity/song-hash-20251010'
import { defaultMetadata } from 'src/ini/metadata'

const metadata = {
	name: 'White & Nerdy',
	artist: '"Weird Al" Yankovic',
	album: 'Straight Outta Lynwood',
	genre: 'Hip-Hop',
	year: '2006',
	charter: 'Arctan',
	icon: 'antihero2',
}

function chart(): Uint8Array {
	return new TextEncoder().encode([
		'[Song]',
		'{',
		'  Resolution = 192',
		'}',
		'[SyncTrack]',
		'{',
		'  0 = B 120000',
		'}',
		'[Events]',
		'{',
		'}',
		'[EasySingle]',
		'{',
		'  0 = N 0 0',
		'}',
		'[ExpertSingle]',
		'{',
		'  0 = N 0 0',
		'}',
		'[EasyGHLKeys]',
		'{',
		'  0 = N 0 0',
		'}',
	].join('\r\n'))
}

describe('SongHash 20251010', () => {
	it('retains empty and marker-only MIDI tracks only in legacy SongHash membership', () => {
		const conductor: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 },
			{ deltaTime: 0, type: 'endOfTrack' },
		]
		const guitar: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'trackName', text: 'PART GUITAR' },
			{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 },
			{ deltaTime: 192, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 },
			{ deltaTime: 0, type: 'endOfTrack' },
		]
		const bass: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'trackName', text: 'PART BASS' },
			{ deltaTime: 0, type: 'endOfTrack' },
		]
		const drums: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'trackName', text: 'PART DRUMS' },
			{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 116, velocity: 100 },
			{ deltaTime: 192, type: 'noteOff', channel: 0, noteNumber: 116, velocity: 0 },
			{ deltaTime: 0, type: 'endOfTrack' },
		]
		const result = songBundle20251010.calculate({
			source: { format: 'mid', bytes: new Uint8Array(writeMidi({
				header: { format: 1, numTracks: 4, ticksPerBeat: 192 },
				tracks: [conductor, guitar, bass, drums],
			})) },
			modifiers: defaultMetadata,
			legacyModifiers: defaultMetadata,
			legacyMetadata: metadata,
			canonicalMetadata: metadata,
			legacyDurationMs: historicalSongHashDurationMs(1000n),
		})
		expect(result.kind).toBe('accepted')
		if (result.kind !== 'accepted') return
		expect(result.frozenLegacy6142.tracks.map(track => `${track.instrument}:${track.difficulty}`))
			.toEqual(['guitar:expert', 'guitar:easy', 'bass:expert', 'drums:expert'])
		expect(result.canonical20260801.tracks.map(track => `${track.instrument}:${track.difficulty}`)).toEqual(['guitar:easy'])
		const drumTrack = result.frozenLegacy6142.tracks.find(track => track.instrument === 'drums')
		expect(drumTrack?.duration.durationMs).toBe(1n)
		expect(result.canonical20260801.duration.durationMs).toBe(1000n)
		if (result.frozenLegacy6142.song.kind !== 'available') throw new Error('Expected legacy identity')
		const withoutEmptyTracks = frozenLegacy6142.calculateSongIdentity({
			metadata, durationMs: historicalSongHashDurationMs(1000n),
			members: result.frozenLegacy6142.tracks.filter(track => track.difficulty === 'easy')
				.flatMap(track => track.instrument === 'keysghl' ? [] : [{ instrument: track.instrument, difficulty: track.difficulty, digest: track.identity.digest }]),
		})
		expect(result.frozenLegacy6142.song.identity.songHash.value).not.toBe(withoutEmptyTracks.songHash.value)
	})

	it('reproduces a pinned Clone Hero 1.1 SongHash', () => {
		const preimage = serializeSongHash20251010({
			metadata,
			durationMs: 173370n,
			members: [{
				instrumentId: 0,
				difficultyId: 0,
				digest: base64url.parse('8XRpyW62G8LKlGZj5w69EDMQP3ZxbJOy-0e0pRF5rSw=', { loose: false }),
			}],
		})
		expect(base64url.stringify(blake3(preimage), { pad: false })).toBe(
			'PrUQ9Jlt0J5wbZTdvM9cm8S-DNF_Aptg2bNUeDSVSAw',
		)
	})

	it('pins a canonical SongHash, which writes wire version 20260801', () => {
		const result = songBundle20251010.calculate({
			source: { format: 'chart', bytes: chart() },
			modifiers: defaultMetadata,
			legacyModifiers: defaultMetadata,
			legacyMetadata: metadata,
			canonicalMetadata: metadata,
		})
		if (result.kind !== 'accepted') throw new Error('Expected the chart to parse')
		const preimage = result.canonical20260801.song.preimage
		expect(Buffer.from(preimage.subarray(0, 8)).toString('hex')).toBe('43485348c1273501')
		expect(result.canonical20260801.song.songHash.value).toBe('447hp7JkPsiGwxl9N66r_SP8vIArZJhkObAqU-y1-do')
	})

	it('preserves signed-int64 duration bytes above the float precision boundary', () => {
		const preimage = serializeSongHash20251010({
			metadata: {
				name: 'Wi Wok De Tok',
				artist: 'Jokowi x Prabowo',
				album: 'ENDONESA MUNDUR',
				genre: 'Yapping',
				year: '9999',
				charter: 'Tidak Dikenal',
				icon: 'wikwok',
			},
			durationMs: 356400000n,
			members: [{
				instrumentId: 0,
				difficultyId: 0,
				digest: base64url.parse('4tEYx9yGJGJ82SEgb07HichgBi8VXuAnG_iezBol4oU=', { loose: false }),
			}],
		})
		expect(base64url.stringify(blake3(preimage), { pad: false })).toBe(
			'vTzVfrMiJuJmZofKdqpAnL6bWOhB3pmMWwt6YpJZ4l0',
		)
	})

	it('uses profile-specific ordering and omits GHL keys only from legacy SongHash', () => {
		const result = songBundle20251010.calculate({
			source: { format: 'chart', bytes: chart() },
			modifiers: defaultMetadata,
			legacyModifiers: defaultMetadata,
			legacyMetadata: metadata,
			canonicalMetadata: metadata,
			legacyDurationMs: historicalSongHashDurationMs(1000n),
		})
		expect(result.kind).toBe('accepted')
		if (result.kind !== 'accepted') return

		expect(result.frozenLegacy6142.tracks.map(track => [track.instrument, track.difficulty])).toEqual([
			['guitar', 'expert'],
			['guitar', 'easy'],
			['keysghl', 'easy'],
		])
		expect(result.canonical20260801.tracks.map(track => [track.instrument, track.difficulty])).toEqual([
			['guitar', 'easy'],
			['guitar', 'expert'],
			['keysghl', 'easy'],
		])
		expect(result.frozenLegacy6142.tracks.map(track => track.duration.durationMs)).toEqual([1n, 1n, 1n])
		expect(result.canonical20260801.tracks.map(track => track.duration.durationMs)).toEqual([1n, 1n, 1n])

		expect(result.frozenLegacy6142.song.kind).toBe('available')
		if (result.frozenLegacy6142.song.kind !== 'available') return
		const legacySong = result.frozenLegacy6142.song.identity
		expect(legacySong.members.map(member => member.instrument)).toEqual(['guitar', 'guitar'])
		const legacy = new DataView(legacySong.preimage.buffer, legacySong.preimage.byteOffset, legacySong.preimage.byteLength)
		const canonical = new DataView(
			result.canonical20260801.song.preimage.buffer,
			result.canonical20260801.song.preimage.byteOffset,
			result.canonical20260801.song.preimage.byteLength,
		)
		expect(legacy.getUint32(4, true)).toBe(20251010)
		expect(canonical.getUint32(4, true)).toBe(20260801)
		const legacyRecordsOffset = legacySong.preimage.byteLength - 80
		const canonicalRecordsOffset = result.canonical20260801.song.preimage.byteLength - 120
		expect(legacy.getUint32(legacyRecordsOffset, true)).toBe(0)
		expect(legacy.getUint32(legacyRecordsOffset + 4, true)).toBe(0)
		expect(canonical.getUint32(canonicalRecordsOffset, true)).toBe(0)
		expect(canonical.getUint32(canonicalRecordsOffset + 4, true)).toBe(0)
		expect(canonical.getUint32(canonicalRecordsOffset + 80, true)).toBe(10)
		expect(canonical.getUint32(canonicalRecordsOffset + 84, true)).toBe(0)
	})

	it('distinguishes null metadata defaults from present empty strings', () => {
		const nullName = serializeSongHash20251010({
			metadata: { ...metadata, name: null },
			durationMs: 0n,
			members: [],
		})
		const emptyName = serializeSongHash20251010({
			metadata: { ...metadata, name: '' },
			durationMs: 0n,
			members: [],
		})
		expect(new TextDecoder().decode(nullName)).toContain('Unknown Name')
		expect(new TextDecoder().decode(emptyName)).not.toContain('Unknown Name')
	})

	it('returns owned preimage and digest bytes', () => {
		const result = songBundle20251010.calculate({
			source: { format: 'chart', bytes: chart() },
			modifiers: defaultMetadata,
			legacyModifiers: defaultMetadata,
			legacyMetadata: metadata,
			canonicalMetadata: metadata,
			legacyDurationMs: historicalSongHashDurationMs(1000n),
		})
		expect(result.kind).toBe('accepted')
		if (result.kind !== 'accepted') return
		const originalPreimageByte = result.canonical20260801.song.preimage[0]
		const originalDigestByte = result.canonical20260801.song.digest[0]
		result.canonical20260801.song.preimage[0] ^= 0xff
		result.canonical20260801.song.digest[0] ^= 0xff
		expect(result.canonical20260801.song.preimage[0]).toBe(originalPreimageByte)
		expect(result.canonical20260801.song.digest[0]).toBe(originalDigestByte)
	})

	it('profile APIs impose wire order instead of trusting caller order', () => {
		const result = songBundle20251010.calculate({
			source: { format: 'chart', bytes: chart() },
			modifiers: defaultMetadata,
			legacyModifiers: defaultMetadata,
			legacyMetadata: metadata,
			canonicalMetadata: metadata,
			legacyDurationMs: historicalSongHashDurationMs(1000n),
		})
		expect(result.kind).toBe('accepted')
		if (result.kind !== 'accepted') return
		expect(result.frozenLegacy6142.song.kind).toBe('available')
		if (result.frozenLegacy6142.song.kind !== 'available') return
		const legacyMembers = result.frozenLegacy6142.tracks.flatMap(track => track.instrument === 'keysghl' ? [] : [{
			instrument: track.instrument,
			difficulty: track.difficulty,
			digest: track.identity.digest,
		}]).reverse()
		const canonicalMembers = result.canonical20260801.tracks.map(track => ({
			instrument: track.instrument,
			difficulty: track.difficulty,
			digest: track.identity.digest,
		})).reverse()
		expect(frozenLegacy6142.calculateSongIdentity({
			metadata,
			durationMs: historicalSongHashDurationMs(1000n),
			members: legacyMembers,
		}).songHash.value)
			.toBe(result.frozenLegacy6142.song.identity.songHash.value)
		expect(canonical20260801.calculateSongIdentity({
			metadata,
			durationMs: result.canonical20260801.duration.durationMs,
			members: canonicalMembers,
		}).songHash.value)
			.toBe(result.canonical20260801.song.songHash.value)
	})

	it('still produces canonical identity when historical duration is unavailable', () => {
		const result = songBundle20251010.calculate({
			source: { format: 'chart', bytes: chart() },
			modifiers: defaultMetadata,
			legacyModifiers: defaultMetadata,
			legacyMetadata: metadata,
			canonicalMetadata: metadata,
		})
		expect(result.kind).toBe('accepted')
		if (result.kind !== 'accepted') return
		expect(result.frozenLegacy6142.song).toEqual({
			kind: 'unavailable',
			reason: 'historicalDurationUnavailable',
		})
		expect(result.canonical20260801.duration.durationMs).toBe(500n)
	})
})
