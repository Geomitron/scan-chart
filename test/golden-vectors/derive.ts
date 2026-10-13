import { base64url } from 'rfc4648'

import { CanonicalTrackIdentity, CanonicalTrackSemantics } from 'src/chart/identity/btrack-20260801'
import { canonical20260801, frozenLegacy6142, FrozenLegacyTrackIdentity } from 'src/chart/identity/public'
import type { SongHashMetadata } from 'src/chart/identity/song-hash-20251010'
import { parseChartFile } from 'src/chart/parse-chart-file'
import { pruneEmptyPhrases } from 'src/chart/track-hasher'
import { IniChartModifiers } from 'src/chart/types'
import { calculateCompetitiveHashes } from 'src/competitive'
import { songContext } from 'src/song-context'
import { parseSongFiles } from 'src/song-document'
import { Difficulty, File, Instrument } from 'src/types'

import { AuthoredSourceCase, resolvedModifiers } from './cases'
import { ResolvedSongHashMetadata } from './schema'

export function normalize(value: unknown): unknown {
	if (typeof value === 'bigint') return value.toString(10)
	if (value instanceof Uint8Array) return Buffer.from(value).toString('hex')
	if (Array.isArray(value)) return value.map(normalize)
	if (typeof value === 'object' && value !== null) {
		return Object.fromEntries(Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => [key, normalize(entry)]))
	}
	return value
}

export function stableJson(value: unknown): Uint8Array {
	return new TextEncoder().encode(`${JSON.stringify(normalize(value), null, 2)}\n`)
}

function identitySemantics(
	parsed: ReturnType<typeof parseChartFile>,
	instrument: Instrument,
	difficulty: Difficulty,
): unknown {
	const track = parsed.trackData.find(candidate => candidate.instrument === instrument && candidate.difficulty === difficulty)
	if (!track) throw new Error(`Legacy target ${instrument}/${difficulty} was not parsed`)
	return {
		resolution: parsed.resolution,
		tempos: parsed.tempos.map(({ tick, beatsPerMinute }) => ({ tick, beatsPerMinute })),
		timeSignatures: parsed.timeSignatures.map(({ tick, numerator, denominator }) => ({ tick, numerator, denominator })),
		starPower: pruneEmptyPhrases(track.starPowerSections, track.noteEventGroups).map(({ tick, length }) => ({ tick, length })),
		solos: pruneEmptyPhrases(track.soloSections, track.noteEventGroups).map(({ tick, length }) => ({ tick, length })),
		flexLanes: pruneEmptyPhrases(track.flexLanes, track.noteEventGroups).map(({ tick, length, isDouble }) => ({ tick, length, isDouble })),
		drumFreestyle: track.drumFreestyleSections.map(({ tick, length, isCoda }) => ({ tick, length, isCoda })),
		notes: track.noteEventGroups.flat().map(({ tick, length, type, flags }) => ({ tick, length, type, flags })),
	}
}

export interface DerivedPipeline {
	readonly semantics: unknown
	readonly diagnostics: unknown
	readonly physical: Uint8Array
	readonly projection: Uint8Array
	readonly digest: Uint8Array
	readonly trackHash: string
}

export interface DerivedLegacyPipeline extends DerivedPipeline {
	readonly publishedPaddedTrackHash: string
}

function legacyPipeline(identity: FrozenLegacyTrackIdentity, semantics: unknown): DerivedLegacyPipeline {
	return {
		semantics,
		diagnostics: [],
		physical: identity.physicalBTrack.bytes,
		projection: identity.projection.bytes,
		digest: identity.digest.bytes,
		trackHash: identity.trackHash.value,
		publishedPaddedTrackHash: base64url.stringify(identity.digest.bytes, { pad: true }),
	}
}

export function canonicalPipeline(identity: CanonicalTrackIdentity, semantics: CanonicalTrackSemantics, diagnostics: unknown = []): DerivedPipeline {
	return {
		semantics,
		diagnostics,
		physical: identity.physicalBTrack.bytes,
		projection: identity.projection.bytes,
		digest: identity.digest.bytes,
		trackHash: identity.trackHash.value,
	}
}

export function deriveSourceCase(sourceCase: AuthoredSourceCase, modifiers: IniChartModifiers = resolvedModifiers): {
	readonly legacy: DerivedLegacyPipeline
	readonly canonical: DerivedPipeline
} {
	const request = {
		source: { format: sourceCase.format, bytes: sourceCase.bytes },
		modifiers,
	} as const
	const legacyParsed = frozenLegacy6142.parseSource(request)
	if (legacyParsed.kind !== 'accepted') throw new Error(`${sourceCase.id}: frozen legacy parser rejected the source`)
	const legacyIdentity = frozenLegacy6142.calculateTrackIdentity({
		chart: legacyParsed.chart,
		instrument: sourceCase.target.instrument,
		difficulty: sourceCase.target.difficulty,
	})
	const legacySemantics = identitySemantics(
		parseChartFile(sourceCase.bytes.slice(), sourceCase.format, modifiers),
		sourceCase.target.instrument,
		sourceCase.target.difficulty,
	)

	const canonicalParsed = canonical20260801.parseSource(request)
	if (canonicalParsed.kind !== 'accepted') throw new Error(`${sourceCase.id}: canonical parser rejected the source`)
	const canonicalTrack = canonicalParsed.chart.tracks.find(track =>
		track.key.instrument === sourceCase.target.instrument && track.key.difficulty === sourceCase.target.difficulty)
	if (!canonicalTrack) throw new Error(`${sourceCase.id}: canonical target was not parsed`)
	const canonicalIdentity = canonical20260801.calculateTrackIdentity(canonicalTrack)

	return {
		legacy: legacyPipeline(legacyIdentity, legacySemantics),
		canonical: canonicalPipeline(canonicalIdentity, canonicalTrack.semantics, canonicalParsed.notices),
	}
}

/** Derives the canonical pipeline alone, for suites from v3 on. */
export function deriveCanonicalSourceCase(sourceCase: AuthoredSourceCase, modifiers: IniChartModifiers): DerivedPipeline {
	const parsed = canonical20260801.parseSource({ source: { format: sourceCase.format, bytes: sourceCase.bytes }, modifiers })
	if (parsed.kind !== 'accepted') throw new Error(`${sourceCase.id}: canonical parser rejected the source`)
	const track = parsed.chart.tracks.find(candidate =>
		candidate.key.instrument === sourceCase.target.instrument && candidate.key.difficulty === sourceCase.target.difficulty)
	if (!track) throw new Error(`${sourceCase.id}: canonical target was not parsed`)
	return canonicalPipeline(canonical20260801.calculateTrackIdentity(track), track.semantics, parsed.notices)
}

/** The song.ini keys that change how a chart parses. */
export function chartModifiers(values: IniChartModifiers): IniChartModifiers {
	return {
		song_length: values.song_length,
		hopo_frequency: values.hopo_frequency,
		eighthnote_hopo: values.eighthnote_hopo,
		multiplier_note: values.multiplier_note,
		sustain_cutoff_threshold: values.sustain_cutoff_threshold,
		chord_snap_threshold: values.chord_snap_threshold,
		five_lane_drums: values.five_lane_drums,
		pro_drums: values.pro_drums,
	}
}

export interface DerivedSongMember {
	readonly instrument: Instrument
	readonly difficulty: Difficulty
	readonly semantics: CanonicalTrackSemantics
	readonly physical: Uint8Array
	readonly projection: Uint8Array
	readonly digest: Uint8Array
	readonly trackHash: string
	readonly trackDuration: { readonly lastNoteEndTick: string; readonly durationMs: string }
}

export interface DerivedSong {
	readonly selectedSource: string
	readonly modifiers: IniChartModifiers
	readonly metadata: { readonly selected: SongHashMetadata; readonly resolved: ResolvedSongHashMetadata }
	readonly diagnostics: unknown
	readonly songDuration: { readonly contentLastTick: string; readonly endTick: string; readonly durationMs: string }
	readonly members: readonly DerivedSongMember[]
	readonly preimage: Uint8Array
	readonly digest: Uint8Array
	readonly songHash: string
}

function resolvedStrings(id: string, metadata: SongHashMetadata): ResolvedSongHashMetadata {
	const text = (value: string | null) => {
		if (value === null) throw new Error(`${id}: the SongHash writer left a metadata field unset`)
		return value
	}
	return {
		name: text(metadata.name),
		artist: text(metadata.artist),
		album: text(metadata.album),
		genre: text(metadata.genre),
		year: text(metadata.year),
		charter: text(metadata.charter),
		icon: text(metadata.icon),
	}
}

/**
 * Derives the canonical SongHash of a song folder as 9.0.0 does: the song document chooses the notes file and reads
 * song.ini, the notes file is parsed with the canonical profile and the song.ini chart modifiers, then every member
 * Track and the song are hashed with the metadata Clone Hero holds on the song. `calculateCompetitiveHashes` must
 * give the same SongHash and TrackHashes.
 */
export function deriveSongCase(id: string, inputs: readonly { readonly name: string; readonly bytes: Uint8Array }[]): DerivedSong {
	const files: File[] = inputs.map(input => ({ fileName: input.name, data: input.bytes.slice() }))
	const song = parseSongFiles(files)
	const { chart: outcome, settings, songHashMetadata } = songContext(song)
	if (song.chart === null || outcome.kind !== 'parsed') throw new Error(`${id}: no readable chart: ${outcome.kind === 'failed' ? outcome.error : 'none'}`)
	const chart = { format: song.chart.format, chartBytes: outcome.bytes, songHashMetadata }
	const selected = files.find(file => file.fileName === song.chart!.fileName)
	if (!selected) throw new Error(`${id}: the selected notes file is not one of the inputs`)
	const modifiers = chartModifiers(settings)
	const parsed = canonical20260801.parseSource({ source: { format: chart.format, bytes: chart.chartBytes }, modifiers })
	if (parsed.kind !== 'accepted') throw new Error(`${id}: canonical parser rejected the source`)
	const bundle = canonical20260801.calculateSongBundle({ chart: parsed.chart, metadata: chart.songHashMetadata })
	const competitive = calculateCompetitiveHashes(song)
	if (!competitive.accepted || competitive.songHash !== bundle.song.songHash.value
		|| JSON.stringify(competitive.tracks.map(track => [track.instrument, track.difficulty, track.trackHash]))
			!== JSON.stringify(bundle.tracks.map(track => [track.instrument, track.difficulty, track.identity.trackHash.value]))) {
		throw new Error(`${id}: calculateCompetitiveHashes disagrees with the specification API`)
	}
	const members = bundle.tracks.map(member => {
		const track = parsed.chart.tracks.find(candidate =>
			candidate.key.instrument === member.instrument && candidate.key.difficulty === member.difficulty)
		if (!track) throw new Error(`${id}: SongHash member ${member.instrument}/${member.difficulty} was not parsed`)
		return {
			instrument: member.instrument,
			difficulty: member.difficulty,
			semantics: track.semantics,
			physical: member.identity.physicalBTrack.bytes,
			projection: member.identity.projection.bytes,
			digest: member.identity.digest.bytes,
			trackHash: member.identity.trackHash.value,
			trackDuration: {
				lastNoteEndTick: member.duration.lastNoteEndTick.toString(10),
				durationMs: member.duration.durationMs.toString(10),
			},
		}
	})
	return {
		selectedSource: selected.fileName,
		modifiers,
		metadata: { selected: chart.songHashMetadata, resolved: resolvedStrings(id, bundle.song.metadata) },
		diagnostics: parsed.notices,
		songDuration: {
			contentLastTick: bundle.duration.contentLastTick.toString(10),
			endTick: bundle.duration.endTick.toString(10),
			durationMs: bundle.duration.durationMs.toString(10),
		},
		members,
		preimage: bundle.song.preimage,
		digest: bundle.song.digest,
		songHash: bundle.song.songHash.value,
	}
}
