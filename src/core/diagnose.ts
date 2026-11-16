import { fmtHourRange } from './config'
import { buildProblemContext, pinnedMask } from './patterns'
import { solve } from './search/solver'
import {
  Availability,
  DAY_NAMES,
  DAYS_PER_WEEK,
  HOURS_PER_DAY,
  WEEK_HOURS,
  countBits,
  slotIndex,
  type Employee,
  type ProblemContext,
  type ScheduleConfig,
} from './types'

/**
 * Explains, in plain words, why no schedule exists.
 *
 * {@link import('./config').validateProblem} catches the obvious contradictions before a search.
 * What remains is subtler: enough people are *available*, yet the shift rules, pins and weekly
 * limits leave no way to combine them. Every message returned here is a proof, not a guess: each
 * names a part of the week that cannot be staffed whatever else is decided.
 *
 * Checks run cheapest first, and each stage only runs if the earlier ones found nothing:
 *  1. an hour fewer people can reach with a legal shift than it needs;
 *  2. a day needing more staff-hours than the people who can work it can give;
 *  3. a week needing more staff-hours than everyone's weekly maximum allows;
 *  4. a day that can't be staffed even on its own, narrowed to the shortest stretch of hours that
 *     is impossible, by solving that day alone;
 *  5. every day possible on its own but not together: weekly hours run out.
 *
 * Returns an empty list when no single cause is found within the time allowed.
 */
export function diagnoseInfeasible(employees: Employee[], config: ScheduleConfig, maxMillis = 4000): string[] {
  let ctx: ProblemContext
  try {
    ctx = buildProblemContext(employees, config)
  } catch {
    return []
  }
  const name = (e: number) => employees[e].name || employees[e].id
  const need = (day: number, hour: number) => config.minCoverage[slotIndex(day, hour)]
  const demandMask = Array.from({ length: DAYS_PER_WEEK }, (_, day) => {
    let mask = 0
    for (let hour = 0; hour < HOURS_PER_DAY; hour++) if (need(day, hour) > 0) mask |= 1 << hour
    return mask
  })

  // 1. Hours too few people can reach with any legal shift.
  const hourly = hourShortfalls(ctx, need, name)
  if (hourly.messages.length > 0) return hourly.messages

  // Most hours of demand each person could cover per day, whatever pattern they work.
  const useful = employees.map((_, e) =>
    Array.from({ length: DAYS_PER_WEEK }, (_, day) =>
      Math.max(0, ...ctx.patterns[e * DAYS_PER_WEEK + day].map((p) => countBits(p.mask & demandMask[day]))),
    ),
  )
  const demandOf = (day: number) => {
    let sum = 0
    for (let hour = 0; hour < HOURS_PER_DAY; hour++) sum += need(day, hour)
    return sum
  }

  // 2. Days needing more staff-hours than can be given.
  const daily: string[] = []
  for (let day = 0; day < DAYS_PER_WEEK; day++) {
    const demand = demandOf(day)
    if (demand === 0) continue
    const capacity = employees.reduce((sum, _, e) => sum + useful[e][day], 0)
    if (capacity < demand) {
      daily.push(
        `${DAY_NAMES[day]} needs ${demand} staff-hours, but the people who can work that day can cover at most ` +
          `${capacity} of them (shifts are ${shiftLimits(config)}). Ask fewer people for ${DAY_NAMES[day]}, ` +
          `or make more people available.`,
      )
    }
  }
  if (daily.length > 0) return daily

  // 3. The week as a whole.
  let weekDemand = 0
  for (let slot = 0; slot < WEEK_HOURS; slot++) weekDemand += config.minCoverage[slot]
  const weekCapacity = employees.map((e, i) => Math.min(e.maxWeeklyHours, useful[i].reduce((a, b) => a + b, 0)))
  const totalCapacity = weekCapacity.reduce((a, b) => a + b, 0)
  if (totalCapacity < weekDemand) {
    return [
      `The week needs ${weekDemand} staff-hours, but everyone working can cover at most ${totalCapacity}. ` +
        `${capacityBreakdown(employees, weekCapacity, useful)} Lower the staff needed, raise someone's maximum ` +
        `weekly hours, or add someone.`,
    ]
  }

  // 4. Days that can't be staffed even on their own.
  const deadline = Date.now() + maxMillis
  const impossible: string[] = []
  let allDaysSettled = true
  for (let day = 0; day < DAYS_PER_WEEK; day++) {
    if (demandMask[day] === 0) continue
    const verdict = dayAlone(employees, config, day, 0, HOURS_PER_DAY, deadline)
    if (verdict === 'unknown') {
      allDaysSettled = false
      continue
    }
    if (verdict === 'possible') continue
    impossible.push(explainDay(employees, config, ctx, day, deadline))
  }
  if (impossible.length > 0) return impossible

  // 5. Every day works alone, so the days fight over people's weekly hours.
  if (allDaysSettled) {
    return [
      `Each day can be staffed on its own, but not all in the same week: people's maximum weekly hours run ` +
        `out. The week needs ${weekDemand} staff-hours. ${capacityBreakdown(employees, weekCapacity, useful)} ` +
        `Raise someone's maximum weekly hours, add someone, or lower the staff needed.`,
    ]
  }
  return []
}

/** `'3–8h long, at most 10h a day, one block a day'` */
function shiftLimits(config: ScheduleConfig): string {
  const length = config.minShiftLength === config.maxShiftLength ? `${config.minShiftLength}h long` : `${config.minShiftLength}–${config.maxShiftLength}h long`
  const blocks = config.allowSplitShifts ? `up to ${config.maxBlocksPerDay} blocks a day` : 'one block a day'
  return `${length}, at most ${config.maxDailyHours}h a day, ${blocks}`
}

function capacityBreakdown(employees: Employee[], weekCapacity: number[], useful: number[][]): string {
  const parts = employees.map((e, i) => {
    const reachable = useful[i].reduce((a, b) => a + b, 0)
    const why = e.maxWeeklyHours < reachable ? `max ${e.maxWeeklyHours}h a week` : 'limited by availability'
    return `${e.name || e.id} ${weekCapacity[i]}h (${why})`
  })
  return `Most each person can give: ${parts.join(', ')}.`
}

interface HourGap {
  day: number
  hour: number
  need: number
  coverers: number[]
  blocked: number[]
}

/** Step 1: hours where fewer people can reach the hour with a legal shift than it needs. */
function hourShortfalls(
  ctx: ProblemContext,
  need: (day: number, hour: number) => number,
  name: (e: number) => string,
): { messages: string[] } {
  const { employees, config } = ctx
  const gaps: HourGap[] = []
  for (let day = 0; day < DAYS_PER_WEEK; day++) {
    for (let hour = 0; hour < HOURS_PER_DAY; hour++) {
      const n = need(day, hour)
      if (n === 0) continue
      const coverers: number[] = []
      const blocked: number[] = []
      for (let e = 0; e < employees.length; e++) {
        if (ctx.coverableMask[e * DAYS_PER_WEEK + day] & (1 << hour)) coverers.push(e)
        else if (employees[e].availability[slotIndex(day, hour)] !== Availability.Unavailable) blocked.push(e)
      }
      if (coverers.length < n) gaps.push({ day, hour, need: n, coverers, blocked })
    }
  }

  // Merge runs of consecutive hours with the same story into one message.
  const messages: string[] = []
  for (let i = 0; i < gaps.length; ) {
    const first = gaps[i]
    let j = i + 1
    while (
      j < gaps.length &&
      gaps[j].day === first.day &&
      gaps[j].hour === gaps[j - 1].hour + 1 &&
      gaps[j].need === first.need &&
      gaps[j].coverers.join() === first.coverers.join() &&
      gaps[j].blocked.join() === first.blocked.join()
    ) j++
    const last = gaps[j - 1]
    const when = `${DAY_NAMES[first.day]} ${fmtHourRange(first.hour, last.hour + 1)}`
    const people = (n: number) => (n === 1 ? '1 person' : `${n} people`)
    const who = first.coverers.length === 0 ? 'nobody can' : `only ${people(first.coverers.length)} can (${first.coverers.map(name).join(', ')})`
    let text = `${when} needs ${people(first.need)}, but ${who} work a legal shift then.`
    for (const e of first.blocked) text += ` ${name(e)} is available but ${blockedReason(employees[e], config, first.day, first.hour)}.`
    messages.push(text)
    i = j
  }
  return { messages }
}

/** Why someone available at an hour still can't be given a shift covering it. */
function blockedReason(employee: Employee, config: ScheduleConfig, day: number, hour: number): string {
  const dailyCap = Math.min(config.maxDailyHours, employee.maxWeeklyHours)
  if (dailyCap < config.minShiftLength) {
    return `their maximum weekly hours (${employee.maxWeeklyHours}) are below the shortest shift (${config.minShiftLength}h)`
  }
  const win = config.operatingHours[day]
  if (win) {
    const free = (h: number) => h >= win.startHour && h < win.endHour && employee.availability[slotIndex(day, h)] !== Availability.Unavailable
    let from = hour
    while (free(from - 1)) from--
    let to = hour + 1
    while (free(to)) to++
    if (to - from < config.minShiftLength) {
      return `is only free ${fmtHourRange(from, to)} there (${to - from}h), shorter than the shortest shift (${config.minShiftLength}h)`
    }
  }
  if (pinnedMask(employee, day) !== 0) return `their must-work hours that day leave no legal shift that also covers it`
  return `no shift within the shift rules (${shiftLimits(config)}) covers it`
}

type Verdict = 'possible' | 'impossible' | 'unknown'

/**
 * Whether `day` can be staffed on its own with coverage kept only for hours `[from, to)`. Every
 * other day is closed; weekly maximums still apply, so this is a relaxation of the real week: if
 * it's impossible here, it's impossible there.
 */
function dayAlone(employees: Employee[], config: ScheduleConfig, day: number, from: number, to: number, deadline: number): Verdict {
  const left = deadline - Date.now()
  if (left <= 0) return 'unknown'
  const minCoverage = new Uint8Array(WEEK_HOURS)
  for (let hour = from; hour < to; hour++) minCoverage[slotIndex(day, hour)] = config.minCoverage[slotIndex(day, hour)]
  const operatingHours = config.operatingHours.map((w, d) => (d === day ? w : null))
  // Pins on other days would demand shifts on a closed day; they don't bear on this one.
  const dayEmployees = employees.map((e) => {
    if (!e.pinned) return e
    const pinned = new Uint8Array(WEEK_HOURS)
    for (let hour = 0; hour < HOURS_PER_DAY; hour++) pinned[slotIndex(day, hour)] = e.pinned[slotIndex(day, hour)]
    return { ...e, pinned }
  })
  try {
    const { schedules, report } = solve(dayEmployees, { ...config, operatingHours, minCoverage }, {
      rules: [],
      threshold: -Infinity,
      maxResults: 1,
      tightenToBest: true,
      maxMillis: left,
      maxNodes: 2_000_000,
    })
    if (schedules.length > 0) return 'possible'
    return report.complete ? 'impossible' : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Narrows an impossible day to the shortest stretch of hours that is impossible on its own. */
function explainDay(employees: Employee[], config: ScheduleConfig, ctx: ProblemContext, day: number, deadline: number): string {
  const win = config.operatingHours[day]!
  let from = win.startHour
  let to = win.endHour
  // Earliest end that's already impossible, then the latest start that still is.
  for (let end = win.startHour + 1; end <= win.endHour; end++) {
    const v = dayAlone(employees, config, day, win.startHour, end, deadline)
    if (v === 'unknown') break
    if (v === 'impossible') {
      to = end
      break
    }
  }
  for (let start = to - 1; start >= win.startHour; start--) {
    const v = dayAlone(employees, config, day, start, to, deadline)
    if (v === 'unknown') break
    if (v === 'impossible') {
      from = start
      break
    }
  }
  while (from < to && config.minCoverage[slotIndex(day, from)] === 0) from++
  while (to > from && config.minCoverage[slotIndex(day, to - 1)] === 0) to--

  const needs = new Set<number>()
  for (let hour = from; hour < to; hour++) needs.add(config.minCoverage[slotIndex(day, hour)])
  const most = Math.max(...needs)
  const asking = needs.size === 1 ? `${most} ${most === 1 ? 'person' : 'people'} every hour` : `up to ${most} people an hour`

  const available = employees
    .map((e, i) => {
      const runs = freeRuns(e, day, from, to)
      if (runs.length === 0) return null
      const pinned = pinnedMask(e, day) !== 0 ? ', pinned that day' : ''
      const cap = ctx.maxHoursPerSlot[i * DAYS_PER_WEEK + day]
      const limit = cap < config.maxDailyHours ? `, at most ${cap}h that day` : ''
      return `${e.name || e.id} (${runs.join(', ')}${pinned}${limit})`
    })
    .filter((x): x is string => x !== null)

  return (
    `${DAY_NAMES[day]} ${fmtHourRange(from, to)} can't be covered: it needs ${asking}, but the shifts people can ` +
    `work don't fit together to cover it (shifts are ${shiftLimits(config)}). ` +
    (available.length ? `Available then: ${available.join('; ')}.` : 'Nobody is available then.')
  )
}

/** `['9am–1pm', '3pm–5pm']`: when someone is available within `[from, to)` on `day`. */
function freeRuns(employee: Employee, day: number, from: number, to: number): string[] {
  const runs: string[] = []
  let start = -1
  for (let hour = from; hour <= to; hour++) {
    const free = hour < to && employee.availability[slotIndex(day, hour)] !== Availability.Unavailable
    if (free && start < 0) start = hour
    if (!free && start >= 0) {
      runs.push(fmtHourRange(start, hour))
      start = -1
    }
  }
  return runs
}
