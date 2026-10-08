import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseManifest, parseManifestV2, readManifest } from '../golden-vectors/schema'

const manifestPath = path.resolve('test/golden-vectors/suites/v2/manifest.json')

function approvedManifest() {
	return parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
}

describe('golden-vector manifest schema', () => {
	it('accepts the approved manifest', () => {
		expect(approvedManifest().vectors).toHaveLength(42)
	})

	it('rejects identity output attached to a rejected vector', () => {
		const manifest = approvedManifest()
		const rejected = manifest.vectors.find(vector => vector.kind === 'btrack-rejected')
		if (rejected === undefined) throw new Error('Approved manifest has no rejected vector')

		expect(() => parseManifest({
			...manifest,
			vectors: [{ ...rejected, expected: { trackHash: 'untrusted' } }],
		})).toThrow('does not match the schema')
	})

	it('rejects malformed nested artifact metadata', () => {
		const manifest = approvedManifest()
		const source = manifest.vectors.find(vector => vector.kind === 'source-accepted')
		if (source === undefined) throw new Error('Approved manifest has no source vector')

		expect(() => parseManifest({
			...manifest,
			vectors: [{ ...source, source: { ...source.source, sha256: 'not-a-sha256' } }],
		})).toThrow('does not match the schema')
	})
})

describe('golden-vector manifest schema version 2', () => {
	const file = (path: string) => ({ path, byteLength: 1, sha256: '0'.repeat(64) })
	const trackHash = 'A'.repeat(43)
	const modifiers = {
		song_length: 0, hopo_frequency: 0, eighthnote_hopo: false, multiplier_note: 0,
		sustain_cutoff_threshold: -1, chord_snap_threshold: 0, five_lane_drums: false, pro_drums: false,
	}
	const metadata = { name: 'N', artist: 'A', album: 'B', genre: 'G', year: 'Y', charter: 'C', icon: '' }
	const song = {
		kind: 'song-accepted',
		id: 'song',
		provenance: { kind: 'authored-minimal', author: 'test', license: 'MIT', purpose: 'test' },
		files: [{ name: 'notes.chart', file: file('song/input/notes.chart') }],
		expected: {
			selectedSource: 'notes.chart',
			modifiers,
			metadata: { selected: metadata, resolved: metadata },
			diagnostics: file('song/diagnostics.json'),
			songDuration: { contentLastTick: '0', endTick: '192', durationMs: '500' },
			members: [{
				instrument: 'guitar',
				difficulty: 'expert',
				parsedSemantics: file('song/members/semantics.json'),
				physicalBTrack: file('song/members/physical.btrack'),
				projection: file('song/members/projection.bin'),
				rawDigest: file('song/members/digest.bin'),
				trackHash,
				trackDuration: { lastNoteEndTick: '0', durationMs: '1' },
			}],
			preimage: file('song/preimage.chsh'),
			rawDigest: file('song/digest.bin'),
			songHash: trackHash,
		},
	}
	const manifest = (vectors: unknown[]) => ({
		schemaVersion: 2,
		contract: { profile: 'canonical-20260801', physical: 'CHNF/20260801', projection: 'ticket-03-map-first', songHash: 'CHSH/20260801' },
		compatibility: { vectorIdsAreImmutable: true, generatorMayOverwriteApprovedFixtures: false, canonicalHashEncoding: 'base64url-unpadded' },
		vectors,
	})

	it('reads either schema version', () => {
		expect(readManifest(JSON.parse(readFileSync(manifestPath, 'utf8'))).schemaVersion).toBe(1)
		expect(readManifest(manifest([song])).schemaVersion).toBe(2)
		expect(() => readManifest({ ...manifest([song]), schemaVersion: 3 })).toThrow('unsupported schemaVersion')
	})

	it('rejects a song vector that selects a file it does not have', () => {
		expect(() => parseManifestV2(manifest([{ ...song, expected: { ...song.expected, selectedSource: 'notes.mid' } }])))
			.toThrow('selects a source')
	})

	it('rejects legacy expectations on a canonical source vector', () => {
		const approved = approvedManifest().vectors.find(vector => vector.kind === 'source-accepted')
		if (approved === undefined) throw new Error('Approved manifest has no source vector')
		expect(() => parseManifestV2(manifest([approved]))).toThrow('does not match the schema')
	})
})
