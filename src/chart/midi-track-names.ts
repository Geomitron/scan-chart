import type { Instrument } from '../types'

/** The MIDI track name scan-chart writes for each instrument. */
export const midiInstrumentTrackNames: Record<Instrument, string> = {
	drums: 'PART DRUMS',
	guitar: 'PART GUITAR',
	guitarcoop: 'PART GUITAR COOP',
	rhythm: 'PART RHYTHM',
	bass: 'PART BASS',
	keys: 'PART KEYS',
	guitarghl: 'PART GUITAR GHL',
	guitarcoopghl: 'PART GUITAR COOP GHL',
	rhythmghl: 'PART RHYTHM GHL',
	bassghl: 'PART BASS GHL',
	keysghl: 'PART KEYS GHL',
}
