import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { base64url } from 'rfc4648'

import { readBTrack20260801 } from 'src/chart/identity/btrack-20260801'

import { deriveSourceCase, stableJson } from './derive'
import { FixtureFile, GoldenManifestV1, parseManifest } from './schema'

const suiteRoot = path.resolve('test/golden-vectors/suites/v1')

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index])
}

async function fixture(reference: FixtureFile): Promise<Uint8Array> {
	const absolute = path.resolve(suiteRoot, reference.path)
	const relative = path.relative(suiteRoot, absolute)
	if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Fixture escapes suite root: ${reference.path}`)
	const value = new Uint8Array(await readFile(absolute))
	if (value.length !== reference.byteLength) throw new Error(`${reference.path}: byte length mismatch`)
	const checksum = createHash('sha256').update(value).digest('hex')
	if (checksum !== reference.sha256) throw new Error(`${reference.path}: SHA-256 mismatch`)
	return value
}

function assertBytes(id: string, stage: string, actual: Uint8Array, expected: Uint8Array): void {
	if (!equalBytes(actual, expected)) throw new Error(`${id}: ${stage} bytes differ`)
}

async function manifest(): Promise<GoldenManifestV1> {
	return parseManifest(JSON.parse(await readFile(path.join(suiteRoot, 'manifest.json'), 'utf8')))
}

async function main(): Promise<void> {
	const suite = await manifest()
	for (const vector of suite.vectors) {
		if (vector.kind === 'source-accepted') {
			const source = await fixture(vector.source)
			const derived = deriveSourceCase({
				id: vector.id,
				purpose: vector.provenance.purpose,
				format: vector.sourceFormat,
				bytes: source,
				target: vector.target,
			}, vector.modifiers)
			for (const [name, expected, actual] of [
				['legacy6142', vector.expected.legacy6142, derived.legacy],
				['canonical20260801', vector.expected.canonical20260801, derived.canonical],
			] as const) {
				assertBytes(vector.id, `${name} semantics`, stableJson(actual.semantics), await fixture(expected.parsedSemantics))
				assertBytes(vector.id, `${name} diagnostics`, stableJson(actual.diagnostics), await fixture(expected.diagnostics))
				assertBytes(vector.id, `${name} physical`, actual.physical, await fixture(expected.physicalBTrack))
				assertBytes(vector.id, `${name} projection`, actual.projection, await fixture(expected.projection))
				assertBytes(vector.id, `${name} digest`, actual.digest, await fixture(expected.rawDigest))
				if (actual.trackHash !== expected.trackHash) throw new Error(`${vector.id}: ${name} TrackHash differs`)
			}
			const padded = base64url.stringify(derived.legacy.digest, { pad: true })
			if (padded !== vector.expected.legacy6142.publishedPaddedTrackHash) {
				throw new Error(`${vector.id}: published padded legacy string differs`)
			}
		} else {
			const physical = await fixture(vector.physicalBTrack)
			const read = readBTrack20260801(physical)
			if (vector.kind === 'btrack-rejected') {
				if (read.kind !== 'rejected') throw new Error(`${vector.id}: malformed BTrack was accepted`)
				assertBytes(vector.id, 'errors', stableJson(read.errors), await fixture(vector.expectedErrors))
			} else {
				if (read.kind !== 'accepted') throw new Error(`${vector.id}: valid BTrack was rejected`)
				assertBytes(vector.id, 'semantics', stableJson(read.semantics), await fixture(vector.expected.parsedSemantics))
				assertBytes(vector.id, 'projection', read.identity.projection.bytes, await fixture(vector.expected.projection))
				assertBytes(vector.id, 'digest', read.identity.digest.bytes, await fixture(vector.expected.rawDigest))
				if (read.identity.trackHash.value !== vector.expected.trackHash) throw new Error(`${vector.id}: TrackHash differs`)
			}
		}
		console.log(`ok ${vector.id}`)
	}
	console.log(`Verified ${suite.vectors.length} golden vectors`)
}

main().catch(error => {
	console.error(error instanceof Error ? error.message : error)
	process.exitCode = 1
})
