import { Module } from '@nestjs/common'

//import { DiscordModule } from 'src/discord/discord.module'
import { AudioParserService } from './audio-parser/audio-parser.service'
import { ChartParserService } from './chart-parser/chart-parser.service'
import { ChartsScannerService } from './charts-scanner/charts-scanner.service'
import { IniParserService } from './ini-parser/ini-parser.service'
import { MidiParserService } from './midi-parser/midi-parser.service'

@Module({
	providers: [ChartParserService, MidiParserService, ChartsScannerService, IniParserService, AudioParserService],
	exports: [ChartParserService, MidiParserService, ChartsScannerService],
	imports: [],
})
export class ChartModule { }
