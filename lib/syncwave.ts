/**
 * The approach this one replaces: mirror the host's commands.
 *
 * Ported from `demo/sync-bench` so the comparison lives next to the thing it is a
 * comparison with. It models the `syncwave-webrtc` prototype — play / pause / seek /
 * ratechange relayed from a host, snapshots every two seconds, and a hard seek when
 * drift exceeds `SYNCWAVE_TOLERANCE`.
 *
 * It is kept faithful rather than fair. Each flag in `SyncwaveDefectFlags` is a real
 * behaviour of that prototype, and each can be turned off individually — so a
 * sceptic can ask "is the comparison only winning because of the bugs?" and get an
 * answer instead of an assurance. Turn all four off and the remaining gap is the
 * structural one: a mirrored command carries a position in the *host's* timeline, and
 * on a live stream that is not a coordinate the follower shares.
 */

import { SYNCWAVE_TOLERANCE } from './protocol.ts'

export type SyncwaveMsg =
  | { type: 'state'; time: number; paused: boolean; rate: number; at: number; seq: number }
  | { type: 'play'; time: number; rate: number; at: number; seq: number }
  | { type: 'pause'; time: number; at: number; seq: number }
  | { type: 'seek'; time: number; paused: boolean; at: number; seq: number }
  | { type: 'rate'; rate: number; at: number; seq: number }

export interface SyncwaveHostState {
  /** The host's media position, in the host's own timeline. */
  time: number
  paused: boolean
  rate: number
  /** Local monotonic instant at which the message was applied. */
  localAt: number
  lastSeq?: number
}

export interface SyncwaveDefectFlags {
  /**
   * The prototype ignores the `at` timestamp on a command, so the host's position is
   * treated as current at the moment of *arrival*. Every follower therefore sits one
   * one-way delay behind, permanently and invisibly.
   */
  ignoreAt: boolean
  /**
   * A rate change replaces the rate without projecting the position forward first,
   * so the playhead jumps backward by however long the previous rate had been
   * running.
   */
  rateBug: boolean
  /** A seek inside the tolerance is discarded, so a small deliberate seek is lost. */
  tolerantSeek: boolean
  /** No sequence checking, so a reordered delivery is applied and then undone. */
  noSequence: boolean
}

export const DEFAULT_SYNCWAVE_DEFECTS: SyncwaveDefectFlags = {
  ignoreAt: true,
  rateBug: true,
  tolerantSeek: true,
  noSequence: true,
}

export const NO_SYNCWAVE_DEFECTS: SyncwaveDefectFlags = {
  ignoreAt: false,
  rateBug: false,
  tolerantSeek: false,
  noSequence: false,
}

/**
 * Where the follower thinks the host is now.
 *
 * Note what this cannot do: it projects forward from a position in the host's
 * timeline. There is no step at which the host's coordinate is translated into the
 * follower's, because a mirrored command carries no information that would allow it.
 */
export function calculateSyncwaveTarget(host: SyncwaveHostState, nowMonotonic: number): number {
  if (host.paused) return host.time
  return host.time + ((nowMonotonic - host.localAt) / 1000) * host.rate
}

export function applySyncwaveMessage(
  msg: SyncwaveMsg,
  current: SyncwaveHostState | null,
  receivedAtMonotonic: number,
  defects: SyncwaveDefectFlags = DEFAULT_SYNCWAVE_DEFECTS,
): SyncwaveHostState | null {
  if (current && !defects.noSequence && current.lastSeq !== undefined) {
    if (msg.seq <= current.lastSeq) return current
  }

  switch (msg.type) {
    case 'state':
      return {
        time: msg.time,
        paused: msg.paused,
        rate: msg.rate,
        localAt: receivedAtMonotonic,
        lastSeq: msg.seq,
      }
    case 'play':
      return {
        time: msg.time,
        paused: false,
        rate: msg.rate,
        localAt: receivedAtMonotonic,
        lastSeq: msg.seq,
      }
    case 'pause':
      return {
        time: msg.time,
        paused: true,
        rate: current?.rate ?? 1,
        localAt: receivedAtMonotonic,
        lastSeq: msg.seq,
      }
    case 'seek':
      return {
        time: msg.time,
        paused: msg.paused,
        rate: current?.rate ?? 1,
        localAt: receivedAtMonotonic,
        lastSeq: msg.seq,
      }
    case 'rate': {
      if (!current) {
        return {
          time: 0,
          paused: true,
          rate: msg.rate,
          localAt: receivedAtMonotonic,
          lastSeq: msg.seq,
        }
      }
      if (defects.rateBug) {
        return { ...current, rate: msg.rate, localAt: receivedAtMonotonic, lastSeq: msg.seq }
      }
      return {
        time: calculateSyncwaveTarget(current, receivedAtMonotonic),
        paused: current.paused,
        rate: msg.rate,
        localAt: receivedAtMonotonic,
        lastSeq: msg.seq,
      }
    }
    default:
      return current
  }
}

export interface SyncwaveCorrection {
  kind: 'none' | 'seek'
  driftSeconds: number
  targetSeconds: number
}

export function decideSyncwaveCorrection(
  currentTimeS: number,
  host: SyncwaveHostState,
  nowMonotonic: number,
  options: { tolerance?: number; tolerantSeek?: boolean; isExplicitSeek?: boolean } = {},
): SyncwaveCorrection {
  const tolerance = options.tolerance ?? SYNCWAVE_TOLERANCE
  const targetSeconds = calculateSyncwaveTarget(host, nowMonotonic)
  const driftSeconds = currentTimeS - targetSeconds

  // An explicit seek is an instruction, not an observation of drift, so it should be
  // honoured whatever the current error happens to be. The prototype puts it through
  // the same tolerance test as ordinary drift, which silently discards any seek
  // smaller than 750 ms — the lead nudges back a few hundred milliseconds to re-watch
  // a touch, and the follower simply does not move.
  if (options.isExplicitSeek && options.tolerantSeek !== true) {
    return { kind: 'seek', driftSeconds, targetSeconds }
  }

  if (Math.abs(driftSeconds) <= tolerance) {
    return { kind: 'none', driftSeconds, targetSeconds }
  }
  return { kind: 'seek', driftSeconds, targetSeconds }
}

/** The permanent lag introduced by ignoring `at`, in seconds. */
export function syncwaveLatencyBias(oneWayDelayMs: number, ignoreAt = true): number {
  return ignoreAt ? oneWayDelayMs / 1000 : 0
}

/**
 * What a command-mirroring host would put on the wire for a given operator action.
 * `leadMediaTime` is the host's own `currentTime` — which is the whole problem.
 */
export function intentToSyncwaveMsg(
  reason: 'play' | 'pause' | 'seek' | 'rate' | 'heartbeat',
  leadMediaTime: number,
  paused: boolean,
  rate: number,
  seq: number,
  at: number,
): SyncwaveMsg {
  switch (reason) {
    case 'play':
      return { type: 'play', time: leadMediaTime, rate, at, seq }
    case 'pause':
      return { type: 'pause', time: leadMediaTime, at, seq }
    case 'seek':
      return { type: 'seek', time: leadMediaTime, paused, at, seq }
    case 'rate':
      return { type: 'rate', rate, at, seq }
    default:
      return { type: 'state', time: leadMediaTime, paused, rate, at, seq }
  }
}
