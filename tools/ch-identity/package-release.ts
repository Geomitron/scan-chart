import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const runtimeNames = ['ch-identity.cjs', 'README.md']

function isolatedEnvironment(): NodeJS.ProcessEnv {
	const excluded = new Set(['node_path'])
	return Object.fromEntries(Object.entries(process.env)
		.filter(([name]) => !excluded.has(name.toLowerCase())))
}

async function packageAndVerifyArchive(output: string, archive: string): Promise<void> {
	await rm(archive, { force: true })
	execFileSync('tar.exe', ['-a', '-c', '-f', archive, '-C', output, '.'], { stdio: 'inherit' })
	const isolated = await mkdtemp(join(tmpdir(), 'ch-identity-release-'))
	try {
		execFileSync('tar.exe', ['-x', '-f', archive, '-C', isolated], { stdio: 'inherit' })
		execFileSync(process.execPath, [join(isolated, 'ch-identity.cjs'), 'self-test'], {
			cwd: isolated,
			env: isolatedEnvironment(),
			stdio: 'inherit',
		})
	} finally {
		await rm(isolated, { recursive: true, force: true })
	}
}

async function main(): Promise<void> {
	const output = join('dist', 'ch-identity')
	const archive = join('dist', 'ch-identity.zip')
	await copyFile(join('tools', 'ch-identity', 'README.md'), join(output, 'README.md'))
	const checksums: string[] = []
	for (const name of runtimeNames) {
		const bytes = await readFile(join(output, name))
		checksums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`)
	}
	await writeFile(join(output, 'SHA256SUMS'), `${checksums.join('\n')}\n`, 'utf8')
	await packageAndVerifyArchive(output, archive)
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
	process.exitCode = 1
})
