/**
 * Files a commit changed, from `git show --name-status -M --format= <commit>`
 * (KC-S3.1.1). kit_commit, kit_commit_all and kit_get_commit_history return
 * these so a caller knows exactly which paths a commit touched, not just how many.
 */

export type CommitFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface CommitFile {
  path: string;
  status: CommitFileStatus;
  /** The old path, for renames. */
  from?: string;
}

const STATUS: Record<string, CommitFileStatus> = {
  A: 'added',
  C: 'added', // a copy is a new path
  M: 'modified',
  T: 'modified', // type change (file <-> symlink)
  D: 'deleted',
  R: 'renamed',
};

export function parseNameStatus(output: string): CommitFile[] {
  const files: CommitFile[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [code, first, second] = line.split('\t');
    const status = STATUS[code.trim().charAt(0)];
    if (!status || !first) continue;
    if ((status === 'renamed' || code.startsWith('C')) && second) {
      files.push(status === 'renamed' ? { path: second, status, from: first } : { path: second, status });
    } else {
      files.push({ path: first, status });
    }
  }
  return files;
}

/** Default cap on kit_get_diff output (KC-S3.1.4). */
export const DEFAULT_DIFF_MAX_BYTES = 200 * 1024;

export interface SessionDiffFile extends CommitFile {
  additions: number;
  deletions: number;
  /** Listed, never inlined in the diff text. */
  binary?: boolean;
}

export interface SessionDiff {
  /** The commit the diff is taken against: the merge-base with the base branch, or `since`. */
  base: string;
  diff: string;
  files: SessionDiffFile[];
  /** True when the diff text was cut at max_bytes. */
  truncated: boolean;
}
