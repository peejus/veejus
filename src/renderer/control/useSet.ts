import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_BEAT_SETTINGS, type BeatCommand, type BeatSettings } from '@shared/beat'
import type { AnalysisSettings, AudioSource } from '@shared/audio'
import type { FxConfig } from '@shared/fx'
import type { AutoPlaySettings } from '@shared/autoplay'
import type { LayersConfig, MasterSettings } from '@shared/layers'
import type { MidiSettings } from '@shared/midi'
import type { OutputOptions } from '@shared/output'
import type { PadConfig, TriggerSettings } from '@shared/pads'
import type { ClipInfo, LayerSettings, MainResponse, RecentSet } from '@shared/protocol'
import {
  SET_FORMAT,
  SET_VERSION,
  remapPadClips,
  setFingerprint,
  type SetClip,
  type VeejusSet,
} from '@shared/set'
import { request } from './bridge'

/** Wait this long after the last change before autosaving. */
const AUTOSAVE_DELAY_MS = 1500

/** Everything the set is made of, read from (and written back to) the app's hooks. */
export interface SetSources {
  clips: ClipInfo[]
  pads: { banks: PadConfig[][]; settings: TriggerSettings; bank: number }
  layers: LayersConfig
  master: MasterSettings
  fx: FxConfig
  beat: BeatSettings | null
  midi: MidiSettings
  background: string
  libraryPlay: LayerSettings
  audio: { source: AudioSource | null; settings: AnalysisSettings }
  output: OutputOptions
  autoPlay: AutoPlaySettings
}

export interface SetApply {
  pads(p: SetSources['pads']): void
  layers(config: LayersConfig, master: MasterSettings): void
  fx(config: FxConfig): void
  beat(cmd: BeatCommand): void
  midi(settings: MidiSettings): void
  background(hex: string): void
  libraryPlay(s: LayerSettings): void
  audio(source: AudioSource | null, settings: AnalysisSettings): void
  output(o: OutputOptions): void
  /** Sets saved before auto-play existed have none: it is switched off. */
  autoPlay(s: AutoPlaySettings | null): void
}

export interface SetLink {
  path: string | null
  name: string
  dirty: boolean
  busy: boolean
  /** Clips the pads use that couldn't be found (for the relink dialog). */
  missing: SetClip[]
  error: string | null
  recent: RecentSet[]
  save(saveAs?: boolean): Promise<void>
  /** Save straight to a path (no dialog). */
  saveTo(path: string): Promise<void>
  open(path?: string | null): Promise<void>
  newSet(): Promise<void>
  relink(folder?: string | null): Promise<void>
  dismissMissing(): void
  dismissError(): void
  refreshRecent(): void
  /** The current set, as it would be saved (tests and diagnostics). */
  current(): VeejusSet
}

export function buildSet(src: SetSources): VeejusSet {
  return {
    format: SET_FORMAT,
    version: SET_VERSION,
    savedAt: new Date().toISOString(),
    clips: src.clips.map((c) => ({
      id: c.id,
      name: c.name,
      path: c.path,
      relPath: null,
      tags: [...c.tags],
      favorite: c.favorite,
    })),
    pads: src.pads,
    layers: src.layers,
    master: src.master,
    fx: src.fx,
    beat: src.beat ?? DEFAULT_BEAT_SETTINGS,
    midi: src.midi,
    background: src.background,
    libraryPlay: src.libraryPlay,
    audio: src.audio,
    output: src.output,
    autoPlay: src.autoPlay,
  }
}

/** Send the clock settings as commands (the output owns the clock). */
function applyBeat(b: BeatSettings, send: (c: BeatCommand) => void): void {
  send({ type: 'setClockSource', source: b.clockSource })
  if (b.clockSource === 'internal') {
    if (b.tempoMode === 'locked') send({ type: 'setBpm', bpm: b.lockedBpm })
    else send({ type: 'auto' })
  }
  send({ type: 'setPhaseCorrection', enabled: b.phaseCorrection })
  send({ type: 'setLatencyOffset', ms: b.latencyOffsetMs })
  send({ type: 'setPhraseBars', bars: b.phraseBars })
  send({ type: 'setTempoRange', minBpm: b.minBpm, maxBpm: b.maxBpm })
}

const nameOf = (path: string | null) =>
  path
    ? path
        .replaceAll('\\', '/')
        .split('/')
        .pop()!
        .replace(/\.veejus$/i, '')
    : 'Untitled set'

/**
 * Sets: save / open / new, unsaved-change tracking, autosave (for restoring after a restart
 * or crash), recent sets and relinking moved media.
 */
export function useSet(src: SetSources, apply: SetApply): SetLink {
  const [path, setPath] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [missing, setMissing] = useState<SetClip[]>([])
  const [error, setError] = useState<string | null>(null)
  const [recent, setRecent] = useState<RecentSet[]>([])
  const [restored, setRestored] = useState(false)

  const latest = useRef({ src, apply, path })
  useEffect(() => {
    latest.current = { src, apply, path }
  })

  const current = useCallback(() => buildSet(latest.current.src), [])
  const fingerprint = setFingerprint(buildSet(src))
  const dirty = saved !== null ? saved !== fingerprint : restored && src.clips.length > 0

  const refreshRecent = useCallback(() => {
    request({ type: 'listRecentSets' }, 'recentSets')
      .then((r) => setRecent(r.sets))
      .catch(() => {})
  }, [])

  /** Put a loaded set into every part of the app. */
  const applyLoaded = useCallback((r: Extract<MainResponse, { type: 'setLoaded' }>) => {
    const a = latest.current.apply
    const s = r.set
    const banks = remapPadClips(s.pads.banks, r.idMap)
    a.pads({ banks, settings: s.pads.settings, bank: s.pads.bank })
    a.layers(s.layers, s.master)
    a.fx(s.fx)
    applyBeat(s.beat, a.beat)
    a.midi(s.midi)
    a.background(s.background)
    a.libraryPlay(s.libraryPlay)
    a.audio(s.audio.source, s.audio.settings)
    a.output(s.output)
    a.autoPlay(s.autoPlay ?? null)
    setPath(r.path)
    setMissing(r.missing)
  }, [])

  // On start (and after a control-window crash): restore the autosaved session.
  useEffect(() => {
    let cancelled = false
    request({ type: 'restoreSession' }, ['setLoaded', 'noSession'])
      .then((r) => {
        if (cancelled) return
        if (r.type === 'setLoaded') {
          applyLoaded(r)
          // An autosave of a saved set counts as saved unless it had unsaved changes.
          if (!r.dirty && r.path) setSaved('pending')
        }
        setRestored(true)
      })
      .catch(() => setRestored(true))
    refreshRecent()
    return () => {
      cancelled = true
    }
  }, [applyLoaded, refreshRecent])

  // Once the restored state has settled, adopt it as the saved baseline (saved sets only).
  useEffect(() => {
    if (saved !== 'pending') return
    const t = setTimeout(() => setSaved(setFingerprint(buildSet(latest.current.src))), 600)
    return () => clearTimeout(t)
  }, [saved])

  // Autosave shortly after every change (only once the startup restore has run).
  useEffect(() => {
    if (!restored) return
    const t = setTimeout(() => {
      request(
        { type: 'autosave', set: buildSet(latest.current.src), path: latest.current.path, dirty },
        'ok',
      ).catch(() => {})
    }, AUTOSAVE_DELAY_MS)
    return () => clearTimeout(t)
  }, [fingerprint, restored, dirty])

  const save = useCallback(
    async (saveAs = false, to: string | null = null) => {
      setBusy(true)
      setError(null)
      try {
        const set = buildSet(latest.current.src)
        const r = await request({ type: 'saveSet', set, path: to ?? latest.current.path, saveAs }, [
          'setSaved',
          'canceled',
        ])
        if (r.type === 'setSaved') {
          setPath(r.path)
          setSaved(setFingerprint(set))
          refreshRecent()
          // Record it for restore right away (the app may be closed straight after saving).
          await request({ type: 'autosave', set, path: r.path, dirty: false }, 'ok')
        }
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [refreshRecent],
  )

  const open = useCallback(
    async (p: string | null = null) => {
      setBusy(true)
      setError(null)
      try {
        const r = await request({ type: 'openSet', path: p }, ['setLoaded', 'canceled'])
        if (r.type === 'setLoaded') {
          applyLoaded(r)
          setSaved('pending')
          refreshRecent()
        }
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [applyLoaded, refreshRecent],
  )

  const newSet = useCallback(async () => {
    await request({ type: 'newSet' }, 'ok')
    const a = latest.current.apply
    const empty = buildSet({ ...latest.current.src, clips: [] })
    const banks = empty.pads.banks.map((b) => b.map((p) => ({ ...p, source: null })))
    a.pads({ banks, settings: empty.pads.settings, bank: 0 })
    a.autoPlay(null)
    setPath(null)
    setSaved(null)
    setMissing([])
  }, [])

  const relink = useCallback(
    async (folder: string | null = null) => {
      setBusy(true)
      try {
        const r = await request(
          { type: 'relink', folder, clips: missing.map((c) => ({ id: c.id, name: c.name })) },
          ['relinked', 'canceled'],
        )
        if (r.type === 'relinked') {
          const p = latest.current.src.pads
          latest.current.apply.pads({ ...p, banks: remapPadClips(p.banks, r.idMap) })
          setMissing((m) => m.filter((c) => r.missing.includes(c.id)))
        }
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [missing],
  )

  return {
    path,
    name: nameOf(path),
    dirty,
    busy,
    missing,
    error,
    recent,
    save,
    saveTo: useCallback((p: string) => save(false, p), [save]),
    open,
    newSet,
    relink,
    dismissMissing: useCallback(() => setMissing([]), []),
    dismissError: useCallback(() => setError(null), []),
    refreshRecent,
    current,
  }
}
