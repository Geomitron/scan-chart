import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { readBTrack20260801 } from 'src/chart/identity/btrack-20260801'
import { parseChartAndIni } from 'src/chart/parse-chart-and-ini'
import { scanParsedChart } from 'src/chart/scan-parsed-chart'

import { physicalCases, resolvedModifiers, songCases, sourceCases } from './cases'
import { canonicalPipeline, deriveCanonicalSourceCase, deriveSongCase, stableJson } from './derive'
import { FixtureFile, FixtureProvenance, GoldenManifestV2, GoldenVectorV2 } from './schema'

function outputArgument(): string {
	const index = process.argv.indexOf('--out')
	if (index < 0 || !process.argv[index + 1]) throw new Error('Usage: npm run vectors:generate -- --out <new-directory>')
	return path.resolve(process.argv[index + 1])
}

function isWithin(parent: string, child: string): boolean {
	const relative = path.relative(parent, child)
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** Fails generation when the BTrack writer and reader disagree on a generated Track. */
function assertReadable(id: string, physical: Uint8Array, trackHash: string): void {
	const read = readBTrack20260801(physical)
	if (read.kind !== 'accepted' || read.identity.trackHash.value !== trackHash) {
		throw new Error(`${id}: the canonical reader does not reproduce the written BTrack`)
	}
}

/** Writes a schema-version-2 draft suite: the canonical profile only, with song vectors. */
async function main(): Promise<void> {
	const output = outputArgument()
	const approvedRoot = path.resolve('test/golden-vectors/suites')
	if (isWithin(approvedRoot, output)) throw new Error('The generator cannot write inside the approved fixture tree')
	if (existsSync(output)) throw new Error(`Output directory already exists: ${output}`)
	await mkdir(path.dirname(output), { recursive: true })
	await mkdir(output)

	const artifact = async (relativePath: string, value: Uint8Array): Promise<FixtureFile> => {
		const absolute = path.join(output, relativePath)
		await mkdir(path.dirname(absolute), { recursive: true })
		await writeFile(absolute, value, { flag: 'wx' })
		return {
			path: relativePath.replaceAll('\\', '/'),
			byteLength: value.length,
			sha256: createHash('sha256').update(value).digest('hex'),
		}
	}

	const provenance = (purpose: string): FixtureProvenance => ({
		kind: 'authored-minimal',
		author: 'scan-chart migration maintainers',
		license: 'MIT',
		purpose,
	})
	const ids = new Set<string>()
	const claim = (id: string) => {
		if (ids.has(id)) throw new Error(`Duplicate vector id: ${id}`)
		ids.add(id)
	}
	const vectors: GoldenVectorV2[] = []

	for (const sourceCase of sourceCases) {
		claim(sourceCase.id)
		const modifiers = sourceCase.modifiers ?? resolvedModifiers
		const derived = deriveCanonicalSourceCase(sourceCase, modifiers)
		assertReadable(sourceCase.id, derived.physical, derived.trackHash)
		const root = `artifacts/${sourceCase.id}`
		vectors.push({
			kind: 'source-accepted',
			id: sourceCase.id,
			provenance: provenance(sourceCase.purpose),
			sourceFormat: sourceCase.format,
			source: await artifact(`${root}/source.${sourceCase.format === 'chart' ? 'chart' : 'mid'}`, sourceCase.bytes),
			modifiers,
			target: sourceCase.target,
			expected: {
				parsedSemantics: await artifact(`${root}/semantics.json`, stableJson(derived.semantics)),
				diagnostics: await artifact(`${root}/diagnostics.json`, stableJson(derived.diagnostics)),
				physicalBTrack: await artifact(`${root}/physical.btrack`, derived.physical),
				projection: await artifact(`${root}/projection.bin`, derived.projection),
				rawDigest: await artifact(`${root}/digest.bin`, derived.digest),
				trackHash: derived.trackHash,
			},
		})
	}

	for (const songCase of songCases) {
		claim(songCase.id)
		const derived = deriveSongCase(songCase.id, songCase.files)
		const scanned = parseChartAndIni(songCase.files.map(file => ({ fileName: file.name, data: file.bytes.slice() }))).parsedChart
		const scan = scanned === null ? null : scanParsedChart(scanned)
		if (scan?.songHash !== derived.songHash || String(scan.songDurationMs) !== derived.songDuration.durationMs) {
			throw new Error(`${songCase.id}: the scanner reports a different SongHash or song duration`)
		}
		const root = `artifacts/${songCase.id}`
		const files = []
		for (const file of songCase.files) files.push({ name: file.name, file: await artifact(`${root}/input/${file.name}`, file.bytes) })
		const members = []
		for (const [index, member] of derived.members.entries()) {
			assertReadable(songCase.id, member.physical, member.trackHash)
			const memberRoot = `${root}/members/${String(index).padStart(2, '0')}-${member.instrument}-${member.difficulty}`
			members.push({
				instrument: member.instrument,
				difficulty: member.difficulty,
				parsedSemantics: await artifact(`${memberRoot}/semantics.json`, stableJson(member.semantics)),
				physicalBTrack: await artifact(`${memberRoot}/physical.btrack`, member.physical),
				projection: await artifact(`${memberRoot}/projection.bin`, member.projection),
				rawDigest: await artifact(`${memberRoot}/digest.bin`, member.digest),
				trackHash: member.trackHash,
				trackDuration: member.trackDuration,
			})
		}
		vectors.push({
			kind: 'song-accepted',
			id: songCase.id,
			provenance: provenance(songCase.purpose),
			files,
			expected: {
				selectedSource: derived.selectedSource,
				modifiers: derived.modifiers,
				metadata: derived.metadata,
				diagnostics: await artifact(`${root}/diagnostics.json`, stableJson(derived.diagnostics)),
				songDuration: derived.songDuration,
				members,
				preimage: await artifact(`${root}/song/preimage.chsh`, derived.preimage),
				rawDigest: await artifact(`${root}/song/digest.bin`, derived.digest),
				songHash: derived.songHash,
			},
		})
	}

	for (const physicalCase of physicalCases) {
		claim(physicalCase.id)
		const root = `artifacts/${physicalCase.id}`
		const physicalBTrack = await artifact(`${root}/physical.btrack`, physicalCase.bytes)
		const read = readBTrack20260801(physicalCase.bytes)
		if (physicalCase.expected === 'accepted') {
			if (read.kind !== 'accepted') throw new Error(`${physicalCase.id}: expected accepted BTrack`)
			const derived = canonicalPipeline(read.identity, read.semantics)
			vectors.push({
				kind: 'btrack-accepted',
				id: physicalCase.id,
				provenance: provenance(physicalCase.purpose),
				physicalBTrack,
				expected: {
					parsedSemantics: await artifact(`${root}/semantics.json`, stableJson(derived.semantics)),
					projection: await artifact(`${root}/projection.bin`, derived.projection),
					rawDigest: await artifact(`${root}/digest.bin`, derived.digest),
					trackHash: derived.trackHash,
				},
			})
		} else {
			if (read.kind !== 'rejected') throw new Error(`${physicalCase.id}: expected rejected BTrack`)
			vectors.push({
				kind: 'btrack-rejected',
				id: physicalCase.id,
				provenance: provenance(physicalCase.purpose),
				physicalBTrack,
				expectedErrors: await artifact(`${root}/errors.json`, stableJson(read.errors)),
			})
		}
	}

	const manifest: GoldenManifestV2 = {
		schemaVersion: 2,
		contract: {
			profile: 'canonical-20260801',
			physical: 'CHNF/20260801',
			projection: 'ticket-03-map-first',
			songHash: 'CHSH/20260801',
		},
		compatibility: {
			vectorIdsAreImmutable: true,
			generatorMayOverwriteApprovedFixtures: false,
			canonicalHashEncoding: 'base64url-unpadded',
		},
		vectors,
	}
	await writeFile(path.join(output, 'manifest.json'), stableJson(manifest), { flag: 'wx' })
	console.log(`Generated ${vectors.length} vectors in ${output}`)
}

main().catch(error => {
	console.error(error instanceof Error ? error.message : error)
	process.exitCode = 1
})
