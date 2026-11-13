/**
 * The three-way decision table used by two-way sync.
 *
 * For every path we know three digests: `base` (what this machine last synced),
 * `local`, and `remote`. Comparing them separates "this machine changed" from
 * "another machine changed", which a two-way comparison alone cannot do.
 *
 * The table never deletes. A path missing on one side is either a new file on
 * the other side or a deletion we refuse to propagate, and refusing is the only
 * choice that cannot lose data.
 *
 * @module @local/dsh-nas-sync/lib/merge
 */

/** Outcomes of {@link decide}. */
export const PUSH = 'push'
export const PULL = 'pull'
export const NONE = 'none'
export const CONFLICT = 'conflict'
export const KEEP_LOCAL = 'keep-local'
export const KEEP_REMOTE = 'keep-remote'

/**
 * Compare one path across base, local, and remote.
 *
 * @param entry - `{ base, local, remote, localMtime, remoteMtime }`; digests are
 *   `undefined` when the file is absent on that side, and `base` is `undefined`
 *   the first time this machine has ever seen the path.
 * @param policy - how to break a genuine conflict: `both` (default) keeps the
 *   local copy as a side artifact and takes the remote one, `local` and
 *   `remote` pick a winner, `newer` compares modification times.
 * @returns `{ action, reason }` where action is one of the exported constants.
 */
export function decide(entry, policy = 'both') {
  const { base, local, remote, localMtime, remoteMtime } = entry

  if (local === undefined && remote === undefined) {
    return { action: NONE, reason: '仅存在于基线' }
  }
  if (remote === undefined) {
    // The remote no longer has it: a remote deletion. Never propagate a delete.
    return base === undefined
      ? { action: PUSH, reason: '本地新增' }
      : { action: KEEP_LOCAL, reason: '远端已删除，保留本地' }
  }
  if (local === undefined) {
    // This machine no longer has it: a local deletion.
    return base === undefined
      ? { action: PULL, reason: '远端新增' }
      : { action: KEEP_REMOTE, reason: '本地已删除，保留远端' }
  }
  if (local === remote) {
    return { action: NONE, reason: '两端一致' }
  }
  if (base !== undefined && local === base) {
    return { action: PULL, reason: '仅远端改动' }
  }
  if (base !== undefined && remote === base) {
    return { action: PUSH, reason: '仅本地改动' }
  }

  // Either both sides moved, or this machine has no baseline for the path.
  if (base === undefined) {
    return { action: CONFLICT, reason: '无共同基线且内容不同' }
  }
  switch (policy) {
    case 'local':
      return { action: PUSH, reason: '冲突，按策略保留本地' }
    case 'remote':
      return { action: PULL, reason: '冲突，按策略保留远端' }
    case 'newer':
      if (localMtime !== undefined && remoteMtime !== undefined && localMtime !== remoteMtime) {
        return localMtime > remoteMtime
          ? { action: PUSH, reason: '冲突，本地更新' }
          : { action: PULL, reason: '冲突，远端更新' }
      }
      return { action: CONFLICT, reason: '冲突且无法比较时间' }
    default:
      return { action: CONFLICT, reason: '两端都有改动' }
  }
}

/**
 * Name a side artifact that preserves the losing copy of a conflict.
 * @param rel - remote-relative path.
 * @param machine - machine that produced the copy.
 * @param stamp - compact timestamp.
 * @returns a sibling path that no machine will treat as a live file.
 */
export function conflictName(rel, machine, stamp) {
  return `${rel}.conflict-${machine}-${stamp}`
}

/** True when a path is a conflict artifact rather than live content. */
export function isConflictArtifact(rel) {
  return /\.conflict-[^/]+-\d{8}T\d{6}Z$/.test(rel)
}
