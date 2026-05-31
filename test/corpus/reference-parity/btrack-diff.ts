import { readFile } from 'node:fs/promises'

import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'

import { decodeBTrack, diffBTracks } from '../shared/btrack'

const argv = yargs(hideBin(process.argv))
	.options({
		limit: { type: 'number', default: 50, describe: 'Maximum structural element diffs to print.' },
	})
	.help()
	.parseSync()

const positional = argv._.map(String)
if (positional.length !== 2) {
	console.error('Usage: btrack-diff.ts <file1> <file2> [--limit N]')
	process.exit(1)
}

void main()

/** CLI utility that decodes and structurally diffs two btrack files. */
async function main(): Promise<void> {
	const [pathA, pathB] = positional as [string, string]
	const a = new Uint8Array(await readFile(pathA))
	const b = new Uint8Array(await readFile(pathB))
	const decodedA = decodeBTrack(a)
	const decodedB = decodeBTrack(b)
	console.log(`A: ${pathA} (${a.byteLength} bytes)`)
	console.log(`B: ${pathB} (${b.byteLength} bytes)`)
	console.log(`header: A magic=0x${decodedA.magic.toString(16)} version=${decodedA.version} resolution=${decodedA.resolution}`)
	console.log(`header: B magic=0x${decodedB.magic.toString(16)} version=${decodedB.version} resolution=${decodedB.resolution}`)
	for (const diff of diffBTracks(a, b, argv.limit)) {
		console.log(`[${diff.section} ${diff.index}] tick=${diff.tick ?? '<none>'}`)
		console.log(`  A: ${JSON.stringify(diff.baseline)}`)
		console.log(`  B: ${JSON.stringify(diff.working)}`)
	}
}
