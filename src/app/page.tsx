'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

// Ink palette — a little bit of border radius (6 cards / 4 buttons)
const C = {
  bg: '#0a0a0a', surface: '#141414', elevated: '#1c1c1c', border: '#2a2a2a',
  text: '#ededed', muted: '#8a8a8a', dim: '#5a5a5a',
  blue: '#6b9fff', green: '#6ee7a0', red: '#ff6b6b', orange: '#ffb454',
}
const R = { card: 6, btn: 4, pill: 4 }
const mono = 'ui-monospace, "SF Mono", Menlo, "Cascadia Code", monospace'

type Paper = {
  doi: string; title: string; journal?: string; year?: string
  authors?: string; abstract?: string
}
type DLState = 'idle' | 'resolving' | 'done' | 'failed'
type Mode = 'main' | 'classics' | 'distances'

function PaperCard({ paper, state, error, selected, selecting, onDownload, onRelated, onPress, onClick }: {
  paper: Paper; state: DLState; error?: string; selected: boolean; selecting: boolean
  onDownload: () => void; onRelated?: () => void; onPress: (p: Paper) => void; onClick: (p: Paper) => void
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suppressed = useRef(false)
  const down = (e: React.PointerEvent) => {
    e.preventDefault()
    suppressed.current = false
    timer.current = setTimeout(() => {
      suppressed.current = true
      onPress(paper)
    }, 420)
  }
  const up = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null } }
  const leave = up
  const click = () => {
    if (suppressed.current) { suppressed.current = false; return }
    onClick(paper)
  }
  const btnColor = state === 'done' ? C.green : state === 'failed' ? C.red : state === 'resolving' ? C.orange : C.blue
  const btnLabel = state === 'done' ? 'open' : state === 'failed' ? '—' : state === 'resolving' ? '…' : 'get'
  return (
    <div onPointerDown={down} onPointerUp={up} onPointerLeave={leave} onPointerCancel={up} onClick={click}
      style={{
        background: selected ? C.elevated : C.surface, border: `1px solid ${selected ? C.blue : C.border}`,
        borderRadius: R.card, padding: 12, display: 'flex', flexDirection: 'column', gap: 6,
        cursor: 'pointer', touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none',
        outline: selected ? `1px solid ${C.blue}` : 'none',
      }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0, flex: 1 }}>
          {paper.year && <span style={{ background: C.elevated, color: C.muted, fontSize: 10, padding: '2px 6px', borderRadius: R.pill }}>{paper.year}</span>}
          {selected && <span style={{ width: 8, height: 8, background: C.blue, borderRadius: 2, display: 'inline-block' }} />}
          {state === 'done' && <span style={{ width: 7, height: 7, background: C.green, borderRadius: '50%', display: 'inline-block' }} />}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {onRelated && state !== 'resolving' && (
            <button onClick={(e) => { e.stopPropagation(); onRelated() }}
              style={{ background: 'transparent', color: C.muted, border: `1px solid ${C.border}`, padding: '4px 8px', fontSize: 11, cursor: 'pointer', borderRadius: R.btn, fontFamily: mono }}>rel</button>
          )}
          <button onClick={(e) => { e.stopPropagation(); onDownload() }}
          disabled={state === 'resolving'}
            style={{ background: btnColor, color: '#0a0a0a', border: 'none', padding: '4px 8px', fontSize: 11, cursor: state === 'resolving' ? 'default' : 'pointer', borderRadius: R.btn, fontFamily: mono, opacity: state === 'resolving' ? 0.6 : 1 }}>
            {btnLabel}
          </button>
        </div>
      </div>
      <div style={{ color: C.text, fontSize: 13, lineHeight: 1.35, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' as const, overflow: 'hidden' }}>
        {paper.title}
      </div>
      {paper.authors && <div style={{ color: C.muted, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{paper.authors}</div>}
      {paper.journal && <div style={{ color: C.muted, fontSize: 11, fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{paper.journal}</div>}
      {state === 'failed' && error && (
        <div style={{ color: C.red, fontSize: 10, lineHeight: 1.3, background: 'rgba(255,107,107,0.08)', padding: '4px 6px', borderRadius: R.pill }}>{error}</div>
      )}
      <div style={{ color: C.dim, fontSize: 10, wordBreak: 'break-all' }}>{paper.doi}</div>
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
  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2500) }

  // main mode
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
      else { setDl(paper.doi, 'failed', `${data.reason || 'failed'}: ${data.error || ''}`.slice(0, 120)) }
    } catch (e: any) { setDl(paper.doi, 'failed', e?.message || String(e)) }
  }

  // streaming bulk — reads NDJSON, updates per-paper
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
              else setDl(ev.doi, 'failed', `${ev.reason || 'failed'}: ${ev.error || ''}`.slice(0, 120))
            }
          } catch {}
        }
      }
    } catch (e: any) { showToast(e?.message || String(e)) }
  }

  // main: search
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

  // classics: parse bulk input (doi|\ndoi| format), lookup each
  const fetchBulk = async () => {
    const dois = parseBulk(bulkText)
    if (dois.length === 0) { showToast('no dois'); return }
    if (dois.length > 600) showToast('capped at 600')
    setBulkLooking(true); setBulkPapers([])
    try {
      const res = await fetch('/api/papers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'bulk', items: dois.slice(0, 600).map(d => ({ doi: d, title: d })), mode: 'loose', domains }) })
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
            if (ev.type === 'done') { setBulkLooking(false) }
            else if (ev.doi) {
              // also lookup CrossRef metadata for title
              const meta = await fetch(`/api/papers?action=lookup&doi=${encodeURIComponent(ev.doi)}`).then(r => r.json()).catch(() => null)
              const p: Paper = meta?.paper || { doi: ev.doi, title: ev.doi }
              setBulkPapers(prev => { const s = new Set(prev.map(x => x.doi)); return s.has(p.doi) ? prev : [...prev, p] })
              if (ev.success) { setDl(ev.doi, 'done') }
              else setDl(ev.doi, 'failed', `${ev.reason || 'failed'}: ${ev.error || ''}`.slice(0, 120))
            }
          } catch {}
        }
      }
    } catch (e) { showToast(e as string); setBulkLooking(false) }
  }

  // distances: infinite random
  const loadRandom = useCallback(async (n = 24) => {
    setLoadingRand(true)
    try {
      const res = await fetch(`/api/papers?action=random&n=${n}`)
      const data = await res.json()
      if (data.papers) setRand(prev => { const s = new Set(prev.map(p => p.doi)); return [...prev, ...data.papers.filter((p: Paper) => !s.has(p.doi))] })
      if (data.error) showToast(data.error)
    } catch (e) { showToast(e as string) }
    finally { setLoadingRand(false) }
  }, [])
  useEffect(() => { if (mode === 'distances' && rand.length === 0) loadRandom(24) }, [mode, rand.length, loadRandom])
  useEffect(() => {
    const el = randEnd.current; if (!el || mode !== 'distances') return
    const obs = new IntersectionObserver(e => { if (e[0].isIntersecting && !loadingRand) loadRandom(24) }, { rootMargin: '500px' })
    obs.observe(el); return () => obs.disconnect()
  }, [loadingRand, loadRandom, mode])

  // track
  const loadTrack = async () => {
    try { const r = await fetch('/api/papers?action=track'); const d = await r.json(); setTrackEntries(d.entries || []) }
    catch (e) { showToast(e as string) }
  }

  // selection handlers
  const toggleSel = (doi: string) => setSelected(prev => { const n = new Set(prev); if (n.has(doi)) n.delete(doi); else n.add(doi); return n })
  const onPress = (p: Paper) => { if (!selectingRef.current) setSelecting(true); toggleSel(p.doi) }
  const onCardClick = (p: Paper) => { if (selectingRef.current) toggleSel(p.doi) }

  const selectedPapers = (list: Paper[]) => list.filter(p => selected.has(p.doi))
  const allPapers = () => mode === 'classics' ? bulkPapers : mode === 'distances' ? rand : (searched ? [searched, ...related] : related)

  const requestZip = (items: Paper[]) => { setZipName(''); setZipDialog({ items, mode: 'zip' }) }
  const confirmZip = () => { if (!zipName.trim()) { showToast('need a name'); return } bulkDownload(zipDialog!.items, 'zip', zipName.trim()); setZipDialog(null) }

  const btnStyle = (active = false): React.CSSProperties => ({
    background: active ? C.text : 'transparent', color: active ? '#0a0a0a' : C.muted,
    border: `1px solid ${active ? C.text : C.border}`, padding: '6px 12px', fontSize: 12,
    cursor: 'pointer', borderRadius: R.btn, fontFamily: mono,
  })

  const renderCard = (p: Paper, opts: { related?: () => void } = {}) => (
    <PaperCard key={p.doi} paper={p} state={dlStates[p.doi] || 'idle'} error={dlErrors[p.doi]}
      selected={selected.has(p.doi)} selecting={selecting}
      onDownload={() => singleDownload(p)} onRelated={opts.related} onPress={onPress} onClick={onCardClick} />
  )

  const grid = (list: Paper[]) => ({
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10, padding: 12,
  })

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text, fontFamily: mono, display: 'flex', flexDirection: 'column' }}>
      {/* top bar — no name, no nav, just mode + utility buttons */}
      <header style={{ display: 'flex', gap: 6, padding: '10px 12px', borderBottom: `1px solid ${C.border}`, position: 'sticky', top: 0, background: C.bg, zIndex: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <button style={btnStyle(mode === 'main')} onClick={() => setMode('main')}>main</button>
        <button style={btnStyle(mode === 'classics')} onClick={() => setMode('classics')}>/classics</button>
        <button style={btnStyle(mode === 'distances')} onClick={() => setMode('distances')}>/distances</button>
        <div style={{ flex: 1 }} />
        <button style={btnStyle()} onClick={() => { setShowDomains(true) }}>domains·{domains.length}</button>
        <button style={btnStyle()} onClick={() => { setShowTrack(true); loadTrack() }}>track</button>
      </header>

      {/* MAIN */}
      {mode === 'main' && (
        <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12, flex: 1 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') search() }}
              placeholder="doi or url"
              style={{ flex: 1, background: C.surface, color: C.text, border: `1px solid ${C.border}`, padding: '8px 10px', fontSize: 13, borderRadius: R.btn, outline: 'none', fontFamily: mono }} />
            <button style={{ ...btnStyle(searching), minWidth: 60 }} onClick={search} disabled={searching}>{searching ? '…' : 'go'}</button>
          </div>
          {searched && (
            <div style={{ ...grid([searched]), padding: 0 }}>
              {renderCard(searched, { related: () => { setShowRelated(true) } })}
            </div>
          )}
          {showRelated && related.length > 0 && (
            <div>
              <div style={{ padding: '0 0 8px', color: C.dim, fontSize: 11 }}>related·{related.length}</div>
              <div style={grid(related)}>{related.map(p => renderCard(p))}</div>
            </div>
          )}
          {!searched && !searching && <div style={{ color: C.dim, fontSize: 12, padding: 20, textAlign: 'center' }}>—</div>}
        </div>
      )}

      {/* CLASSICS */}
      {mode === 'classics' && (
        <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12, flex: 1 }}>
          <textarea value={bulkText} onChange={e => setBulkText(e.target.value)} placeholder={'doi|\ndoi|'}
            style={{ width: '100%', minHeight: 120, background: C.surface, color: C.text, border: `1px solid ${C.border}`, padding: 10, fontSize: 12, borderRadius: R.btn, outline: 'none', fontFamily: mono, resize: 'vertical' }} />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button style={btnStyle(bulkLooking)} onClick={fetchBulk} disabled={bulkLooking}>{bulkLooking ? '…' : 'fetch'}</button>
            {bulkPapers.length > 0 && <>
              <button style={btnStyle()} onClick={() => requestZip(bulkPapers)}>all·zip</button>
              <button style={btnStyle()} onClick={() => bulkDownload(bulkPapers, 'loose')}>all·loose</button>
            </>}
          </div>
          {bulkPapers.length > 0 && <div style={grid(bulkPapers)}>{bulkPapers.map(p => renderCard(p))}</div>}
          {bulkPapers.length === 0 && !bulkLooking && <div style={{ color: C.dim, fontSize: 12, padding: 20, textAlign: 'center' }}>—</div>}
        </div>
      )}

      {/* DISTANCES */}
      {mode === 'distances' && (
        <div style={{ flex: 1 }}>
          {rand.length > 0 && <div style={grid(rand)}>{rand.map(p => renderCard(p, { related: () => { setInput(p.doi); setMode('main'); } }))}</div>}
          {loadingRand && <div style={{ padding: 16, color: C.muted, fontSize: 12, textAlign: 'center' }}>…</div>}
          <div ref={randEnd} style={{ height: 1 }} />
        </div>
      )}

      {/* selection bar */}
      {selecting && (
        <div style={{ position: 'sticky', bottom: 0, background: C.elevated, borderTop: `1px solid ${C.border}`, padding: '10px 12px', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', zIndex: 10 }}>
          <span style={{ color: C.text, fontSize: 12 }}>{selected.size}·sel</span>
          <div style={{ flex: 1 }} />
          <button style={btnStyle()} disabled={selected.size === 0} onClick={() => bulkDownload(selectedPapers(allPapers()), 'loose')}>loose</button>
          <button style={btnStyle()} disabled={selected.size === 0} onClick={() => requestZip(selectedPapers(allPapers()))}>zip</button>
          <button style={btnStyle()} onClick={() => { setSelecting(false); setSelected(new Set()) }}>×</button>
        </div>
      )}

      {/* zip dialog */}
      {zipDialog && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }} onClick={() => setZipDialog(null)}>
          <div onClick={e => e.stopPropagation()} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: R.card, padding: 16, display: 'flex', flexDirection: 'column', gap: 10, minWidth: 280 }}>
            <div style={{ color: C.muted, fontSize: 12 }}>zip name</div>
            <input autoFocus value={zipName} onChange={e => setZipName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') confirmZip() }}
              style={{ background: C.bg, color: C.text, border: `1px solid ${C.border}`, padding: '8px 10px', fontSize: 13, borderRadius: R.btn, outline: 'none', fontFamily: mono }} />
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              <button style={btnStyle()} onClick={() => setZipDialog(null)}>×</button>
              <button style={btnStyle(true)} onClick={confirmZip}>go</button>
            </div>
          </div>
        </div>
      )}

      {/* domains modal */}
      {showDomains && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }} onClick={() => setShowDomains(false)}>
          <div onClick={e => e.stopPropagation()} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: R.card, padding: 16, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 300, maxHeight: '70vh', overflow: 'auto' }}>
            <div style={{ color: C.muted, fontSize: 12 }}>domains (tried in order)</div>
            {domains.map((d, i) => (
              <div key={d} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ color: C.dim, fontSize: 10 }}>{i + 1}</span>
                <span style={{ color: C.text, fontSize: 12, flex: 1 }}>{d}</span>
                <button style={{ ...btnStyle(), padding: '2px 8px' }} onClick={() => setDomains(prev => prev.filter(x => x !== d))}>×</button>
              </div>
            ))}
            <DomainAdd onAdd={(d) => setDomains(prev => prev.includes(d) ? prev : [...prev, d])} />
            <button style={{ ...btnStyle(true), marginTop: 4 }} onClick={() => setShowDomains(false)}>done</button>
          </div>
        </div>
      )}

      {/* track modal */}
      {showTrack && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }} onClick={() => setShowTrack(false)}>
          <div onClick={e => e.stopPropagation()} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: R.card, padding: 16, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 340, maxWidth: 500, maxHeight: '75vh', overflow: 'hidden' }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <div style={{ color: C.muted, fontSize: 12 }}>track·{trackEntries.length}</div>
              <div style={{ flex: 1 }} />
              <button style={btnStyle()} onClick={async () => { const r = await fetch('/api/papers?action=track-backup').then(x => x.json()); if (r.zipUrl) openFile(r.zipUrl.split('file=')[1]) }}>backup</button>
            </div>
            <div style={{ overflow: 'auto', flex: 1 }}>
              {trackEntries.map(t => (
                <div key={t.doi} style={{ padding: '6px 0', borderBottom: `1px solid ${C.border}`, fontSize: 11 }}>
                  <div style={{ color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title || t.doi}</div>
                  <div style={{ color: C.dim, fontSize: 10 }}>{t.doi}</div>
                </div>
              ))}
              {trackEntries.length === 0 && <div style={{ color: C.dim, fontSize: 12, padding: 20, textAlign: 'center' }}>—</div>}
            </div>
            <button style={{ ...btnStyle(true), marginTop: 4 }} onClick={() => setShowTrack(false)}>done</button>
          </div>
        </div>
      )}

      {toast && <div style={{ position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)', background: C.elevated, color: C.text, padding: '8px 14px', fontSize: 12, border: `1px solid ${C.border}`, borderRadius: R.btn, zIndex: 100, maxWidth: '90vw' }}>{toast}</div>}
    </div>
  )
}

function DomainAdd({ onAdd }: { onAdd: (d: string) => void }) {
  const [v, setV] = useState('')
  return (
    <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
      <input value={v} onChange={e => setV(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && v.trim()) { onAdd(v.trim().replace(/^https?:\/\//, '').replace(/\/$/, '')); setV('') } }}
        placeholder="sci-hub.se"
        style={{ flex: 1, background: C.bg, color: C.text, border: `1px solid ${C.border}`, padding: '6px 8px', fontSize: 12, borderRadius: 4, outline: 'none', fontFamily: mono }} />
      <button onClick={() => { if (v.trim()) { onAdd(v.trim().replace(/^https?:\/\//, '').replace(/\/$/, '')); setV('') } }}
        style={{ background: 'transparent', color: C.muted, border: `1px solid ${C.border}`, padding: '6px 10px', fontSize: 12, cursor: 'pointer', borderRadius: 4, fontFamily: mono }}>+</button>
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
