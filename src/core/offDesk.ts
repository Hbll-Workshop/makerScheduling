import { Availability, DAYS_PER_WEEK, HOURS_PER_DAY, slotIndex, type Employee, type ShiftBlock } from './types'

/**
 * Off-desk hours: paid work away from the desk, drawn from a fixed weekly budget shared by the
 * whole team.
 *
 * Desk shifts are what the solver builds to meet coverage. Off-desk hours come afterwards, as a
 * top-up for people the desk schedule left below their weekly target. They never count toward
 * coverage, so they live entirely outside the search.
 */

export interface OffDeskLimits {
  /** Longest continuous stretch of work, counting a desk shift the off-desk block runs into. */
  maxShiftLength: number
  /** Desk plus off-desk hours in one day. */
  maxDailyHours: number
}

export interface OffDeskInput {
  /** Week-resolved employees: availability already reflects time off. */
  employees: readonly Employee[]
  /** Desk shifts per employee, in `employees` order. */
  desk: readonly (readonly ShiftBlock[])[]
  /** Off-desk hours available to hand out this week. */
  budget: number
  limits: OffDeskLimits
}

const hoursOf = (blocks: readonly ShiftBlock[]) => blocks.reduce((sum, b) => sum + b.endHour - b.startHour, 0)

/** Hours short of the weekly target after desk shifts, never above what the maximum allows. */
export function offDeskShortfall(employee: Employee, deskHours: number): number {
  const goal = Math.min(employee.targetWeeklyHours, employee.maxWeeklyHours)
  return Math.max(0, goal - deskHours)
}

/**
 * Proposed off-desk blocks per employee, in `employees` order.
 *
 * The budget is shared out an hour at a time to whoever is furthest below target, so a tight
 * budget narrows the biggest gaps first rather than closing one person's gap completely. Each
 * person's share is then placed on the calendar by {@link placeOffDesk}. If someone's hours can't
 * all be placed (not enough free availability), their share is capped at what fit and the rest
 * goes back to the others.
 */
export function suggestOffDesk(input: OffDeskInput): ShiftBlock[][] {
  const { employees, desk, limits } = input
  const n = employees.length
  const budget = Math.max(0, Math.floor(input.budget))
  const shortfall = employees.map((e, i) => offDeskShortfall(e, hoursOf(desk[i] ?? [])))
  const cap = shortfall.slice()
  let placed: ShiftBlock[][] = employees.map(() => [])

  // Each pass either places everyone's share or lowers at least one cap, so n + 1 passes suffice.
  for (let pass = 0; pass <= n; pass++) {
    const share = shareOut(shortfall, cap, budget)
    placed = employees.map((e, i) => placeOffDesk(e, desk[i] ?? [], share[i], limits))
    let changed = false
    for (let i = 0; i < n; i++) {
      const got = hoursOf(placed[i])
      if (got < share[i]) {
        cap[i] = got
        changed = true
      }
    }
    if (!changed) break
  }
  return placed
}

/**
 * Hands out `budget` one hour at a time to whoever is furthest below target, skipping anyone at
 * their cap. Ranking by the real shortfall rather than the cap keeps someone whose cap was lowered
 * from losing their place in the queue.
 */
function shareOut(shortfall: readonly number[], cap: readonly number[], budget: number): number[] {
  const share = cap.map(() => 0)
  for (let left = budget; left > 0; left--) {
    let best = -1
    for (let i = 0; i < cap.length; i++) {
      if (share[i] >= cap[i]) continue
      if (best < 0 || shortfall[i] - share[i] > shortfall[best] - share[best]) best = i
    }
    if (best < 0) break
    share[best]++
  }
  return share
}

/**
 * Places up to `hours` off-desk hours for one person around their desk shifts.
 *
 * Blocks sit only in hours the person is available and not already at the desk, keep each day
 * within the daily limit, and keep any continuous stretch (desk and off-desk together) within the
 * longest-shift limit. At most one off-desk block per day. Each block is chosen greedily: longest
 * first, then fewest not-preferred hours, then joined onto a desk shift, then on a day they're in
 * anyway, so hours tend to come in a few solid blocks at times the person likes.
 */
export function placeOffDesk(
  employee: Employee,
  desk: readonly ShiftBlock[],
  hours: number,
  limits: OffDeskLimits,
): ShiftBlock[] {
  const worked = new Array<number>(DAYS_PER_WEEK).fill(0)
  const dayHours = new Array<number>(DAYS_PER_WEEK).fill(0)
  for (const b of desk) {
    for (let h = b.startHour; h < b.endHour; h++) worked[b.day] |= 1 << h
    dayHours[b.day] += b.endHour - b.startHour
  }

  const out: ShiftBlock[] = []
  const usedDay = new Array<boolean>(DAYS_PER_WEEK).fill(false)
  let left = hours

  while (left > 0) {
    let best: { block: ShiftBlock; score: number } | null = null
    for (let day = 0; day < DAYS_PER_WEEK; day++) {
      if (usedDay[day]) continue
      const room = limits.maxDailyHours - dayHours[day]
      const maxLength = Math.min(left, room, limits.maxShiftLength)
      if (maxLength <= 0) continue
      const free = (h: number) =>
        h >= 0 && h < HOURS_PER_DAY &&
        !(worked[day] & (1 << h)) &&
        employee.availability[slotIndex(day, h)] !== Availability.Unavailable

      for (let start = 0; start < HOURS_PER_DAY; start++) {
        let notPreferred = 0
        for (let end = start + 1; end <= start + maxLength && free(end - 1); end++) {
          if (employee.availability[slotIndex(day, end - 1)] === Availability.NotPreferred) notPreferred++
          // The continuous stretch this block would join, desk hours either side included.
          let from = start
          while (from > 0 && worked[day] & (1 << (from - 1))) from--
          let to = end
          while (to < HOURS_PER_DAY && worked[day] & (1 << to)) to++
          if (to - from > limits.maxShiftLength) continue

          const length = end - start
          const joinsDesk = from < start || to > end
          const score = length * 10 - notPreferred * 6 + (joinsDesk ? 3 : 0) + (dayHours[day] > 0 ? 1 : 0)
          if (!best || score > best.score) best = { block: { day, startHour: start, endHour: end }, score }
        }
      }
    }
    if (!best) break
    out.push(best.block)
    usedDay[best.block.day] = true
    left -= best.block.endHour - best.block.startHour
  }
  return out.sort((a, b) => a.day - b.day || a.startHour - b.startHour)
}
