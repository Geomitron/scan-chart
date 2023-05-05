import { Chart } from 'dbschema/interfaces'

import { Overwrite } from './utils'

export type NotesData = NonNullable<Chart['notesData']>
// Use enum integers when processing in code, but use equivalent enum type when in the database
export type NotesDataBase = Overwrite<NotesData, { maxNps: { notes: { type: EventType }[] }[] }>
export type NoteIssue = NotesDataBase['noteIssues'][0]['noteIssues'][0]
export type TrackEvent = NotesDataBase['maxNps'][0]['notes'][0]
export interface GroupedTrackEvent {
	/** Time of the event in milliseconds. Rounded to 3 decimal places. */
	time: number

	/** All `TrackEvents` that occur at `time`. */
	events: TrackEvent[]
}

export enum EventType {
	// 5 fret
	starPower,
	tap,
	force,
	orange,
	blue,
	yellow,
	red,
	green,
	open,
	soloMarker,

	// 6 fret
	black3,
	black2,
	black1,
	white3,
	white2,
	white1,

	// Drums
	activationLane,
	kick,
	kick2x,
}
