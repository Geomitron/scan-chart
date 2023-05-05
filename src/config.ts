/* eslint-disable @typescript-eslint/naming-convention */
import { Transform } from 'class-transformer'
import { IsNumber, IsPositive, IsString } from 'class-validator'
import { cpus } from 'os'

export class Config {
	@IsString()
	public readonly GOOGLE_APPLICATION_CREDENTIALS!: string

	@IsNumber()
	@IsPositive()
	@Transform(({ value }) => parseInt(value, 10))
	public readonly GOOGLE_API_RATE_LIMIT_MS: number = 6

	@IsNumber()
	@Transform(({ value }) => parseInt(value, 10))
	@IsPositive()
	public readonly MAX_FILE_SIZE_MB: number = 850

	@IsString()
	public readonly DISCORD_TOKEN!: string

	@IsString()
	public readonly APPLICATION_ID!: string

	@IsString()
	public readonly REVIEW_STATUS_CHANNEL_ID!: string

	@IsString()
	public readonly CHARTER_COMMUNICATION_CHANNEL_ID!: string

	@IsString()
	public readonly OPT_OUT_ERROR_CHANNEL_ID!: string

	@IsString()
	public readonly ADMIN_LOG_CHANNEL_ID!: string

	@IsString()
	public readonly CHARTS_FOLDER!: string

	@IsString()
	public readonly SEVEN_ZIP_PATH!: string

	@IsNumber()
	@Transform(({ value }) => parseInt(value, 10))
	@IsPositive()
	public readonly MAX_THREADS: number = cpus().length - 1
}
