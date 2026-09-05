#!/usr/bin/env node

import { blake3 } from '@awasm/noble'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { base64url } from 'rfc4648'

import { serializeSongHash20251010 } from '../../src/chart/identity/song-hash-20251010'
import { generate, inspectBTrack } from './generate'

const help = `ch-identity

Generate canonical and frozen-legacy SongHash, TrackHash, and BTrack artifacts.

Usage:
  ch-identity generate <song-folder-or-library-root> --out <new-directory>
  ch-identity inspect-btrack <canonical.btrack> --out <new-directory>
  ch-identity compare <reference-manifest.json> <candidate-manifest.json>
  ch-identity self-test
`

function option(args: readonly string[], name: string): string {
	const index = args.indexOf(name)
	if (index < 0 || index + 1 >= args.length) throw new Error(`Missing required ${name} option`)
	return args[index + 1]
}

async function selfTest(): Promise<void> {
	const preimage = serializeSongHash20251010({
		metadata: {
			name: 'White & Nerdy',
			artist: '"Weird Al" Yankovic',
			album: 'Straight Outta Lynwood',
			genre: 'Hip-Hop',
			year: '2006',
			charter: 'Arctan',
			icon: 'antihero2',
		},
		durationMs: 173370n,
		members: [{
			instrumentId: 0,
			difficultyId: 0,
			digest: base64url.parse('8XRpyW62G8LKlGZj5w69EDMQP3ZxbJOy-0e0pRF5rSw=', { loose: false }),
		}],
	})
	const songHash = base64url.stringify(blake3(preimage), { pad: false })
	if (songHash !== 'PrUQ9Jlt0J5wbZTdvM9cm8S-DNF_Aptg2bNUeDSVSAw') {
		throw new Error(`Pinned SongHash vector failed: ${songHash}`)
	}

	const temporary = await mkdtemp(join(tmpdir(), 'ch-identity-self-test-'))
	try {
		const song = join(temporary, 'song')
		const output = join(temporary, 'output')
		await mkdir(song)
		await writeFile(join(song, 'notes.chart'), [
			'[Song]', '{', '  Resolution = 192', '  Name = "Self Test"', '}',
			'[SyncTrack]', '{', '  0 = B 120000', '}',
			'[Events]', '{', '}',
			'[ExpertSingle]', '{', '  0 = N 0 192', '}',
		].join('\r\n'))
		await writeFile(join(song, 'song.ini'), '[song]\r\nsong_length = 1001\r\n')
		const result = await generate(song, output)
		if (result.results.length !== 1 || result.results[0].kind !== 'success') {
			throw new Error(`Folder generation self-test failed: ${JSON.stringify(result.results)}`)
		}
		const manifest = await readFile(join(output, 'song', 'manifest.json'), 'utf8')
		if (!manifest.includes('"definition": "strikecore-all-track-last-note-plus-one-beat-v1"')
			|| !manifest.includes('"durationMs": "1000"')
			|| !manifest.includes('"definition": "strikecore-selected-track-last-note-v1"')
			|| !manifest.includes('"durationMs": "500"')
			|| !manifest.includes('"source": "song.ini:song_length"')
			|| !manifest.includes('"durationMs": "1001"')) {
			throw new Error('Folder generation self-test did not keep canonical and historical durations separate')
		}
		if (!manifest.includes('"sourceTreeSha256"')) {
			throw new Error('Folder generation self-test did not record source-tree provenance')
		}
		const btrack = join(output, 'song', 'canonical20260801', 'tracks', '000-guitar-expert', 'physical.btrack')
		const inspected = join(temporary, 'inspected')
		await inspectBTrack(btrack, inspected)
		const inspectionManifest = await readFile(join(inspected, 'manifest.json'), 'utf8')
		if (!inspectionManifest.includes('"profile": "canonical20260801"')
			|| !inspectionManifest.includes('"definition": "strikecore-selected-track-last-note-v1"')
			|| !inspectionManifest.includes('"durationMs": "500"')
			|| !inspectionManifest.includes('"sourceTreeSha256"')) {
			throw new Error('BTrack inspection self-test did not record canonical identity provenance')
		}
	} finally {
		await rm(temporary, { recursive: true, force: true })
	}
}

function collectDifferences(reference: unknown, candidate: unknown, path = '$'): string[] {
	if (Object.is(reference, candidate)) return []
	if (typeof reference !== 'object' || reference === null || typeof candidate !== 'object' || candidate === null) {
		return [`${path}: ${JSON.stringify(reference)} != ${JSON.stringify(candidate)}`]
	}
	if (Array.isArray(reference) || Array.isArray(candidate)) {
		if (!Array.isArray(reference) || !Array.isArray(candidate)) return [`${path}: value kinds differ`]
		const differences: string[] = []
		const length = Math.max(reference.length, candidate.length)
		for (let index = 0; index < length; index++) {
			differences.push(...collectDifferences(reference[index], candidate[index], `${path}[${index}]`))
		}
		return differences
	}
	const referenceRecord = Object.keys(reference).map(key => [key, Reflect.get(reference, key)] satisfies [string, unknown])
	const candidateRecord = Object.keys(candidate).map(key => [key, Reflect.get(candidate, key)] satisfies [string, unknown])
	const keys = [...new Set([...referenceRecord.map(([key]) => key), ...candidateRecord.map(([key]) => key)])].sort()
	const referenceMap = new Map(referenceRecord)
	const candidateMap = new Map(candidateRecord)
	return keys.flatMap(key => collectDifferences(referenceMap.get(key), candidateMap.get(key), `${path}.${key}`))
}

async function compare(referencePath: string, candidatePath: string): Promise<boolean> {
	const reference: unknown = JSON.parse(await readFile(referencePath, 'utf8'))
	const candidate: unknown = JSON.parse(await readFile(candidatePath, 'utf8'))
	const differences = collectDifferences(reference, candidate)
	if (differences.length === 0) return true
	for (const difference of differences.slice(0, 100)) process.stderr.write(`${difference}\n`)
	if (differences.length > 100) process.stderr.write(`... ${differences.length - 100} more differences\n`)
	return false
}

async function main(args: readonly string[]): Promise<number> {
	const command = args[0]
	if (command === undefined || command === '--help' || command === '-h') {
		process.stdout.write(help)
		return 0
	}
	if (command === 'generate') {
		if (!args[1]) throw new Error('Missing song folder or library root')
		const result = await generate(args[1], option(args, '--out'))
		const failures = result.results.filter(item => item.kind === 'failure')
		process.stdout.write(`Generated ${result.results.length - failures.length} of ${result.results.length} song folders in ${result.outputDirectory}\n`)
		for (const failure of failures) process.stderr.write(`${failure.path}: ${failure.error}\n`)
		return failures.length === 0 ? 0 : 1
	}
	if (command === 'inspect-btrack') {
		if (!args[1]) throw new Error('Missing canonical BTrack path')
		await inspectBTrack(args[1], option(args, '--out'))
		return 0
	}
	if (command === 'compare') {
		if (!args[1] || !args[2]) throw new Error('compare requires reference and candidate manifest paths')
		return await compare(args[1], args[2]) ? 0 : 1
	}
	if (command === 'self-test') {
		await selfTest()
		process.stdout.write('Self-test passed\n')
		return 0
	}
	throw new Error(`Unknown command: ${command}\n\n${help}`)
}

main(process.argv.slice(2))
	.then(code => { process.exitCode = code })
	.catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
		process.exitCode = 2
	})
