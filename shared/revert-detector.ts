/**
 * Revert detector (Epic Q / story Q1).
 *
 * Pure logic for "did this new commit revert lines from a prior fix commit?"
 * The DevOpsAgent watcher feeds in the relevant data; this module decides
 * whether to fire an alert.
 *
 * Heuristic:
 *  1. A "fix commit" is identified by a subject matching `/fix/i` or by
 *     containing a ticket id (caller passes `isFixCommit: true` for these).
 *  2. For each new commit, we look at its file diffs. For each file that a
 *     prior fix commit also touched, we compute the set of lines the new
 *     commit DELETES vs the set of lines the fix commit ADDED. If the
 *     deletion set overlaps the fix's addition set on at least
 *     `minOverlapLines` (default 1) lines, we flag a revert.
 *  3. We do NOT diff line CONTENT — we use the `(filePath, lineContent)`
 *     pair so reformatted whitespace doesn't trigger false positives.
 *     Callers that want stricter matching can pre-trim.
 */

export interface FixCommitChange {
  /** SHA of the fix commit. */
  sha: string;
  /** ISO timestamp of the fix commit. */
  at: string;
  filePath: string;
  /** Lines this fix commit ADDED. Trim before passing if you want strict match. */
  addedLines: ReadonlyArray<string>;
}

export interface NewCommitFileChange {
  filePath: string;
  /** Lines this new commit DELETED. */
  deletedLines: ReadonlyArray<string>;
}

export interface RevertDetectorInputs {
  /** Recent fix commits to compare against (typically last 30 days). */
  fixCommits: ReadonlyArray<FixCommitChange>;
  /** File-level changes from the new commit being inspected. */
  newCommitChanges: ReadonlyArray<NewCommitFileChange>;
  /** Minimum overlapping lines to qualify as a revert. Default 1. */
  minOverlapLines?: number;
}

export interface RevertHit {
  fixSha: string;
  fixAt: string;
  filePath: string;
  /** Subset of lines that were both added by the fix AND deleted by the new commit. */
  overlapLines: string[];
}

export function detectReverts(input: RevertDetectorInputs): RevertHit[] {
  const minOverlap = input.minOverlapLines ?? 1;

  // Index fix changes by file for O(1) lookup.
  const fixesByFile = new Map<string, FixCommitChange[]>();
  for (const fc of input.fixCommits) {
    const arr = fixesByFile.get(fc.filePath) ?? [];
    arr.push(fc);
    fixesByFile.set(fc.filePath, arr);
  }

  const hits: RevertHit[] = [];
  for (const change of input.newCommitChanges) {
    const candidates = fixesByFile.get(change.filePath);
    if (!candidates || candidates.length === 0) continue;
    const deletedSet = new Set(change.deletedLines);

    for (const fix of candidates) {
      const overlap: string[] = [];
      const seen = new Set<string>(); // dedupe within a fix's add-set
      for (const ln of fix.addedLines) {
        if (deletedSet.has(ln) && !seen.has(ln)) {
          seen.add(ln);
          overlap.push(ln);
        }
      }
      if (overlap.length >= minOverlap) {
        hits.push({
          fixSha: fix.sha,
          fixAt: fix.at,
          filePath: change.filePath,
          overlapLines: overlap,
        });
      }
    }
  }

  // Sort by most-recent fix first so the renderer can show the freshest violation up top.
  hits.sort((a, b) => (b.fixAt < a.fixAt ? -1 : b.fixAt > a.fixAt ? 1 : 0));
  return hits;
}

/** True when commit subject is heuristically a fix. */
export function isLikelyFixSubject(subject: string): boolean {
  return /\bfix(es|ed)?\b/i.test(subject) || /\bbugfix\b/i.test(subject);
}
