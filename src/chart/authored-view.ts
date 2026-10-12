import type { Difficulty, Instrument } from '../types'
import { ChartFileTokens, chartSectionLines, chartSectionTrack, parseTrackLine } from './chart-file-parser'
import type { EventType } from './raw-types'

/** Where an authored element is in its file, so an edit can rewrite exactly that source. */
export type AuthoredSource = { readonly format: 'chart'; readonly section: number; readonly line: number }

/** A note, note modifier or phrase, as the file writes it. */
export interface AuthoredEvent {
	readonly tick: number
	readonly length: number
	readonly type: EventType
	readonly source: AuthoredSource
}

export interface AuthoredTextEvent {
	readonly tick: number
	readonly text: string
	readonly source: AuthoredSource
}

export interface AuthoredVersusPhrase {
	readonly tick: number
	readonly length: number
	readonly isPlayer2: boolean
	readonly source: AuthoredSource
}

/** One instrument section of a `.chart` file, as written. */
export interface ChartAuthoredTrack {
	readonly instrument: Instrument
	readonly difficulty: Difficulty
	readonly sectionName: string
	/** Index of the section in the file's tokens. */
	readonly section: number
	/** `false` for an earlier section whose name repeats later: classification reads only the last one. */
	readonly isRead: boolean
	/** Notes, note modifiers and phrases in file order. A solo is its `solo` and `soloend` events, as written. */
	readonly events: readonly AuthoredEvent[]
	readonly textEvents: readonly AuthoredTextEvent[]
	readonly versusPhrases: readonly AuthoredVersusPhrase[]
}

/**
 * Reads every instrument section of a tokenized `.chart` file, in file order with repeated sections included. Each
 * element is a line the classifier reads, parsed by the classifier's own line parser, with that line as its source.
 */
export function chartAuthoredTracks(tokens: ChartFileTokens): ChartAuthoredTrack[] {
	const lastIndexOfName = new Map<string, number>()
	tokens.sections.forEach((section, index) => lastIndexOfName.set(section.name, index))

	const tracks: ChartAuthoredTrack[] = []
	tokens.sections.forEach((section, sectionIndex) => {
		const track = chartSectionTrack(section.name)
		if (track === null) return
		const events: AuthoredEvent[] = []
		const textEvents: AuthoredTextEvent[] = []
		const versusPhrases: AuthoredVersusPhrase[] = []
		chartSectionLines(tokens, section).forEach((line, lineIndex) => {
			if (line.text === '') return
			const parsed = parseTrackLine(line.text, track.instrument, track.difficulty)
			const source: AuthoredSource = { format: 'chart', section: sectionIndex, line: lineIndex }
			if (parsed?.kind === 'note') events.push({ tick: parsed.tick, length: parsed.length, type: parsed.type, source })
			else if (parsed?.kind === 'text') textEvents.push({ tick: parsed.tick, text: parsed.text, source })
			else if (parsed?.kind === 'versus') versusPhrases.push({ tick: parsed.tick, length: parsed.length, isPlayer2: parsed.isPlayer2, source })
		})
		tracks.push({
			...track,
			sectionName: section.name,
			section: sectionIndex,
			isRead: lastIndexOfName.get(section.name) === sectionIndex,
			events,
			textEvents,
			versusPhrases,
		})
	})
	return tracks
}
