'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

// Light, clean, tiny
const C = {
  bg: '#ffffff', surface: '#ffffff', border: '#ececec', borderStrong: '#d4d4d4',
  text: '#111111', muted: '#6a6a6a', dim: '#9a9a9a',
  selBg: '#f2f2f2', selBorder: '#111111',
  idle: '#111111', orange: '#c2410c', green: '#16a34a', red: '#dc2626',
  overlay: 'rgba(0,0,0,0.35)',
}
const R = { row: 3, btn: 3, pill: 3 }
const mono = 'ui-monospace, "SF Mono", Menlo, "Cascadia Code", monospace'

type Paper = {
  doi: string; title: string; journal?: string; year?: string
  authors?: string; abstract?: string
}
type DLState = 'idle' | 'resolving' | 'done' | 'failed'
type Mode = 'main' | 'classics' | 'distances'

// filename-style row — title + state button, nothing else
function PaperRow({ paper, state, error, selected, onDownload, onRelated, onPress, onClick }: {
  paper: Paper; state: DLState; error?: string; selected: boolean
  onDownload: () => void; onRelated?: () => void; onPress: (p: Paper) => void; onClick: (p: Paper) => void
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suppressed = useRef(false)
  const down = (e: React.PointerEvent) => {
    e.preventDefault()
    suppressed.current = false
    timer.current = setTimeout(() => { suppressed.current = true; onPress(paper) }, 380)
  }
  const up = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null } }
  const leave = up
  const click = () => { if (suppressed.current) { suppressed.current = false; return } onClick(paper) }
  const btnColor = state === 'done' ? C.green : state === 'failed' ? C.red : state === 'resolving' ? C.orange : C.idle
  const btnLabel = state === 'done' ? 'open' : state === 'failed' ? '—' : state === 'resolving' ? '…' : 'get'
  return (
    <div onPointerDown={down} onPointerUp={up} onPointerLeave={leave} onPointerCancel={up} onClick={click}
      style={{ borderBottom: `1px solid ${C.border}`, background: selected ? C.selBg : C.bg, cursor: 'pointer', userSelect: 'none', WebkitUserSelect: 'none', touchAction: 'none' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 9px' }}>
        {selected && <span style={{ width: 6, height: 6, background: C.selBorder, borderRadius: 1, display: 'inline-block', flexShrink: 0 }} />}
        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: C.text, lineHeight: 1.3 }}>{paper.title}</div>
        {onRelated && state !== 'resolving' && (
          <button onClick={(e) => { e.stopPropagation(); onRelated() }}
            style={{ background: 'transparent', color: C.muted, border: `1px solid ${C.border}`, padding: '2px 5px', fontSize: 10, cursor: 'pointer', borderRadius: R.btn, fontFamily: mono, flexShrink: 0 }}>rel</button>
        )}
        <button onClick={(e) => { e.stopPropagation(); onDownload() }} disabled={state === 'resolving'}
          style={{ background: btnColor, color: '#fff', border: 'none', padding: '2px 6px', fontSize: 10, cursor: state === 'resolving' ? 'default' : 'pointer', borderRadius: R.btn, fontFamily: mono, flexShrink: 0, opacity: state === 'resolving' ? 0.5 : 1, minWidth: 26 }}>{btnLabel}</button>
      </div>
      {state === 'failed' && error && (
        <div style={{ padding: '0 9px 5px', fontSize: 10, color: C.red, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{error}</div>
      )}
    </div>
  )
}

export default function Home() {
  const [mode, setMode] = useState<Mode>('main')
  const [domains, setDomains] = useState<string[]>(() => {
    try { const s = localStorage.getItem('domains'); return s ? JSON.parse(s) : ['sci-hub.su'] } catch { return ['sci-hub.su'] }
  })
  useEffect(() => { try { localStorage.setItem('domains', JSON.stringify(domains)) } catch {} }, [domains])

  const [showDomains, setShowDomains] = useState(false)
  const [showTrack, setShowTrack] = useState(false)
  const [trackEntries, setTrackEntries] = useState<{ doi: string; title: string; filename: string; added_at: number }[]>([])
  const [toast, setToast] = useState<string | null>(null)
  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2200) }

  // main
  const [input, setInput] = useState('')
  const [searched, setSearched] = useState<Paper | null>(null)
  const [related, setRelated] = useState<Paper[]>([])
  const [searching, setSearching] = useState(false)
  const [showRelated, setShowRelated] = useState(false)

  // classics
  const [bulkText, setBulkText] = useState('')
  const [bulkPapers, setBulkPapers] = useState<Paper[]>([])
  const [bulkLooking, setBulkLooking] = useState(false)

  // distances
  const [rand, setRand] = useState<Paper[]>([])
  const [loadingRand, setLoadingRand] = useState(false)
  const randEnd = useRef<HTMLDivElement | null>(null)

  // shared download state
  const [dlStates, setDlStates] = useState<Record<string, DLState>>({})
  const [dlErrors, setDlErrors] = useState<Record<string, string>>({})

  // selection
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const selectedRef = useRef(selected); selectedRef.current = selected
  const selectingRef = useRef(selecting); selectingRef.current = selecting

  // zip dialog
  const [zipDialog, setZipDialog] = useState<{ items: Paper[]; mode: 'loose' | 'zip' } | null>(null)
  const [zipName, setZipName] = useState('')

  const openFile = (filename: string) => {
    const a = document.createElement('a')
    a.href = `/api/papers?action=open&file=${encodeURIComponent(filename)}`
    a.download = filename
    a.style.display = 'none'
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
  }

  const setDl = (doi: string, s: DLState, err?: string) => {
    setDlStates(p => ({ ...p, [doi]: s }))
    if (err !== undefined) setDlErrors(p => ({ ...p, [doi]: err }))
  }

  const singleDownload = async (paper: Paper) => {
    setDl(paper.doi, 'resolving')
    try {
      const res = await fetch('/api/papers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'download', doi: paper.doi, title: paper.title, domains }) })
      const data = await res.json()
      if (data.success) { setDl(paper.doi, 'done'); showToast(`got ${data.filename}`) }
      else setDl(paper.doi, 'failed', `${data.reason || 'failed'}: ${data.error || ''}`.slice(0, 140))
    } catch (e: any) { setDl(paper.doi, 'failed', e?.message || String(e)) }
  }

  // streaming bulk download — reads NDJSON, updates per-paper
  const bulkDownload = async (items: Paper[], mode: 'loose' | 'zip', zipName?: string) => {
    if (items.length === 0) { showToast('nothing selected'); return }
    items.forEach(p => setDl(p.doi, 'resolving'))
    setSelecting(false); setSelected(new Set())
    try {
      const res = await fetch('/api/papers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'bulk', items: items.map(p => ({ doi: p.doi, title: p.title })), mode, zipName, domains }) })
      const reader = res.body!.getReader()
      const dec = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n'); buf = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const ev = JSON.parse(line)
            if (ev.type === 'zip-ready') { openFile(ev.zipUrl.split('file=')[1]) }
            else if (ev.type === 'done') { showToast(`done: ${ev.succeeded}/${ev.total}`) }
            else if (ev.doi) {
              if (ev.success) { setDl(ev.doi, 'done'); if (mode === 'loose' && ev.filename) openFile(ev.filename) }
              else setDl(ev.doi, 'failed', `${ev.reason || 'failed'}: ${ev.error || ''}`.slice(0, 140))
            }
          } catch {}
        }
      }
    } catch (e: any) { showToast(e?.message || String(e)) }
  }

  // main: search → CrossRef lookup + related (parallel-ish, related after lookup)
  const search = async () => {
    const doi = parseDoi(input)
    if (!doi) { showToast('no doi'); return }
    setSearching(true); setSearched(null); setRelated([]); setShowRelated(false)
    try {
      const res = await fetch(`/api/papers?action=search&doi=${encodeURIComponent(doi)}&domains=${encodeURIComponent(domains.join(','))}`)
      const data = await res.json()
      if (data.paper) setSearched(data.paper)
      if (data.related?.length) setRelated(data.related)
      if (data.error) showToast(data.error)
    } catch (e) { showToast(e as string) }
    finally { setSearching(false) }
  }

  // classics: fetch = parallel CrossRef metadata lookup (FAST, no download)
  const fetchBulk = async () => {
    const dois = parseBulk(bulkText)
    if (dois.length === 0) { showToast('no dois'); return }
    const capped = dois.slice(0, 600)
    setBulkLooking(true); setBulkPapers([])
    try {
      const res = await fetch('/api/papers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'lookup-bulk', dois: capped }) })
      const data = await res.json()
      if (data.papers) setBulkPapers(data.papers)
      const missing = capped.length - (data.papers?.length || 0)
      if (missing > 0) showToast(`${data.papers?.length || 0}/${capped.length} found`)
    } catch (e) { showToast(e as string) }
    finally { setBulkLooking(false) }
  }

  // distances: infinite random
  const loadRandom = useCallback(async (n = 30) => {
    setLoadingRand(true)
    try {
      const res = await fetch(`/api/papers?action=random&n=${n}`)
      const data = await res.json()
      if (data.papers) setRand(prev => { const s = new Set(prev.map(p => p.doi)); return [...prev, ...data.papers.filter((p: Paper) => !s.has(p.doi))] })
      if (data.error) showToast(data.error)
    } catch (e) { showToast(e as string) }
    finally { setLoadingRand(false) }
  }, [])
  useEffect(() => { if (mode === 'distances' && rand.length === 0) loadRandom(30) }, [mode, rand.length, loadRandom])
  useEffect(() => {
    const el = randEnd.current; if (!el || mode !== 'distances') return
    const obs = new IntersectionObserver(e => { if (e[0].isIntersecting && !loadingRand) loadRandom(30) }, { rootMargin: '600px' })
    obs.observe(el); return () => obs.disconnect()
  }, [loadingRand, loadRandom, mode])

  // track
  const loadTrack = async () => {
    try { const r = await fetch('/api/papers?action=track'); const d = await r.json(); setTrackEntries(d.entries || []) }
    catch (e) { showToast(e as string) }
  }

  // selection
  const toggleSel = (doi: string) => setSelected(prev => { const n = new Set(prev); if (n.has(doi)) n.delete(doi); else n.add(doi); return n })
  const onPress = (p: Paper) => { if (!selectingRef.current) setSelecting(true); toggleSel(p.doi) }
  const onCardClick = (p: Paper) => { if (selectingRef.current) toggleSel(p.doi) }

  const selectedPapers = (list: Paper[]) => list.filter(p => selected.has(p.doi))
  const allPapers = () => mode === 'classics' ? bulkPapers : mode === 'distances' ? rand : (searched ? [searched, ...related] : related)

  const requestZip = (items: Paper[]) => { setZipName(''); setZipDialog({ items, mode: 'zip' }) }
  const confirmZip = () => { if (!zipName.trim()) { showToast('need a name'); return } bulkDownload(zipDialog!.items, 'zip', zipName.trim()); setZipDialog(null) }

  const btnStyle = (active = false): React.CSSProperties => ({
    background: active ? C.text : 'transparent', color: active ? '#fff' : C.muted,
    border: `1px solid ${active ? C.text : C.borderStrong}`, padding: '3px 7px', fontSize: 10,
    cursor: 'pointer', borderRadius: R.btn, fontFamily: mono, lineHeight: 1.4,
  })

  const renderRow = (p: Paper, opts: { related?: () => void } = {}) => (
    <PaperRow key={p.doi} paper={p} state={dlStates[p.doi] || 'idle'} error={dlErrors[p.doi]}
      selected={selected.has(p.doi)}
      onDownload={() => singleDownload(p)} onRelated={opts.related} onPress={onPress} onClick={onCardClick} />
  )

  const listWrap: React.CSSProperties = { flex: 1, overflow: 'auto', maxWidth: 720, margin: '0 auto', width: '100%' }

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text, fontFamily: mono, display: 'flex', flexDirection: 'column' }}>
      {/* top bar — tiny, no name, no nav */}
      <header style={{ display: 'flex', gap: 5, padding: '6px 8px', borderBottom: `1px solid ${C.borderStrong}`, position: 'sticky', top: 0, background: C.bg, zIndex: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <button style={btnStyle(mode === 'main')} onClick={() => setMode('main')}>main</button>
        <button style={btnStyle(mode === 'classics')} onClick={() => setMode('classics')}>/classics</button>
        <button style={btnStyle(mode === 'distances')} onClick={() => setMode('distances')}>/distances</button>
        <div style={{ flex: 1 }} />
        <button style={btnStyle()} onClick={() => setShowDomains(true)}>domains·{domains.length}</button>
        <button style={btnStyle()} onClick={() => { setShowTrack(true); loadTrack() }}>track</button>
      </header>

      {/* MAIN */}
      {mode === 'main' && (
        <div style={{ padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 6, flex: 1, maxWidth: 720, margin: '0 auto', width: '100%' }}>
          <div style={{ display: 'flex', gap: 5 }}>
            <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') search() }}
              placeholder="doi or url"
              style={{ flex: 1, background: C.surface, color: C.text, border: `1px solid ${C.borderStrong}`, padding: '5px 7px', fontSize: 11, borderRadius: R.btn, outline: 'none', fontFamily: mono }} />
            <button style={{ ...btnStyle(searching), minWidth: 36 }} onClick={search} disabled={searching}>{searching ? '…' : 'go'}</button>
          </div>
          <div style={{ flex: 1, overflow: 'auto', borderTop: `1px solid ${C.border}` }}>
            {searched && renderRow(searched, { related: () => setShowRelated(true) })}
            {showRelated && related.length > 0 && (
              <div>
                <div style={{ padding: '5px 9px', color: C.dim, fontSize: 10, borderBottom: `1px solid ${C.border}` }}>related·{related.length}</div>
                {related.map(p => renderRow(p))}
              </div>
            )}
            {searching && <div style={{ padding: 14, color: C.muted, fontSize: 11, textAlign: 'center' }}>…</div>}
            {!searched && !searching && <div style={{ padding: 14, color: C.dim, fontSize: 11, textAlign: 'center' }}>—</div>}
          </div>
        </div>
      )}

      {/* CLASSICS */}
      {mode === 'classics' && (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, maxWidth: 720, margin: '0 auto', width: '100%' }}>
          <div style={{ padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 5 }}>
            <textarea value={bulkText} onChange={e => setBulkText(e.target.value)} placeholder={'doi|\ndoi|'}
              style={{ width: '100%', minHeight: 70, background: C.surface, color: C.text, border: `1px solid ${C.borderStrong}`, padding: '5px 7px', fontSize: 11, borderRadius: R.btn, outline: 'none', fontFamily: mono, resize: 'vertical' }} />
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              <button style={btnStyle(bulkLooking)} onClick={fetchBulk} disabled={bulkLooking}>{bulkLooking ? '…' : 'fetch'}</button>
              {bulkPapers.length > 0 && <>
                <button style={btnStyle()} onClick={() => requestZip(bulkPapers)}>all·zip</button>
                <button style={btnStyle()} onClick={() => bulkDownload(bulkPapers, 'loose')}>all·loose</button>
              </>}
              {bulkPapers.length > 0 && <span style={{ color: C.dim, fontSize: 10, alignSelf: 'center' }}>{bulkPapers.length}</span>}
            </div>
          </div>
          <div style={{ flex: 1, overflow: 'auto', borderTop: `1px solid ${C.border}` }}>
            {bulkPapers.map(p => renderRow(p))}
            {bulkPapers.length === 0 && !bulkLooking && <div style={{ padding: 14, color: C.dim, fontSize: 11, textAlign: 'center' }}>—</div>}
          </div>
        </div>
      )}

      {/* DISTANCES */}
      {mode === 'distances' && (
        <div style={listWrap}>
          {rand.map(p => renderRow(p, { related: () => { setInput(p.doi); setMode('main') } }))}
          {loadingRand && <div style={{ padding: 12, color: C.muted, fontSize: 11, textAlign: 'center' }}>…</div>}
          <div ref={randEnd} style={{ height: 1 }} />
        </div>
      )}

      {/* selection bar */}
      {selecting && (
        <div style={{ position: 'sticky', bottom: 0, background: C.surface, borderTop: `1px solid ${C.borderStrong}`, padding: '6px 8px', display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap', zIndex: 10 }}>
          <span style={{ color: C.text, fontSize: 10 }}>{selected.size}·sel</span>
          <div style={{ flex: 1 }} />
          <button style={btnStyle()} disabled={selected.size === 0} onClick={() => bulkDownload(selectedPapers(allPapers()), 'loose')}>loose</button>
          <button style={btnStyle()} disabled={selected.size === 0} onClick={() => requestZip(selectedPapers(allPapers()))}>zip</button>
          <button style={btnStyle()} onClick={() => { setSelecting(false); setSelected(new Set()) }}>×</button>
        </div>
      )}

      {/* zip dialog */}
      {zipDialog && (
        <div style={{ position: 'fixed', inset: 0, background: C.overlay, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }} onClick={() => setZipDialog(null)}>
          <div onClick={e => e.stopPropagation()} style={{ background: C.surface, border: `1px solid ${C.borderStrong}`, borderRadius: R.row, padding: 12, display: 'flex', flexDirection: 'column', gap: 7, minWidth: 240, maxWidth: '90vw' }}>
            <div style={{ color: C.muted, fontSize: 10 }}>zip name</div>
            <input autoFocus value={zipName} onChange={e => setZipName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') confirmZip() }}
              style={{ background: C.bg, color: C.text, border: `1px solid ${C.borderStrong}`, padding: '5px 7px', fontSize: 11, borderRadius: R.btn, outline: 'none', fontFamily: mono }} />
            <div style={{ display: 'flex', gap: 5, justifyContent: 'flex-end' }}>
              <button style={btnStyle()} onClick={() => setZipDialog(null)}>×</button>
              <button style={btnStyle(true)} onClick={confirmZip}>go</button>
            </div>
          </div>
        </div>
      )}

      {/* domains modal */}
      {showDomains && (
        <div style={{ position: 'fixed', inset: 0, background: C.overlay, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }} onClick={() => setShowDomains(false)}>
          <div onClick={e => e.stopPropagation()} style={{ background: C.surface, border: `1px solid ${C.borderStrong}`, borderRadius: R.row, padding: 11, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 260, maxWidth: '90vw', maxHeight: '70vh', overflow: 'auto' }}>
            <div style={{ color: C.muted, fontSize: 10 }}>domains (tried in order)</div>
            {domains.map((d, i) => (
              <div key={d} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ color: C.dim, fontSize: 9 }}>{i + 1}</span>
                <span style={{ color: C.text, fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d}</span>
                <button style={{ ...btnStyle(), padding: '1px 5px' }} onClick={() => setDomains(prev => prev.filter(x => x !== d))}>×</button>
              </div>
            ))}
            <DomainAdd onAdd={(d) => setDomains(prev => prev.includes(d) ? prev : [...prev, d])} />
            <button style={{ ...btnStyle(true), marginTop: 3 }} onClick={() => setShowDomains(false)}>done</button>
          </div>
        </div>
      )}

      {/* track modal */}
      {showTrack && (
        <div style={{ position: 'fixed', inset: 0, background: C.overlay, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }} onClick={() => setShowTrack(false)}>
          <div onClick={e => e.stopPropagation()} style={{ background: C.surface, border: `1px solid ${C.borderStrong}`, borderRadius: R.row, padding: 11, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 300, maxWidth: '90vw', maxHeight: '75vh', overflow: 'hidden' }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <div style={{ color: C.muted, fontSize: 10 }}>track·{trackEntries.length}</div>
              <div style={{ flex: 1 }} />
              <button style={btnStyle()} onClick={async () => { const r = await fetch('/api/papers?action=track-backup').then(x => x.json()); if (r.zipUrl) openFile(r.zipUrl.split('file=')[1]) }}>backup</button>
            </div>
            <div style={{ overflow: 'auto', flex: 1 }}>
              {trackEntries.map(t => (
                <div key={t.doi} style={{ padding: '5px 0', borderBottom: `1px solid ${C.border}`, fontSize: 11 }}>
                  <div style={{ color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title || t.doi}</div>
                  <div style={{ color: C.dim, fontSize: 9 }}>{t.doi}</div>
                </div>
              ))}
              {trackEntries.length === 0 && <div style={{ color: C.dim, fontSize: 11, padding: 14, textAlign: 'center' }}>—</div>}
            </div>
            <button style={{ ...btnStyle(true), marginTop: 3 }} onClick={() => setShowTrack(false)}>done</button>
          </div>
        </div>
      )}

      {toast && <div style={{ position: 'fixed', bottom: 12, left: '50%', transform: 'translateX(-50%)', background: C.text, color: '#fff', padding: '6px 12px', fontSize: 10, borderRadius: R.btn, zIndex: 100, maxWidth: '90vw' }}>{toast}</div>}
    </div>
  )
}

function DomainAdd({ onAdd }: { onAdd: (d: string) => void }) {
  const [v, setV] = useState('')
  const submit = () => { if (v.trim()) { onAdd(v.trim().replace(/^https?:\/\//, '').replace(/\/$/, '')); setV('') } }
  return (
    <div style={{ display: 'flex', gap: 5, marginTop: 3 }}>
      <input value={v} onChange={e => setV(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submit() }}
        placeholder="sci-hub.se"
        style={{ flex: 1, background: C.bg, color: C.text, border: `1px solid ${C.borderStrong}`, padding: '4px 6px', fontSize: 11, borderRadius: R.btn, outline: 'none', fontFamily: mono }} />
      <button onClick={submit} style={{ background: 'transparent', color: C.muted, border: `1px solid ${C.borderStrong}`, padding: '4px 8px', fontSize: 11, cursor: 'pointer', borderRadius: R.btn, fontFamily: mono }}>+</button>
    </div>
  )
}

function parseDoi(s: string): string {
  const m = (s || '').match(/\b10\.\d{4,9}\/[^\s"<>]+/)
  if (!m) return ''
  return m[0].replace(/[.,;)]+$/, '')
}

function parseBulk(text: string): string[] {
  return (text || '').split(/[\n|]/).map(s => s.trim()).filter(Boolean).map(s => {
    const m = s.match(/\b10\.\d{4,9}\/[^\s"<>]+/)
    return m ? m[0].replace(/[.,;)]+$/, '') : ''
  }).filter(Boolean)
}
