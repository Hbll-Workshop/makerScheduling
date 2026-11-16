import type { CSSProperties } from 'react'
import { fmtHour, fmtHourRange } from '../../core/config'
import { DAYS_PER_WEEK } from '../../core/types'
import { personClass } from '../people'
import type { ShiftTableBlock, ShiftTableRow } from './ShiftTable'

/** The hours the calendar spans: `hours` if given, widened to take in every shift. */
function axisRange(rows: ShiftTableRow[], hours?: { from: number; to: number }): { from: number; to: number } {
  let from = hours?.from ?? Infinity
  let to = hours?.to ?? -Infinity
  for (const row of rows) {
    for (const block of row.blocks) {
      from = Math.min(from, block.startHour)
      to = Math.max(to, block.endHour)
    }
  }
  return from < to ? { from, to } : { from: 8, to: 18 }
}

interface Placed {
  row: ShiftTableRow
  block: ShiftTableBlock
  lane: number
  /** Lanes in this shift's overlap group, so shifts that overlap nothing get the full column. */
  lanes: number
}

/** Side-by-side lanes for one day's shifts, grouped so each overlap group splits the width alone. */
function placeDay(rows: ShiftTableRow[], day: number): Placed[] {
  const items = rows
    .flatMap((row) => row.blocks.filter((b) => b.day === day).map((block) => ({ row, block })))
    .sort((a, b) => a.block.startHour - b.block.startHour || b.block.endHour - a.block.endHour)

  const placed: Placed[] = []
  let group: Placed[] = []
  let groupEnd = -Infinity
  let laneEnds: number[] = []
  const closeGroup = () => {
    for (const p of group) p.lanes = laneEnds.length
    group = []
    laneEnds = []
  }
  for (const item of items) {
    if (item.block.startHour >= groupEnd) {
      closeGroup()
      groupEnd = -Infinity
    }
    let lane = laneEnds.findIndex((end) => end <= item.block.startHour)
    if (lane === -1) lane = laneEnds.length
    laneEnds[lane] = item.block.endHour
    groupEnd = Math.max(groupEnd, item.block.endHour)
    const p = { ...item, lane, lanes: 1 }
    group.push(p)
    placed.push(p)
  }
  closeGroup()
  return placed
}

interface ShiftCalendarProps {
  dayLabels: readonly string[]
  rows: ShiftTableRow[]
  /** Hours to show; defaults to the span of the shifts themselves. */
  hours?: { from: number; to: number }
}

/**
 * A week calendar: days across, hours down, each shift a card in its person's colour. Overlapping
 * shifts share the column side by side, and busier days get wider columns.
 */
export function ShiftCalendar({ dayLabels, rows, hours }: ShiftCalendarProps) {
  const { from, to } = axisRange(rows, hours)
  const span = to - from
  const tickEvery = span > 14 ? 2 : 1
  const days = Array.from({ length: DAYS_PER_WEEK }, (_, day) => placeDay(rows, day))
  // Busier days get wider columns, so side-by-side shifts keep room for a name.
  const columns = days
    .map((placed) => {
      const lanes = Math.max(2, ...placed.map((p) => p.lanes))
      return `minmax(${lanes * 2}rem, ${lanes}fr)`
    })
    .join(' ')

  return (
    <div className="stack-sm">
      <div className="legend">
        {rows.map((row) => (
          <span key={row.key} className="legend-item">
            <span className={`swatch ${personClass(row.slot ?? 0)}`} /> {row.name}
            <span className="legend-note">{row.hours}h</span>
          </span>
        ))}
      </div>
      <div className="schedule-scroll">
        <div className="calendar" style={{ '--hours': span, gridTemplateColumns: `3.6rem ${columns}` } as CSSProperties}>
          <div className="calendar-corner" aria-hidden="true" />
          {dayLabels.map((label) => {
            const [name, date] = label.split(' ')
            return (
              <div key={label} className="calendar-dayhead">
                <span className="calendar-dayname">{name}</span>
                <span className="calendar-date">{date}</span>
              </div>
            )
          })}

          <div className="calendar-hours" aria-hidden="true">
            {Array.from({ length: span + 1 }, (_, i) => i)
              .filter((i) => i % tickEvery === 0)
              .map((i) => (
                <span key={i} style={{ top: `calc(var(--hour-h) * ${i})` }}>{fmtHour(from + i)}</span>
              ))}
          </div>

          {days.map((placed, day) => {
            return (
              <div key={day} className="calendar-col">
                {placed.length === 0 && <span className="calendar-empty">No shifts</span>}
                {placed.map(({ row, block, lane, lanes }) => {
                  const range = fmtHourRange(block.startHour, block.endHour)
                  const notes = [
                    `${row.name}, ${dayLabels[day]}, ${range} (${block.endHour - block.startHour}h)`,
                    block.offDesk && 'Off desk',
                    block.notPreferred && 'Includes hours this employee marked not preferred',
                  ].filter(Boolean)
                  return (
                    <div
                      key={`${row.key}-${block.startHour}`}
                      className={`calendar-shift ${personClass(row.slot ?? 0)}${block.notPreferred ? ' has-not-preferred' : ''}${block.offDesk ? ' is-off-desk' : ''}`}
                      style={{
                        top: `calc(var(--hour-h) * ${block.startHour - from} + 2px)`,
                        height: `calc(var(--hour-h) * ${block.endHour - block.startHour} - 4px)`,
                        left: `calc(${(lane / lanes) * 100}% + 3px)`,
                        width: `calc(${100 / lanes}% - 6px)`,
                      }}
                      title={notes.join('. ')}
                    >
                      {/* The card is a size container: narrow cards drop the time, then turn the name on its side. */}
                      <div className="calendar-shift-body">
                        <span className="calendar-shift-name">{row.name}</span>
                        <span className="calendar-shift-time">{block.offDesk ? `Off desk · ${range}` : range}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
