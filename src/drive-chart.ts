import { DriveChart, DriveFileResponse } from 'dbschema/interfaces'

export type DriveChartBase = Omit<DriveChart, 'id' | 'application' | 'files'> & { files: DriveFileResponseBase[] }

export type DriveFileResponseBase = Omit<DriveFileResponse, 'id'>
