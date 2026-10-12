/**
 * Writer round-trip corpus harness (plain ESM, runs under `node`, imports the
 * built dist so it needs no TS toolchain).
 *
 *   P1 = parseChartAndIni(files)
 *   P2 = parse(writeChartFolder(P1))      // fidelity vs P1
 *   P3 = parse(writeChartFolder(P2))      // idempotence vs P2  (the real bug signal)
 *
 * Usage:
 *   node test/corpus/roundtrip.mjs --input <dir> [--input <dir2>] [--limit N]
 */
import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const { parseChartAndIni, writeChartFolder, calculateTrackHash } = require(resolve(here, '../../dist/index.js'))

// --- args ---
const args = process.argv.slice(2)
const inputs = []
let limit = 3000, seed = 1
for (let i = 0; i < args.length; i++) {
	if (args[i] === '--input' || args[i] === '-i') inputs.push(args[++i])
	else if (args[i] === '--limit' || args[i] === '-n') limit = Number(args[++i])
	else if (args[i] === '--seed') seed = Number(args[++i])
}

const STUB = new Set(['mp3', 'ogg', 'opus', 'wav', 'mp4', 'webm', 'avi', 'mpeg', 'vp8', 'ogv'])
const ext = n => { const i = n.lastIndexOf('.'); return i < 0 ? '' : n.slice(i + 1).toLowerCase() }
const EMPTY = new Uint8Array(0)

async function loadChartFolderFiles(folder) {
	const entries = await readdir(folder, { withFileTypes: true })
	const files = []
	for (const e of entries) {
		if (!e.isFile() || /\.bchart$/i.test(e.name)) continue
		if (STUB.has(ext(e.name))) { files.push({ fileName: e.name, data: EMPTY }); continue }
		const buf = await readFile(join(folder, e.name))
		files.push({ fileName: e.name, data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) })
	}
	return files
}

async function collectChartDirs(root, out) {
	let entries
	try { entries = await readdir(root, { withFileTypes: true }) } catch { return }
	if (entries.some(e => e.isFile() && (e.name.toLowerCase() === 'notes.chart' || e.name.toLowerCase() === 'notes.mid'))) {
		out.push(root); return
	}
	for (const e of entries) if (e.isDirectory()) await collectChartDirs(join(root, e.name), out)
}

const trackKeys = c => c.trackData.map(t => `${t.instrument}:${t.difficulty}`)

function fingerprint(chart) {
	const parts = []
	for (const k of [...new Set(trackKeys(chart))].sort()) {
		const [inst, diff] = k.split(':')
		try { parts.push(`${k}=${calculateTrackHash(chart, inst, diff).hash}`) }
		catch { parts.push(`${k}=ERR`) }
	}
	const vt = chart.vocalTracks
	if (vt) for (const pn of Object.keys(vt.parts).sort()) {
		const p = vt.parts[pn]
		const notes = p.notePhrases.reduce((s, ph) => s + ph.notes.length, 0)
		const lyr = p.notePhrases.reduce((s, ph) => s + ph.lyrics.length, 0)
		const orphans = p.orphanNotes?.length ?? 0
		parts.push(`voc:${pn}=np${p.notePhrases.length},sl${p.staticLyricPhrases.length},n${notes},l${lyr},o${orphans},sp${p.starPowerSections.length}`)
	}
	return parts.join('|')
}

const roundTrip = p => parseChartAndIni(writeChartFolder({ parsedChart: p, assets: [] })).parsedChart

function firstDiff(a, b) {
	const A = a.split('|'), B = b.split('|')
	for (let i = 0; i < Math.max(A.length, B.length); i++) if (A[i] !== B[i]) return `'${A[i] ?? '<none>'}' vs '${B[i] ?? '<none>'}'`
	return `len ${A.length} vs ${B.length}`
}

const all = []
for (const r of inputs.map(x => resolve(x))) {
	if (!existsSync(r)) { console.error(`[roundtrip] missing input: ${r}`); continue }
	await collectChartDirs(r, all)
}
all.sort()
console.log(`[roundtrip] discovered ${all.length} chart folders`)

let chosen = all
if (limit > 0 && all.length > limit) {
	const stride = all.length / limit
	chosen = []
	for (let i = 0; i < limit; i++) chosen.push(all[Math.floor(i * stride + (seed % Math.max(1, Math.floor(stride))))])
}
console.log(`[roundtrip] testing ${chosen.length} charts\n`)

const stats = { total: 0, skippedNoParse: 0, writeCrash: 0, reparseNull: 0, trackSetMismatch: 0, fidelityMismatchP1P2: 0, nonIdempotent: 0, ok: 0 }
const failures = []
let i = 0
for (const dir of chosen) {
	i++
	if (i % 500 === 0) console.log(`  ...${i}/${chosen.length} (idempotence fails: ${stats.nonIdempotent}, write crashes: ${stats.writeCrash})`)
	stats.total++
	let p1
	try { p1 = parseChartAndIni(await loadChartFolderFiles(dir)).parsedChart } catch { stats.skippedNoParse++; continue }
	if (!p1) { stats.skippedNoParse++; continue }

	let p2
	try { p2 = roundTrip(p1) } catch (e) { stats.writeCrash++; failures.push({ dir, kind: 'writeCrash', detail: String(e?.message ?? e).slice(0, 200) }); continue }
	if (!p2) { stats.reparseNull++; failures.push({ dir, kind: 'reparseNull', detail: '' }); continue }

	const k1 = [...new Set(trackKeys(p1))].sort().join(','), k2 = [...new Set(trackKeys(p2))].sort().join(',')
	if (k1 !== k2) { stats.trackSetMismatch++; failures.push({ dir, kind: 'trackSetMismatch', detail: `P1[${k1}] != P2[${k2}]` }) }

	const f1 = fingerprint(p1), f2 = fingerprint(p2)
	if (f1 !== f2) stats.fidelityMismatchP1P2++

	let p3
	try { p3 = roundTrip(p2) } catch (e) { stats.nonIdempotent++; failures.push({ dir, kind: 'idempotentWriteCrash', detail: String(e?.message ?? e).slice(0, 200) }); continue }
	if (!p3) { stats.nonIdempotent++; failures.push({ dir, kind: 'idempotentReparseNull', detail: '' }); continue }
	const f3 = fingerprint(p3)
	if (f2 !== f3) { stats.nonIdempotent++; failures.push({ dir, kind: 'nonIdempotent', detail: firstDiff(f2, f3) }) }
	else stats.ok++
}

console.log(`\n===== round-trip summary =====`)
console.log(stats)
const realFails = failures.filter(f => f.kind !== 'trackSetMismatch' && f.kind !== 'fidelityMismatchP1P2')
console.log(`\nReal writer failures (crash / non-idempotent / null): ${realFails.length}`)
for (const f of failures.slice(0, 40)) console.log(`  [${f.kind}] ${f.dir.split('/').slice(-1)[0]} :: ${f.detail}`)
