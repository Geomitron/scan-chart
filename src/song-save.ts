import { chartNormalizations, ChartNormalizationKind } from './chart/chart-normalize'
import { midiNormalizations, MidiNormalizationKind } from './chart/midi-normalize'
import { deprecatedTagNormalizations, DeprecatedTagNormalizationKind } from './deprecated-tags'
import { iniNormalizations, IniNormalizationKind } from './ini/ini-normalize'
import { SongDocument, documentFiles } from './song-document'
import { songHashes } from './song-hashes'
import { songSectionAgreement } from './song-section'
import type { SongFile } from './song-files'

/**
 * One normalization of a song: of its chart file, in either format, of its song.ini, of the deprecated song.ini tags it
 * can do without, or of a `.chart` `[Song]` section that disagrees with song.ini (`songSection`).
 */
export interface SongNormalization {
	readonly kind: ChartNormalizationKind | MidiNormalizationKind | IniNormalizationKind | DeprecatedTagNormalizationKind | 'songSection'
	/**
	 * The section or MIDI track it rewrites, `song.ini`, or `null` for the whole chart file. A deprecated tag's rewrite
	 * is `song.ini`'s, though the chart can change with it.
	 */
	readonly section: string | null
	readonly apply: (song: SongDocument) => SongDocument
}

/**
 * Every normalization a song needs: its chart file's, in its format, its song.ini's, and the rewrites that leave its
 * deprecated song.ini tags (`deprecatedTagNormalizations`).
 */
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
	normalizations.push(...deprecatedTagNormalizations(song))
	// Last, so it compares the other normalizations' output.
	if (songSectionAgreement(song) !== null) {
		normalizations.push({ kind: 'songSection', section: 'Song', apply: current => songSectionAgreement(current) ?? current })
	}
	return normalizations
}

/** What saving did. The hashes it names are the canonical ones, keyed as `songHashes` keys them. */
export interface SaveReport {
	/** The hashes the edits changed, which normalization may change too; `null` when there was nothing to normalize. */
	readonly spentHashes: readonly string[] | null
	readonly normalized: readonly { readonly kind: SongNormalization['kind']; readonly section: string | null }[]
	/** Normalizations left out because each would change a hash the edits didn't, listed with those hashes. */
	readonly withheld: readonly { readonly kind: SongNormalization['kind']; readonly section: string | null; readonly hashes: readonly string[] }[]
}

const unchangedReport: SaveReport = { spentHashes: null, normalized: [], withheld: [] }

/**
 * Saves `edited`, a song edited from `original` (E7). An unedited song comes back byte for byte. An edited one is
 * also normalized wherever that changes no canonical hash the edits left as it was (`songHashes`); a legacy hash may
 * change:
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
): { files: SongFile[]; report: SaveReport } {
	if (edited.chart === original.chart && edited.ini === original.ini) return { files: documentFiles(edited), report: unchangedReport }
	return saveEdited(edited, () => songHashes(original), normalizationsOf)
}

/** `saveSong` for an edited song, given the original's hashes, which are asked for only if there's something to normalize. */
export function saveEdited(
	edited: SongDocument,
	originalHashes: () => ReadonlyMap<string, string> | null,
	normalizationsOf: (song: SongDocument) => readonly SongNormalization[] = songNormalizations,
): { files: SongFile[]; report: SaveReport } {
	const unchanged = unchangedReport
	if (edited.chart === null) return { files: documentFiles(edited), report: unchanged }
	const normalizations = normalizationsOf(edited)
	if (normalizations.length === 0) return { files: documentFiles(edited), report: unchanged }
	const before = originalHashes()
	const after = songHashes(edited)
	if (before === null || after === null) return { files: documentFiles(edited), report: unchanged }

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
	return { files: documentFiles(song), report: { spentHashes: [...spent].sort(), normalized, withheld } }
}
