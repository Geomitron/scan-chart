import { chartNormalizations, ChartNormalizationKind } from './chart/chart-normalize'
import { midiNormalizations, MidiNormalizationKind } from './chart/midi-normalize'
import { iniNormalizations, IniNormalizationKind } from './ini/ini-normalize'
import { resolveHistoricalDuration } from './chart/identity/historical-duration'
import { songBundle20251010 } from './chart/identity/public'
import { parseChartAndIni } from './chart/parse-chart-and-ini'
import { parseChartFileFrozenLegacyIdentity } from './chart/parse-chart-file'
import { ChartDocument, IniDocument, SongDocument, serializeSong } from './song-document'
import type { File } from './types'

/**
 * Every hash saving keeps unless an edit spends it (E7): each track's canonical and legacy TrackHash, and the
 * canonical and legacy SongHash, keyed like `canonical:guitar:expert` and `legacy:song`. The hashes are those of the
 * chart file and song.ini alone, as the reference tool calculates them. A legacy SongHash that needs the audio's
 * length is left out. `null` when the chart can't be parsed.
 *
 * Documents don't change, so a song's hashes are calculated once and kept with its chart document.
 */
export function songHashes(song: SongDocument): ReadonlyMap<string, string> | null {
	const { chart } = song
	if (chart === null) return null
	const songIni = song.files.find(file => file.fileName.toLowerCase() === 'song.ini') ?? null
	const fileNames = song.files.map(file => file.fileName).join('\n')
	const cached = hashCache.get(chart)
	if (cached && cached.ini === song.ini && cached.songIni === songIni && cached.fileNames === fileNames) return cached.hashes
	const hashes = calculateSongHashes(song, chart, songIni)
	hashCache.set(chart, { ini: song.ini, songIni, fileNames, hashes })
	return hashes
}

const hashCache = new WeakMap<ChartDocument, { ini: IniDocument | null; songIni: File | null; fileNames: string; hashes: ReadonlyMap<string, string> | null }>()

function calculateSongHashes(song: SongDocument, chart: ChartDocument, songIni: File | null): ReadonlyMap<string, string> | null {
	const chartBytes = chart.format === 'mid' ? chart.bytes : chart.tokens.bytes
	const files: File[] = [{ fileName: chart.format === 'mid' ? 'notes.mid' : 'notes.chart', data: chartBytes }]
	if (songIni !== null) files.push({ fileName: 'song.ini', data: song.ini?.fileName === songIni.fileName ? song.ini.tokens.bytes : songIni.data })
	const { parsedChart } = parseChartAndIni(files)
	if (parsedChart === null) return null

	const { format, iniChartModifiers, metadata } = parsedChart
	const legacyDuration = resolveHistoricalDuration(
		files[1]?.data ?? null,
		song.files.map(file => file.fileName),
		parseChartFileFrozenLegacyIdentity(chartBytes, format, iniChartModifiers),
	)
	const bundle = songBundle20251010.calculate({
		source: { format, bytes: chartBytes },
		modifiers: iniChartModifiers,
		legacyMetadata: {
			name: metadata.name ?? null,
			artist: metadata.artist ?? null,
			album: metadata.album ?? null,
			genre: metadata.genre ?? null,
			year: metadata.year ?? null,
			charter: metadata.charter ?? null,
			icon: metadata.icon ?? null,
		},
		canonicalMetadata: parsedChart.songHashMetadata,
		...(legacyDuration.kind === 'available' ? { legacyDurationMs: legacyDuration.durationMs } : {}),
	})
	if (bundle.kind === 'rejected') return null

	const hashes = new Map<string, string>()
	for (const track of bundle.frozenLegacy6142.tracks) hashes.set(`legacy:${track.instrument}:${track.difficulty}`, track.identity.trackHash.value)
	if (bundle.frozenLegacy6142.song.kind === 'available') hashes.set('legacy:song', bundle.frozenLegacy6142.song.identity.songHash.value)
	for (const track of bundle.canonical20260801.tracks) hashes.set(`canonical:${track.instrument}:${track.difficulty}`, track.identity.trackHash.value)
	hashes.set('canonical:song', bundle.canonical20260801.song.songHash.value)
	return hashes
}

/** One normalization of a song: of its chart file, in either format, or of its song.ini. */
export interface SongNormalization {
	readonly kind: ChartNormalizationKind | MidiNormalizationKind | IniNormalizationKind
	/** The section or MIDI track it rewrites, `song.ini`, or `null` for the whole chart file. */
	readonly section: string | null
	readonly apply: (song: SongDocument) => SongDocument
}

/** Every normalization a song needs: its chart file's, in its format, and its song.ini's. */
export function songNormalizations(song: SongDocument): SongNormalization[] {
	const normalizations: SongNormalization[] = []
	const { chart, ini } = song
	if (chart?.format === 'chart') {
		for (const { kind, section, apply } of chartNormalizations(chart.tokens)) {
			normalizations.push({
				kind,
				section,
				apply: current => current.chart?.format === 'chart' ? { ...current, chart: { ...current.chart, tokens: apply(current.chart.tokens) } } : current,
			})
		}
	} else if (chart?.format === 'mid' && chart.tokens !== null) {
		for (const { kind, section, apply } of midiNormalizations(chart.tokens)) {
			normalizations.push({
				kind,
				section,
				apply: current => {
					if (current.chart?.format !== 'mid' || current.chart.tokens === null) return current
					const tokens = apply(current.chart.tokens)
					return { ...current, chart: { ...current.chart, tokens, bytes: tokens.data } }
				},
			})
		}
	}
	if (ini !== null) {
		for (const { kind, apply } of iniNormalizations(ini.tokens)) {
			normalizations.push({
				kind,
				section: 'song.ini',
				apply: current => current.ini === null ? current : { ...current, ini: { ...current.ini, tokens: apply(current.ini.tokens) } },
			})
		}
	}
	return normalizations
}

/** What saving did. */
export interface SaveReport {
	/** The hashes the edits changed, which normalization may change too; `null` when there was nothing to normalize. */
	readonly spentHashes: readonly string[] | null
	readonly normalized: readonly { readonly kind: SongNormalization['kind']; readonly section: string | null }[]
	/** Normalizations left out because each would change a hash the edits didn't, listed with those hashes. */
	readonly withheld: readonly { readonly kind: SongNormalization['kind']; readonly section: string | null; readonly hashes: readonly string[] }[]
}

/**
 * Saves `edited`, a song edited from `original` (E7). An unedited song comes back byte for byte. An edited one is
 * also normalized wherever that changes no hash the edits left as it was:
 *
 * 1. The hashes before and after the edits are compared; each one that changed is spent.
 * 2. Every normalization is applied and the output read back. If no unspent hash changed, that's the result.
 * 3. Otherwise each normalization is tried on its own, and one that changes an unspent hash is left out.
 *
 * So the rule holds by checking the output, not by predicting what a normalization changes.
 */
export function saveSong(
	original: SongDocument,
	edited: SongDocument,
	normalizationsOf: (song: SongDocument) => readonly SongNormalization[] = songNormalizations,
): { files: File[]; report: SaveReport } {
	const unchanged = { spentHashes: null, normalized: [], withheld: [] }
	if (edited.chart === null || (edited.chart === original.chart && edited.ini === original.ini)) return { files: serializeSong(edited), report: unchanged }
	const normalizations = normalizationsOf(edited)
	if (normalizations.length === 0) return { files: serializeSong(edited), report: unchanged }
	const before = songHashes(original)
	const after = songHashes(edited)
	if (before === null || after === null) return { files: serializeSong(edited), report: unchanged }

	const spent = new Set([...before.keys(), ...after.keys()].filter(key => before.get(key) !== after.get(key)))
	/** The unspent hashes a version of the chart changes. */
	const unspentChanges = (song: SongDocument): string[] => {
		const hashes = songHashes(song)
		if (hashes === null) return ['(the chart no longer parses)']
		return [...new Set([...after.keys(), ...hashes.keys()])].filter(key => !spent.has(key) && hashes.get(key) !== after.get(key)).sort()
	}

	let song = edited
	for (const normalization of normalizations) song = normalization.apply(song)
	const normalized: SaveReport['normalized'][number][] = []
	const withheld: SaveReport['withheld'][number][] = []
	if (unspentChanges(song).length === 0) {
		for (const { kind, section } of normalizations) normalized.push({ kind, section })
	} else {
		song = edited
		for (const { kind, section, apply } of normalizations) {
			const candidate = apply(song)
			const changes = unspentChanges(candidate)
			if (changes.length === 0) {
				song = candidate
				normalized.push({ kind, section })
			} else {
				withheld.push({ kind, section, hashes: changes })
			}
		}
	}
	return { files: serializeSong(song), report: { spentHashes: [...spent].sort(), normalized, withheld } }
}
