import { fmtHourRange } from '../core/config'
import { DAY_NAMES, HOURS_PER_DAY } from '../core/types'
import { savedRows, type SavedSchedule } from './project'

/**
 * CSV exports of a saved schedule, for spreadsheets.
 *
 * RFC 4180 quoting and CRLF line endings, with a byte-order mark so Excel reads the file as
 * UTF-8 (names with accents otherwise turn to mojibake). Time ranges use a plain hyphen rather
 * than an en dash for the same reason.
 */

const BOM = '﻿'

function cell(value: string | number): string {
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function toCsv(rows: (string | number)[][]): string {
  return BOM + rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n'
}

const range = (startHour: number, endHour: number) => fmtHourRange(startHour, endHour).replace('–', '-')

/** 24-hour `HH:MM`; the end of the day is written `00:00`. */
const clock = (hour: number) => `${String(hour % HOURS_PER_DAY).padStart(2, '0')}:00`

/** One row per person, one column per weekday: what gets printed and put up. Off-desk shifts are marked. */
export function weekGridCsv(saved: SavedSchedule): string {
  const header = ['Employee', ...DAY_NAMES, 'Desk hours', 'Off-desk hours', 'Total hours']
  const rows = savedRows(saved).map((row) => [
    row.employeeName,
    ...DAY_NAMES.map((_, day) =>
      [
        ...row.shifts.filter((s) => s.day === day).map((s) => ({ s, offDesk: false })),
        ...row.offDesk.filter((s) => s.day === day).map((s) => ({ s, offDesk: true })),
      ]
        .sort((a, b) => a.s.startHour - b.s.startHour)
        .map(({ s, offDesk }) => range(s.startHour, s.endHour) + (offDesk ? ' (off desk)' : ''))
        .join('; '),
    ),
    row.deskHours,
    row.offDeskHours,
    row.hours,
  ])
  return toCsv([header, ...rows])
}

/** One row per shift, desk and off-desk, sorted by day then start time: easy to filter, sort and total. */
export function shiftListCsv(saved: SavedSchedule): string {
  const header = ['Employee', 'Day', 'Start', 'End', 'Hours', 'Type']
  const all = [
    ...saved.shifts.map((s) => ({ s, type: 'Desk' })),
    ...saved.offDesk.map((s) => ({ s, type: 'Off desk' })),
  ].sort((a, b) => a.s.day - b.s.day || a.s.startHour - b.s.startHour || a.s.employeeName.localeCompare(b.s.employeeName))
  const rows = all.map(({ s, type }) => [
    s.employeeName,
    DAY_NAMES[s.day],
    clock(s.startHour),
    clock(s.endHour),
    s.endHour - s.startHour,
    type,
  ])
  return toCsv([header, ...rows])
}

/** `small-cafe-schedule.csv` */
export function scheduleFileName(projectName: string, kind: 'grid' | 'shifts'): string {
  const base = projectName.trim().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'schedule'
  return `${base}-${kind === 'grid' ? 'schedule' : 'shifts'}.csv`
}
