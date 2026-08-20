import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseManifest } from '../golden-vectors/schema'

const manifestPath = path.resolve('test/golden-vectors/suites/v1/manifest.json')

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
