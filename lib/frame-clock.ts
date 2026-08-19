/**
 * Reading the media clock.
 *
 * An event's timestamp is a position in the video, so it has to be read off the
 * video. This does that as precisely as the platform allows and — more
 * importantly — tells you when it could not.
 *
 * Structural types rather than `HTMLVideoElement`, so it is testable without a
 * DOM.
 */

import { FRAME_STALE_MS, type MediaTimeSource } from './protocol.ts'

export interface FrameMetadata {
  /** Presentation timestamp of this frame, in seconds into the asset. */
  mediaTime: number
  /** When this frame is expected on screen, on the `performance.now()` timeline. */
  expectedDisplayTime: number
}

export interface VideoLike {
  currentTime: number
  paused: boolean
  requestVideoFrameCallback?(cb: (now: number, meta: FrameMetadata) => void): number
  cancelVideoFrameCallback?(handle: number): void
}

export interface MediaTimeReading {
  mediaTime: number
  source: MediaTimeSource
}

export interface FrameClockOptions {
  monotonicNow?: () => number
  staleThresholdMs?: number
}

export class FrameClock {
  private readonly monotonicNow: () => number
  private readonly staleThresholdMs: number
  private video: VideoLike | null = null
  private handle: number | null = null
  private lastFrame: FrameMetadata | null = null
  private staleReads = 0
  private supported = false

  constructor(options: FrameClockOptions = {}) {
    this.monotonicNow = options.monotonicNow ?? (() => performance.now())
    this.staleThresholdMs = options.staleThresholdMs ?? FRAME_STALE_MS
  }

  attach(video: VideoLike): void {
    this.detach()
    this.video = video
    this.lastFrame = null
    // Chrome is the only supported browser for collection, so frame callbacks are a
    // requirement rather than an enhancement. The guard stays because calling this
    // unguarded throws and takes the console down with it — but their absence now
    // means the operator is in the wrong browser, which is worth saying out loud
    // instead of silently degrading every timestamp by a frame.
    this.supported = typeof video.requestVideoFrameCallback === 'function'
    if (!this.supported) return

    const tick = (_now: number, meta: FrameMetadata) => {
      this.lastFrame = {
        mediaTime: meta.mediaTime,
        expectedDisplayTime: meta.expectedDisplayTime,
      }
      this.handle = video.requestVideoFrameCallback!(tick)
    }
    this.handle = video.requestVideoFrameCallback!(tick)
  }

  detach(): void {
    if (this.video && this.handle !== null) {
      this.video.cancelVideoFrameCallback?.(this.handle)
    }
    this.video = null
    this.handle = null
    this.lastFrame = null
  }

  /** Feed a frame directly. Tests only. */
  ingestFrame(meta: FrameMetadata): void {
    this.lastFrame = meta
  }

  frameCallbackSupported(): boolean {
    return this.supported
  }

  /**
   * The current media position, plus where the number came from.
   *
   * Frame callbacks stop arriving whenever the page is not being composited: a
   * minimised window, another application covering it, a background tab, a
   * suspended machine. Playback position meanwhile keeps advancing. Trusting the
   * last frame then would stamp events with a picture from seconds earlier and
   * report nothing wrong — **the one route in this design by which a timestamp can
   * be silently incorrect.**
   *
   * So freshness is checked and every reading carries its provenance. A run of
   * `currentTime-stale-frame` readings is an operator-environment fault, and QC
   * should see it directly rather than infer it.
   */
  read(): MediaTimeReading {
    const video = this.video
    if (!video) return { mediaTime: 0, source: 'currentTime' }

    // A paused player presents no new frames; its currentTime is exact anyway.
    if (video.paused) return { mediaTime: video.currentTime, source: 'currentTime' }

    if (!this.lastFrame) {
      return { mediaTime: video.currentTime, source: 'currentTime' }
    }

    const age = this.monotonicNow() - this.lastFrame.expectedDisplayTime
    if (age < this.staleThresholdMs) {
      return { mediaTime: this.lastFrame.mediaTime, source: 'rvfc' }
    }

    this.staleReads++
    return { mediaTime: video.currentTime, source: 'currentTime-stale-frame' }
  }

  /** Presented media time, or null when no fresh frame is available. */
  presentedMediaTime(): number | null {
    if (!this.lastFrame) return null
    const age = this.monotonicNow() - this.lastFrame.expectedDisplayTime
    return age < this.staleThresholdMs ? this.lastFrame.mediaTime : null
  }

  staleReadCount(): number {
    return this.staleReads
  }
}
