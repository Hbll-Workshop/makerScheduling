import { projectToProblem } from '../app/project'
import { ConfigError } from '../core/config'
import { diagnoseInfeasible } from '../core/diagnose'
import { buildRules } from '../core/rules/catalog'
import { calibrate, solve, solveWithRestarts, type SearchProgress } from '../core/search/solver'
import type { SolveRequest, SolveResponse } from './protocol'

/**
 * Runs one request to completion, posting progress along the way and exactly one terminal
 * message (`solved`, `calibrated` or `error`).
 *
 * Kept separate from the worker entry point so it can be tested directly — a real Worker is
 * not available under Vitest.
 */
export function handleRequest(request: SolveRequest, post: (response: SolveResponse) => void): void {
  const { runId, project } = request
  try {
    const { employees, config } = projectToProblem(project)
    const budget = {
      rules: buildRules(project.rules),
      maxMillis: project.search.timeLimitSeconds * 1000,
      maxNodes: project.search.maxNodes ?? Infinity,
      onProgress: (progress: SearchProgress) => post({ type: 'progress', runId, progress }),
    }

    if (request.type === 'calibrate') {
      const { bestScore, suggestedThreshold, report } = calibrate(employees, config, budget)
      const diagnosis = bestScore === null ? diagnoseInfeasible(employees, config) : undefined
      post({ type: 'calibrated', runId, bestScore, suggestedThreshold, report, diagnosis })
      return
    }

    // Without a threshold, keep the best `maxResults` found: the same hard-optimising search with
    // restarts that `calibrate` runs, widened from one schedule to a handful of options. With a
    // threshold, one exhaustive pass, since the point is every schedule above it.
    const { schedules, report } = project.search.useThreshold
      ? solve(employees, config, {
          ...budget,
          threshold: project.threshold,
          maxResults: project.search.maxResults,
          tightenToBest: project.search.tightenToBest,
        })
      : solveWithRestarts(employees, config, { ...budget, threshold: -Infinity, maxResults: project.search.maxResults })
    // Nothing found: work out what can't be met, so the message can say exactly what to change.
    const diagnosis = schedules.length === 0 ? diagnoseInfeasible(employees, config) : undefined
    post({ type: 'solved', runId, schedules, report, diagnosis })
  } catch (error) {
    post({
      type: 'error',
      runId,
      message: error instanceof Error ? error.message : String(error),
      problems: error instanceof ConfigError ? error.problems : undefined,
    })
  }
}
