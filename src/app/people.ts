import type { Project } from './project'

/** Up to two letters for an avatar: first and last word, or the first two letters of one word. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  const letters = words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[words.length - 1][0]
  return letters.toUpperCase()
}

/** How many person colours the stylesheet defines (`.person-1` … `.person-8`). */
export const PERSON_COLORS = 8

/**
 * A colour slot for each of `employeeIds`: their place in the roster, so a person keeps one colour
 * on every page and taking someone off the schedule doesn't repaint the rest. Anyone no longer on
 * the roster (a saved schedule outlives its team) takes the slots after it.
 */
export function colorSlots(project: Project, employeeIds: readonly string[]): number[] {
  let departed = project.employees.length
  return employeeIds.map((id) => {
    const at = project.employees.findIndex((e) => e.id === id)
    return at === -1 ? departed++ : at
  })
}

/**
 * The classes that paint a slot. There are only eight hues that stay tellable apart, so the ninth
 * person onwards reuses them with a stripe rather than taking a ninth, muddier hue.
 */
export function personClass(slot: number): string {
  const striped = Math.floor(slot / PERSON_COLORS) % 2 === 1
  return `person-${(slot % PERSON_COLORS) + 1}${striped ? ' person-alt' : ''}`
}
