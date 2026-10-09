import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { base64url } from 'rfc4648'

import { readBTrack20260801 } from 'src/chart/identity/btrack-20260801'

import { deriveCanonicalSourceCase, deriveSongCase, deriveSourceCase, stableJson } from './derive'
import { BTrackAcceptedVector, BTrackRejectedVector, FixtureFile, GoldenManifestV1, GoldenManifestV2, readManifest } from './schema'

/** The approved suite that `npm run vectors:verify` checks. Promoting a new suite changes only this line. */
const currentSuite = 'v3'

function suiteArgument(): string {
	const index = process.argv.indexOf('--suite')
	if (index < 0) return path.resolve('test/golden-vectors/suites', currentSuite)
	if (!process.argv[index + 1]) throw new Error('Usage: npm run vectors:verify [-- --suite <suite-directory>]')
	return path.resolve(process.argv[index + 1])
}

const suiteRoot = suiteArgument()

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

function assertJson(id: string, stage: string, actual: unknown, expected: unknown): void {
	assertBytes(id, stage, stableJson(actual), stableJson(expected))
}

async function verifyBTrack(vector: BTrackAcceptedVector | BTrackRejectedVector): Promise<void> {
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

/** Schema version 1: suites v1 and v2, with the legacy and canonical source pipelines. */
async function verifySchemaV1(suite: GoldenManifestV1): Promise<void> {
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
			await verifyBTrack(vector)
		}
		console.log(`ok ${vector.id}`)
	}
}

/** Schema version 2: suite v3 onward, canonical profile only, with song vectors. */
async function verifySchemaV2(suite: GoldenManifestV2): Promise<void> {
	for (const vector of suite.vectors) {
		if (vector.kind === 'source-accepted') {
			const actual = deriveCanonicalSourceCase({
				id: vector.id,
				purpose: vector.provenance.purpose,
				format: vector.sourceFormat,
				bytes: await fixture(vector.source),
				target: vector.target,
			}, vector.modifiers)
			const expected = vector.expected
			assertBytes(vector.id, 'semantics', stableJson(actual.semantics), await fixture(expected.parsedSemantics))
			assertBytes(vector.id, 'diagnostics', stableJson(actual.diagnostics), await fixture(expected.diagnostics))
			assertBytes(vector.id, 'physical', actual.physical, await fixture(expected.physicalBTrack))
			assertBytes(vector.id, 'projection', actual.projection, await fixture(expected.projection))
			assertBytes(vector.id, 'digest', actual.digest, await fixture(expected.rawDigest))
			if (actual.trackHash !== expected.trackHash) throw new Error(`${vector.id}: TrackHash differs`)
		} else if (vector.kind === 'song-accepted') {
			const inputs = []
			for (const file of vector.files) inputs.push({ name: file.name, bytes: await fixture(file.file) })
			const actual = deriveSongCase(vector.id, inputs)
			const expected = vector.expected
			if (actual.selectedSource !== expected.selectedSource) throw new Error(`${vector.id}: selected source differs`)
			assertJson(vector.id, 'modifiers', actual.modifiers, expected.modifiers)
			assertJson(vector.id, 'selected metadata', actual.metadata.selected, expected.metadata.selected)
			assertJson(vector.id, 'resolved metadata', actual.metadata.resolved, expected.metadata.resolved)
			assertBytes(vector.id, 'diagnostics', stableJson(actual.diagnostics), await fixture(expected.diagnostics))
			assertJson(vector.id, 'song duration', actual.songDuration, expected.songDuration)
			if (actual.members.length !== expected.members.length) throw new Error(`${vector.id}: SongHash member count differs`)
			for (const [index, member] of expected.members.entries()) {
				const derived = actual.members[index]
				const stage = `member ${index} (${member.instrument}/${member.difficulty})`
				if (derived.instrument !== member.instrument || derived.difficulty !== member.difficulty) {
					throw new Error(`${vector.id}: ${stage} is ${derived.instrument}/${derived.difficulty}`)
				}
				assertBytes(vector.id, `${stage} semantics`, stableJson(derived.semantics), await fixture(member.parsedSemantics))
				assertBytes(vector.id, `${stage} physical`, derived.physical, await fixture(member.physicalBTrack))
				assertBytes(vector.id, `${stage} projection`, derived.projection, await fixture(member.projection))
				assertBytes(vector.id, `${stage} digest`, derived.digest, await fixture(member.rawDigest))
				if (derived.trackHash !== member.trackHash) throw new Error(`${vector.id}: ${stage} TrackHash differs`)
				assertJson(vector.id, `${stage} duration`, derived.trackDuration, member.trackDuration)
			}
			assertBytes(vector.id, 'SongHash preimage', actual.preimage, await fixture(expected.preimage))
			assertBytes(vector.id, 'SongHash digest', actual.digest, await fixture(expected.rawDigest))
			if (actual.songHash !== expected.songHash) throw new Error(`${vector.id}: SongHash differs`)
		} else {
			await verifyBTrack(vector)
		}
		console.log(`ok ${vector.id}`)
	}
}

async function main(): Promise<void> {
	const suite = readManifest(JSON.parse(await readFile(path.join(suiteRoot, 'manifest.json'), 'utf8')))
	if (suite.schemaVersion === 1) await verifySchemaV1(suite)
	else await verifySchemaV2(suite)
	console.log(`Verified ${suite.vectors.length} golden vectors`)
}

main().catch(error => {
	console.error(error instanceof Error ? error.message : error)
	process.exitCode = 1
})
