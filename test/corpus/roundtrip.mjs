/* global console, process */
/**
 * Writer round-trip corpus harness (plain ESM, runs under `node`, imports the
 * built dist so it needs no TS toolchain).
 *
 *   P1 = parse(the chart folder)
 *   P2 = parse(writeChartFolder(P1))      // fidelity: identity of P1 kept
 *   P3 = parse(writeChartFolder(P2))      // idempotence: identity of P2 kept
 *
 * Identity is what `scanChart` reports from the canonical 20260801 profile: the
 * SongHash, the song duration and each track's TrackHash, plus vocal counts.
 * Every folder holding notes.chart or notes.mid is a chart, including one
 * nested inside another chart's folder, as Clone Hero reads them.
 *
 * Usage:
 *   node test/corpus/roundtrip.mjs --input <dir> [--input <dir2>] [--limit N]
 *     [--list <file>] [--shard K --shards N] [--failures <file.jsonl>]
 * --list reads chart folders from a file, one per line, instead of searching --input.
 * --limit 0 tests every chart. --shard/--shards splits the charts across
 * parallel runs. --failures writes one JSON line per failure.
 */
import { appendFileSync, existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const { parseChartAndIni, scanChart, writeChartFolder } = require(resolve(here, '../../dist/index.js'))

const args = process.argv.slice(2)
const inputs = []
let limit = 3000, seed = 1, shard = 0, shards = 1, failuresFile = null, listFile = null
for (let i = 0; i < args.length; i++) {
	if (args[i] === '--input' || args[i] === '-i') inputs.push(args[++i])
	else if (args[i] === '--limit' || args[i] === '-n') limit = Number(args[++i])
	else if (args[i] === '--seed') seed = Number(args[++i])
	else if (args[i] === '--shard') shard = Number(args[++i])
	else if (args[i] === '--shards') shards = Number(args[++i])
	else if (args[i] === '--failures') failuresFile = args[++i]
	else if (args[i] === '--list') listFile = args[++i]
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
	if (entries.some(e => e.isFile() && /^notes\.(chart|mid)$/i.test(e.name))) out.push(root)
	for (const e of entries) if (e.isDirectory()) await collectChartDirs(join(root, e.name), out)
}

const scan = files => {
	const parsed = parseChartAndIni(files)
	return parsed.parsedChart ? { parsedChart: parsed.parsedChart, scanned: scanChart(files, parsed) } : null
}

/** Each identity part as `name=value`, so a difference names what changed. */
function fingerprint({ parsedChart, scanned }) {
	const parts = [`songHash=${scanned.songHash}`, `songDurationMs=${scanned.songDurationMs}`]
	const tracks = (scanned.notesData?.trackHashes ?? []).map(t => `track:${t.instrument}:${t.difficulty}=${t.hash}`)
	parts.push(...tracks.sort())
	const vt = parsedChart.vocalTracks
	if (vt) for (const pn of Object.keys(vt.parts).sort()) {
		const p = vt.parts[pn]
		const notes = p.notePhrases.reduce((s, ph) => s + ph.notes.length, 0)
		const lyr = p.notePhrases.reduce((s, ph) => s + ph.lyrics.length, 0)
		const orphans = p.orphanNotes?.length ?? 0
		parts.push(`vocals:${pn}=np${p.notePhrases.length},sl${p.staticLyricPhrases.length},n${notes},l${lyr},o${orphans},sp${p.starPowerSections.length}`)
	}
	return parts
}

/** The identity parts that changed, by kind: songHash, songDurationMs, track, vocals. */
function differences(a, b) {
	const A = new Map(a.map(p => [p.slice(0, p.indexOf('=')), p])), B = new Map(b.map(p => [p.slice(0, p.indexOf('=')), p]))
	const changed = []
	for (const key of new Set([...A.keys(), ...B.keys()])) {
		if (A.get(key) !== B.get(key)) changed.push(`${A.get(key) ?? `${key}=<none>`} -> ${B.get(key) ?? '<none>'}`)
	}
	return changed
}

const kindOf = changed => [...new Set(changed.map(c => c.slice(0, c.search(/[:=]/))))].sort().join('+')
const writeAndScan = state => scan(writeChartFolder({ parsedChart: state.parsedChart, assets: [] }))

const all = []
for (const r of inputs.map(x => resolve(x))) {
	if (!existsSync(r)) { console.error(`[roundtrip] missing input: ${r}`); continue }
	await collectChartDirs(r, all)
}
if (listFile) all.push(...(await readFile(listFile, 'utf8')).split(/\r?\n/).filter(Boolean))
all.sort()
console.log(`[roundtrip] discovered ${all.length} chart folders`)

let chosen = all
if (limit > 0 && all.length > limit) {
	const stride = all.length / limit
	chosen = []
	for (let i = 0; i < limit; i++) chosen.push(all[Math.floor(i * stride + (seed % Math.max(1, Math.floor(stride))))])
}
chosen = chosen.filter((_, i) => i % shards === shard)
console.log(`[roundtrip] testing ${chosen.length} charts (shard ${shard} of ${shards})\n`)

const stats = { total: 0, skippedNoParse: 0, writeCrash: 0, reparseNull: 0, identityChanged: 0, nonIdempotent: 0, ok: 0 }
const changedKinds = {}
const failures = []
const fail = failure => {
	failures.push(failure)
	if (failuresFile) appendFileSync(failuresFile, JSON.stringify(failure) + '\n')
}
let i = 0
for (const dir of chosen) {
	i++
	if (i % 500 === 0) console.log(`progress ${i}/${chosen.length} (identity changed: ${stats.identityChanged}, write crashes: ${stats.writeCrash}, not idempotent: ${stats.nonIdempotent})`)
	stats.total++
	let p1
	try { p1 = scan(await loadChartFolderFiles(dir)) } catch { stats.skippedNoParse++; continue }
	if (!p1) { stats.skippedNoParse++; continue }

	let p2
	try { p2 = writeAndScan(p1) } catch (e) { stats.writeCrash++; fail({ dir, kind: 'writeCrash', detail: String(e?.message ?? e).slice(0, 200) }); continue }
	if (!p2) { stats.reparseNull++; fail({ dir, kind: 'reparseNull', detail: '' }); continue }

	const changed = differences(fingerprint(p1), fingerprint(p2))
	if (changed.length > 0) {
		stats.identityChanged++
		const kind = kindOf(changed)
		changedKinds[kind] = (changedKinds[kind] ?? 0) + 1
		fail({ dir, kind: `identityChanged:${kind}`, detail: changed.slice(0, 6) })
	}

	let p3
	try { p3 = writeAndScan(p2) } catch (e) { stats.nonIdempotent++; fail({ dir, kind: 'idempotentWriteCrash', detail: String(e?.message ?? e).slice(0, 200) }); continue }
	if (!p3) { stats.nonIdempotent++; fail({ dir, kind: 'idempotentReparseNull', detail: '' }); continue }
	const unstable = differences(fingerprint(p2), fingerprint(p3))
	if (unstable.length > 0) { stats.nonIdempotent++; fail({ dir, kind: 'nonIdempotent', detail: unstable.slice(0, 6) }) }
	else if (changed.length === 0) stats.ok++
}

console.log('\n===== round-trip summary =====')
console.log(JSON.stringify({ ...stats, changedKinds }))
for (const f of failures.slice(0, 40)) console.log(`  [${f.kind}] ${f.dir.split(/[\\/]/).slice(-1)[0]} :: ${JSON.stringify(f.detail)}`)
