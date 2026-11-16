import { ConfigError, DEFAULT_CONFIG, validateProblem } from '../core/config'
import type { Scenario } from '../core/io'
import { suggestOffDesk } from '../core/offDesk'
import { normaliseRuleSettings, type RuleSetting } from '../core/rules/catalog'
import {
  Availability,
  DAYS_PER_WEEK,
  HOURS_PER_DAY,
  WEEK_HOURS,
  slotIndex,
  type Employee,
  type OperatingWindow,
  type Schedule,
  type ScheduleConfig,
  type ShiftBlock,
} from '../core/types'

/**
 * The editor's working document: one repeating week, and the schedule chosen for it.
 *
 * Deliberately plain data — number arrays instead of typed arrays, settings instead of rule
 * objects — so it round-trips through `JSON.stringify` for `localStorage` and through
 * `postMessage` to the solver worker without any custom encoding. {@link projectToProblem}
 * converts it to the solver's types at the boundary.
 */
export interface Project {
  version: 1
  name: string
  operatingHours: (OperatingWindow | null)[]
  /** 168 entries, `slotIndex(day, hour)`. */
  minCoverage: number[]
  shiftRules: ShiftRules
  employees: ProjectEmployee[]
  rules: RuleSetting[]
  threshold: number
  search: SearchSettings
  /** The schedule chosen for the week, or `null` before one is chosen. */
  saved: SavedSchedule | null
  offDesk: OffDeskSettings
}

/** Off-desk work: paid hours away from the desk, from a budget shared by the whole team. */
export interface OffDeskSettings {
  /** Off-desk hours the whole team may use each week. */
  weeklyBudget: number
}

export const DEFAULT_OFF_DESK: OffDeskSettings = { weeklyBudget: 0 }

/**
 * The schedule someone chose. Shifts carry names copied in, so it still reads correctly after the
 * team changes.
 */
export interface SavedSchedule {
  /** ISO timestamp. */
  savedAt: string
  score: number
  /** Everyone on the schedule when it was saved, in roster order — including anyone with no shifts. */
  team: SavedMember[]
  shifts: SavedShift[]
  /**
   * Off-desk shifts, which don't count toward coverage. Suggested when the schedule is saved and
   * editable afterwards. Never overlap the same person's desk shifts or each other.
   */
  offDesk: SavedShift[]
}

export interface SavedMember {
  employeeId: string
  employeeName: string
  targetWeeklyHours: number
}

export interface SavedShift {
  employeeId: string
  employeeName: string
  /** 0 = Monday … 6 = Sunday. */
  day: number
  startHour: number
  endHour: number
}

/**
 * How panels change the project: always via a recipe over the latest state. A paint drag fires
 * many events between renders, and a plain `setProject(next)` built from a stale render would
 * silently drop earlier cells of the stroke.
 */
export type ProjectUpdate = (recipe: (project: Project) => Project) => void

export interface ProjectEmployee {
  id: string
  name: string
  maxWeeklyHours: number
  targetWeeklyHours: number
  /** 168 entries of {@link Availability}. */
  availability: number[]
  /** On the schedule. Off keeps someone on the roster without scheduling them. */
  working: boolean
}

export type ShiftRules = Pick<
  ScheduleConfig,
  | 'minShiftLength'
  | 'maxShiftLength'
  | 'maxDailyHours'
  | 'allowSplitShifts'
  | 'minGapBetweenBlocks'
  | 'maxBlocksPerDay'
  | 'maxConsecutiveDays'
>

export interface SearchSettings {
  maxResults: number
  /** Wall-clock budget. The main stop condition in the UI, since node counts mean little to people. */
  timeLimitSeconds: number
  /** `null` means no node limit — JSON cannot store `Infinity`. */
  maxNodes: number | null
  tightenToBest: boolean
  /**
   * Off: keep the best `maxResults` schedules found, whatever they score — no threshold to pick.
   * On: keep schedules scoring at least `threshold` (the original, exhaustive mode).
   */
  useThreshold: boolean
}

export const DEFAULT_SEARCH: SearchSettings = {
  maxResults: 10,
  timeLimitSeconds: 15,
  maxNodes: null,
  tightenToBest: false,
  useThreshold: false,
}

export function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function shiftRulesOf(config: ScheduleConfig): ShiftRules {
  return {
    minShiftLength: config.minShiftLength,
    maxShiftLength: config.maxShiftLength,
    maxDailyHours: config.maxDailyHours,
    allowSplitShifts: config.allowSplitShifts,
    minGapBetweenBlocks: config.minGapBetweenBlocks,
    maxBlocksPerDay: config.maxBlocksPerDay,
    maxConsecutiveDays: config.maxConsecutiveDays,
  }
}

export function projectFromScenario(scenario: Scenario, search = DEFAULT_SEARCH): Project {
  return {
    version: 1,
    name: scenario.name,
    operatingHours: scenario.config.operatingHours.map((w) => (w ? { ...w } : null)),
    minCoverage: Array.from(scenario.config.minCoverage),
    shiftRules: shiftRulesOf(scenario.config),
    employees: scenario.employees.map((e) => ({
      id: e.id,
      name: e.name,
      maxWeeklyHours: e.maxWeeklyHours,
      targetWeeklyHours: e.targetWeeklyHours,
      availability: Array.from(e.availability),
      working: true,
    })),
    rules: scenario.rules.map((r) => ({ ...r })),
    threshold: scenario.threshold,
    search: { ...search },
    saved: null,
    offDesk: { ...DEFAULT_OFF_DESK },
  }
}

/** What the solver sees: the people working. Results are indexed in {@link workingEmployees}' order. */
export function projectToProblem(project: Project): { employees: Employee[]; config: ScheduleConfig } {
  const { employees, config } = projectRoster(project)
  const working = new Set(workingEmployees(project).map((e) => e.id))
  return { employees: employees.filter((e) => working.has(e.id)), config }
}

/** The employees on the schedule, in roster order. */
export function workingEmployees(project: Project): ProjectEmployee[] {
  return project.employees.filter((e) => e.working)
}

export function setWorking(project: Project, employeeId: string, working: boolean): Project {
  return updateEmployee(project, employeeId, { working })
}

/** Everyone on the roster, working or not. */
function projectRoster(project: Project): { employees: Employee[]; config: ScheduleConfig } {
  return {
    employees: project.employees.map((e) => ({
      id: e.id,
      name: e.name,
      maxWeeklyHours: e.maxWeeklyHours,
      targetWeeklyHours: e.targetWeeklyHours,
      availability: Uint8Array.from(e.availability),
    })),
    config: {
      ...DEFAULT_CONFIG,
      ...project.shiftRules,
      operatingHours: project.operatingHours.map((w) => (w ? { ...w } : null)),
      minCoverage: Uint8Array.from(project.minCoverage),
    },
  }
}

export function projectToScenario(project: Project): Scenario {
  return {
    name: project.name,
    threshold: project.threshold,
    rules: project.rules,
    ...projectRoster(project),
  }
}

/**
 * The parts of a project that change which schedules are valid or how they score. Results built
 * from a project with a different key are out of date.
 */
export function solveKey(p: Project): string {
  return JSON.stringify([
    p.operatingHours, p.minCoverage, p.shiftRules, p.employees, p.rules, p.threshold, p.search.useThreshold,
  ])
}

/** Every reason the solver would refuse this project, or an empty list. */
export function projectProblems(project: Project): string[] {
  const { employees, config } = projectToProblem(project)
  try {
    validateProblem(employees, config)
    return []
  } catch (error) {
    if (error instanceof ConfigError) return error.problems
    throw error
  }
}

export function isOpen(project: Project, day: number, hour: number): boolean {
  const win = project.operatingHours[day]
  return win !== null && hour >= win.startHour && hour < win.endHour
}

/**
 * Hours worth showing in a week grid: from the earliest opening to the latest closing across
 * the week. Rendering all 24 rows would bury a 9-to-5 shop in empty night hours.
 */
export function visibleHours(project: Project): { from: number; to: number } {
  let from = HOURS_PER_DAY
  let to = 0
  for (const win of project.operatingHours) {
    if (!win) continue
    from = Math.min(from, win.startHour)
    to = Math.max(to, win.endHour)
  }
  return from < to ? { from, to } : { from: 8, to: 18 }
}

// ---------------------------------------------------------------------------
// Edits. Each returns a new project; nothing mutates in place, so React state stays honest.
// ---------------------------------------------------------------------------

/**
 * Changes a day's window and clears coverage that would fall outside it. Leaving that coverage
 * in place would make the project unsolvable (the validator rejects coverage demanded while
 * closed) for a reason the admin can no longer see in the grid.
 */
export function setOperatingWindow(project: Project, day: number, win: OperatingWindow | null): Project {
  const operatingHours = project.operatingHours.slice()
  operatingHours[day] = win
  const minCoverage = project.minCoverage.slice()
  for (let hour = 0; hour < HOURS_PER_DAY; hour++) {
    const open = win !== null && hour >= win.startHour && hour < win.endHour
    if (!open) minCoverage[slotIndex(day, hour)] = 0
  }
  return { ...project, operatingHours, minCoverage }
}

/**
 * Opening hours implied by a coverage grid: each day runs from its first hour needing anyone to
 * its last. A day needing nobody is closed. (An hour needing 0 in the middle of a day stays open,
 * just with no minimum: a day has one opening window.)
 */
export function windowsFromCoverage(minCoverage: readonly number[]): (OperatingWindow | null)[] {
  return Array.from({ length: DAYS_PER_WEEK }, (_, day) => {
    let startHour = -1
    let endHour = -1
    for (let hour = 0; hour < HOURS_PER_DAY; hour++) {
      if (minCoverage[slotIndex(day, hour)] > 0) {
        if (startHour < 0) startHour = hour
        endHour = hour + 1
      }
    }
    return startHour < 0 ? null : { startHour, endHour }
  })
}

/** Paints staff needed onto `slots`; opening hours follow the coverage. */
export function paintCoverage(project: Project, slots: Iterable<number>, value: number): Project {
  const minCoverage = paintGrid(project.minCoverage, slots, value)
  return { ...project, minCoverage, operatingHours: windowsFromCoverage(minCoverage) }
}

/** Copies one day's coverage onto other days. */
export function copyDayCoverage(project: Project, from: number, to: readonly number[]): Project {
  const minCoverage = project.minCoverage.slice()
  for (const day of to) {
    for (let hour = 0; hour < HOURS_PER_DAY; hour++) minCoverage[slotIndex(day, hour)] = project.minCoverage[slotIndex(from, hour)]
  }
  return { ...project, minCoverage, operatingHours: windowsFromCoverage(minCoverage) }
}

/** Sets every listed cell of a 168-entry grid to `value`, returning a new grid. */
export function paintGrid(grid: readonly number[], slots: Iterable<number>, value: number): number[] {
  const next = grid.slice()
  for (const slot of slots) next[slot] = value
  return next
}

/** Every slot inside operating hours — the target of "fill all open hours" actions. */
export function openSlots(project: Project): number[] {
  const slots: number[] = []
  for (let day = 0; day < DAYS_PER_WEEK; day++) {
    for (let hour = 0; hour < HOURS_PER_DAY; hour++) {
      if (isOpen(project, day, hour)) slots.push(slotIndex(day, hour))
    }
  }
  return slots
}

/** Open hours someone hasn't marked yet (still unavailable), set to `value`. Hours already marked keep their level. */
export function fillEmptyOpenHours(project: Project, availability: readonly number[], value: number): number[] {
  return paintGrid(availability, openSlots(project).filter((slot) => availability[slot] === Availability.Unavailable), value)
}

export function newEmployee(project: Project): ProjectEmployee {
  const availability = new Array<number>(WEEK_HOURS).fill(Availability.Unavailable)
  for (const slot of openSlots(project)) availability[slot] = Availability.Preferred
  return {
    id: newId(),
    name: `Employee ${project.employees.length + 1}`,
    maxWeeklyHours: 40,
    targetWeeklyHours: 20,
    availability,
    working: true,
  }
}

export function updateEmployee(project: Project, id: string, patch: Partial<ProjectEmployee>): Project {
  return {
    ...project,
    employees: project.employees.map((e) => (e.id === id ? { ...e, ...patch } : e)),
  }
}

// ---------------------------------------------------------------------------
// The saved schedule.
// ---------------------------------------------------------------------------

/**
 * Records `schedule` as the project's schedule, replacing any earlier choice, with off-desk hours
 * suggested from the current budget. `solved` must be the project the schedule was built from:
 * blocks are indexed by its employee order, which later edits may have changed.
 */
export function saveSchedule(project: Project, solved: Project, schedule: Schedule, now = new Date()): Project {
  const working = workingEmployees(solved)
  const shifts = toSavedShifts(working, schedule.blocks)
  const team = working.map((e) => ({ employeeId: e.id, employeeName: e.name, targetWeeklyHours: e.targetWeeklyHours }))
  // Changing the budget doesn't make generated schedules stale, so `solved` may predate it.
  const { employees, config } = projectToProblem(solved)
  const offDesk = toSavedShifts(
    working,
    suggestOffDesk({ employees, desk: schedule.blocks, budget: project.offDesk.weeklyBudget, limits: config }),
  )
  return { ...project, saved: { savedAt: now.toISOString(), score: schedule.score, team, shifts, offDesk } }
}

/** Blocks per person (in `people` order) as saved shifts, sorted by day then time. */
function toSavedShifts(people: readonly { id: string; name: string }[], blocks: readonly (readonly ShiftBlock[])[]): SavedShift[] {
  const shifts: SavedShift[] = []
  people.forEach((person, i) => {
    for (const block of blocks[i] ?? []) {
      shifts.push({ employeeId: person.id, employeeName: person.name, day: block.day, startHour: block.startHour, endHour: block.endHour })
    }
  })
  return sortShifts(shifts)
}

const sortShifts = (shifts: SavedShift[]) =>
  shifts.sort((a, b) => a.day - b.day || a.startHour - b.startHour || a.employeeName.localeCompare(b.employeeName))

export function removeSavedSchedule(project: Project): Project {
  return { ...project, saved: null }
}

export interface SavedRow extends SavedMember {
  shifts: SavedShift[]
  offDesk: SavedShift[]
  deskHours: number
  offDeskHours: number
  /** Desk plus off-desk. */
  hours: number
}

export const shiftHours = (shifts: readonly SavedShift[]) => shifts.reduce((sum, s) => sum + s.endHour - s.startHour, 0)

/** One row per team member of a saved schedule, in roster order, with their shifts and hours. */
export function savedRows(saved: SavedSchedule): SavedRow[] {
  return saved.team.map((member) => {
    const shifts = saved.shifts.filter((s) => s.employeeId === member.employeeId)
    const offDesk = saved.offDesk.filter((s) => s.employeeId === member.employeeId)
    const deskHours = shiftHours(shifts)
    const offDeskHours = shiftHours(offDesk)
    return { ...member, shifts, offDesk, deskHours, offDeskHours, hours: deskHours + offDeskHours }
  })
}

export const blockOf = (s: SavedShift): ShiftBlock => ({ day: s.day, startHour: s.startHour, endHour: s.endHour })

// ---------------------------------------------------------------------------
// Off-desk hours on the saved schedule.
// ---------------------------------------------------------------------------

function withSaved(project: Project, change: (s: SavedSchedule) => SavedSchedule): Project {
  return project.saved ? { ...project, saved: change(project.saved) } : project
}

/**
 * Fresh off-desk suggestions, replacing whatever the schedule had. Uses the roster as it is now
 * (availability, targets), for team members who are still on it.
 */
export function resuggestOffDesk(project: Project): Project {
  const saved = project.saved
  if (!saved) return project
  const { employees: roster, config } = projectRoster(project)
  const byId = new Map(roster.map((e) => [e.id, e]))
  const members = saved.team.filter((m) => byId.has(m.employeeId))
  const employees = members.map((m) => byId.get(m.employeeId)!)
  const desk = members.map((m) => saved.shifts.filter((s) => s.employeeId === m.employeeId).map(blockOf))
  const blocks = suggestOffDesk({ employees, desk, budget: project.offDesk.weeklyBudget, limits: config })
  const people = members.map((m) => ({ id: m.employeeId, name: m.employeeName }))
  return withSaved(project, (s) => ({ ...s, offDesk: toSavedShifts(people, blocks) }))
}

export function clearOffDesk(project: Project): Project {
  return withSaved(project, (s) => ({ ...s, offDesk: [] }))
}

/** Why an off-desk shift can't be added to the saved schedule, or `null` if it can. */
export function offDeskConflict(saved: SavedSchedule, shift: Omit<SavedShift, 'employeeName'>): string | null {
  if (!(Number.isInteger(shift.day) && shift.day >= 0 && shift.day < DAYS_PER_WEEK)) return 'Choose a day.'
  if (!(shift.startHour >= 0 && shift.startHour < shift.endHour && shift.endHour <= HOURS_PER_DAY)) return 'The end must be after the start.'
  const overlaps = (s: SavedShift) =>
    s.employeeId === shift.employeeId && s.day === shift.day && s.startHour < shift.endHour && shift.startHour < s.endHour
  if (saved.shifts.some(overlaps)) return 'That overlaps one of their desk shifts.'
  if (saved.offDesk.some(overlaps)) return 'That overlaps another of their off-desk shifts.'
  return null
}

/** Adds an off-desk shift; ignored if {@link offDeskConflict} finds a problem. */
export function addOffDeskShift(project: Project, shift: SavedShift): Project {
  if (!project.saved || offDeskConflict(project.saved, shift) !== null) return project
  return withSaved(project, (s) => ({ ...s, offDesk: sortShifts([...s.offDesk, { ...shift }]) }))
}

/** Removes the off-desk shift starting at `startHour` on `day` for that person. */
export function removeOffDeskShift(project: Project, employeeId: string, day: number, startHour: number): Project {
  return withSaved(project, (s) => ({
    ...s,
    offDesk: s.offDesk.filter((x) => !(x.employeeId === employeeId && x.day === day && x.startHour === startHour)),
  }))
}

// ---------------------------------------------------------------------------
// Persistence.
// ---------------------------------------------------------------------------

export const STORAGE_KEY = 'scheduleMaker.project.v1'

const isHours = (startHour: unknown, endHour: unknown) =>
  Number.isInteger(startHour) && Number.isInteger(endHour) &&
  (startHour as number) >= 0 && (startHour as number) < (endHour as number) && (endHour as number) <= HOURS_PER_DAY

const isMember = (value: unknown): value is SavedMember => {
  const v = value as Partial<SavedMember> | null
  return typeof v === 'object' && v !== null && typeof v.employeeId === 'string' && typeof v.employeeName === 'string' && Number.isFinite(v.targetWeeklyHours)
}

/** Earlier versions kept a week's Monday and shift dates; days since that Monday give the weekday. */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
function daysBetween(from: string, to: string): number | null {
  const ms = (date: string) => {
    const m = ISO_DATE.exec(date)
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN
  }
  const days = (ms(to) - ms(from)) / 86_400_000
  return Number.isInteger(days) ? days : null
}

/**
 * A shift from storage, or `null` if malformed. Earlier versions stored a `date`; with the week's
 * Monday in `weekStart`, it becomes that week's weekday.
 */
function normaliseShift(raw: unknown, weekStart: string | null): SavedShift | null {
  const v = raw as Partial<SavedShift> & { date?: unknown } | null
  if (typeof v !== 'object' || v === null || typeof v.employeeId !== 'string' || typeof v.employeeName !== 'string') return null
  if (!isHours(v.startHour, v.endHour)) return null
  let day = v.day
  if (day === undefined && typeof v.date === 'string' && weekStart) day = daysBetween(weekStart, v.date) ?? undefined
  if (!(Number.isInteger(day) && day! >= 0 && day! < DAYS_PER_WEEK)) return null
  return { employeeId: v.employeeId, employeeName: v.employeeName, day: day!, startHour: v.startHour!, endHour: v.endHour! }
}

/**
 * The saved schedule from storage: `null` for none, `undefined` if malformed. Earlier versions kept
 * a list with one schedule per dated week; the most recent becomes the schedule.
 */
function normaliseSaved(raw: unknown): SavedSchedule | null | undefined {
  if (raw === undefined || raw === null) return null
  let entry = raw as Partial<SavedSchedule> & { weekStart?: unknown }
  if (Array.isArray(raw)) {
    if (raw.length === 0) return null
    entry = [...raw].sort((a, b) => String(b?.weekStart).localeCompare(String(a?.weekStart)))[0]
  }
  if (typeof entry !== 'object' || entry === null) return undefined
  if (typeof entry.savedAt !== 'string' || !Number.isFinite(entry.score)) return undefined
  if (!Array.isArray(entry.team) || !entry.team.every(isMember)) return undefined
  const weekStart = typeof entry.weekStart === 'string' ? entry.weekStart : null
  const shifts = (entry.shifts ?? []).map((s: unknown) => normaliseShift(s, weekStart))
  const offDesk = (entry.offDesk ?? []).map((s: unknown) => normaliseShift(s, weekStart))
  if (!Array.isArray(entry.shifts) || shifts.includes(null) || offDesk.includes(null)) return undefined
  return {
    savedAt: entry.savedAt,
    score: entry.score!,
    team: entry.team.map(({ employeeId, employeeName, targetWeeklyHours }) => ({ employeeId, employeeName, targetWeeklyHours })),
    shifts: shifts as SavedShift[],
    offDesk: offDesk as SavedShift[],
  }
}

/**
 * Who was left out, from an earlier version's per-week record: the entry for its last-viewed week,
 * else the closest earlier one.
 */
function legacyExcluded(raw: unknown, weekStart: unknown): Set<string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return new Set()
  const weeks = Object.keys(raw).sort()
  const at = typeof weekStart === 'string' ? weeks.filter((w) => w <= weekStart).pop() : weeks.pop()
  const ids = at === undefined ? [] : (raw as Record<string, unknown>)[at]
  return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [])
}

const isGrid = (value: unknown): value is number[] =>
  Array.isArray(value) && value.length === WEEK_HOURS && value.every((v) => Number.isInteger(v) && v >= 0)

/**
 * Accepts anything that came out of storage or a file and returns a well-formed project, or
 * `null`. Structural problems reject the whole document; merely-missing optional sections
 * (rules, search settings) fall back to defaults so older saves keep loading. Dated time off and
 * pins from earlier versions are dropped.
 */
export function normaliseProject(raw: unknown): Project | null {
  if (typeof raw !== 'object' || raw === null) return null
  const p = raw as Partial<Project> & { excluded?: unknown; weekStart?: unknown }
  if (p.version !== 1 || typeof p.name !== 'string') return null
  if (!Array.isArray(p.operatingHours) || p.operatingHours.length !== DAYS_PER_WEEK) return null
  if (!isGrid(p.minCoverage) || !Array.isArray(p.employees) || typeof p.shiftRules !== 'object') return null

  const out = legacyExcluded(p.excluded, p.weekStart)
  const employees: ProjectEmployee[] = []
  for (const e of p.employees) {
    if (typeof e?.id !== 'string' || typeof e.name !== 'string' || !isGrid(e.availability)) return null
    employees.push({
      id: e.id,
      name: e.name,
      maxWeeklyHours: e.maxWeeklyHours,
      targetWeeklyHours: e.targetWeeklyHours,
      availability: e.availability,
      working: typeof e.working === 'boolean' ? e.working : !out.has(e.id),
    })
  }
  const saved = normaliseSaved(p.saved)
  if (saved === undefined) return null
  return {
    version: 1,
    name: p.name,
    // Opening hours follow coverage now; older saves could hold hours that needed nobody.
    operatingHours: windowsFromCoverage(p.minCoverage),
    minCoverage: p.minCoverage,
    shiftRules: { ...shiftRulesOf(DEFAULT_CONFIG), ...p.shiftRules },
    employees,
    rules: normaliseRuleSettings(p.rules),
    threshold: Number.isFinite(p.threshold) ? p.threshold! : 0,
    search: { ...DEFAULT_SEARCH, ...p.search },
    saved,
    offDesk: normaliseOffDesk(p.offDesk),
  }
}

/** Off-desk settings from storage; missing or nonsense values fall back to no budget. */
function normaliseOffDesk(raw: unknown): OffDeskSettings {
  const budget = (raw as Partial<OffDeskSettings> | null)?.weeklyBudget
  return { weeklyBudget: Number.isInteger(budget) && budget! >= 0 ? budget! : DEFAULT_OFF_DESK.weeklyBudget }
}

/** Storage can be missing or throw (private windows, blocked site data) — treat that as empty. */
export function loadProject(storage: Pick<Storage, 'getItem'> | undefined): Project | null {
  try {
    const text = storage?.getItem(STORAGE_KEY)
    return text ? normaliseProject(JSON.parse(text)) : null
  } catch {
    return null
  }
}

export function saveProject(storage: Pick<Storage, 'setItem'> | undefined, project: Project): boolean {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(project))
    return storage !== undefined
  } catch {
    return false
  }
}
