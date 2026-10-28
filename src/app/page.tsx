'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

// Halo dark palette (no border radius anywhere)
const C = {
  bg: '#0D0D0D', bgDark: '#000000', card: '#1C1C1E', card2: '#2C2C2E',
  sep: '#38383A', text: '#FFFFFF', text2: '#98989F', text3: '#636366',
  blue: '#0A84FF', red: '#FF453A', green: '#30D158', orange: '#FF9F0A',
}

type Paper = {
  doi: string; title: string; journal?: string; year?: string
  authors?: string; abstract?: string
}

type DLState = 'idle' | 'resolving' | 'downloading' | 'done' | 'failed'

type DLFile = { filename: string; title: string; doi: string; size: number }

const TABS = ['browse', 'related', 'downloads', 'settings'] as const
type Tab = typeof TABS[number]

const safeName = (doi: string) => doi.replaceAll(/[^A-Za-z0-9._-]/g, '_')

const parseDoi = (s: string): string => {
  const m = s.match(/\b10\.\d{4,9}\/[^\s"<>]+/)
  if (!m) return ''
  return m[0].replace(/[.,;)]+$/, '')
}

const clamp = (style: React.CSSProperties) => ({
  ...style,
  display: '-webkit-box',
  WebkitLineClamp: style.WebkitLineClamp ?? 1,
  WebkitBoxOrient: 'vertical' as const,
  overflow: 'hidden',
})

function PaperCard({ paper, state, onDownload, onOpen }: {
  paper: Paper; state: DLState; onDownload: () => void; onOpen: () => void
}) {
  const btnColor =
    state === 'done' ? C.green
    : state === 'failed' ? C.red
    : state === 'resolving' || state === 'downloading' ? C.orange
    : C.blue
  const btnLabel =
    state === 'done' ? 'Open'
    : state === 'failed' ? 'Retry'
    : state === 'resolving' ? 'Resolving…'
    : state === 'downloading' ? 'Downloading…'
    : 'Download'
  return (
    <div style={{
      background: C.card, padding: 12, borderBottom: `1px solid ${C.sep}`,
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {paper.year && (
            <span style={{ background: C.card2, color: C.text2, fontSize: 10, padding: '2px 6px' }}>
              {paper.year}
            </span>
          )}
          {state === 'done' && (
            <span style={{ width: 8, height: 8, background: C.red, display: 'inline-block' }} />
          )}
        </div>
        <button
          onClick={state === 'done' ? onOpen : onDownload}
          style={{
            background: btnColor, color: '#fff', border: 'none',
            padding: '6px 12px', fontSize: 12, cursor: 'pointer', borderRadius: 0,
          }}
        >
          {btnLabel}
        </button>
      </div>
      <div style={clamp({ color: C.text, fontSize: 14, lineHeight: 1.3, WebkitLineClamp: 3 })}>
        {paper.title}
      </div>
      {paper.authors && (
        <div style={{ color: C.text2, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {paper.authors}
        </div>
      )}
      {paper.journal && (
        <div style={{ color: C.text2, fontSize: 11, fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {paper.journal}
        </div>
      )}
      {paper.abstract && (
        <div style={{ color: C.text3, fontSize: 11, lineHeight: 1.4 }}>
          {paper.abstract.slice(0, 160)}{paper.abstract.length > 160 ? '…' : ''}
        </div>
      )}
      <div style={{ color: C.text3, fontSize: 10, wordBreak: 'break-all' }}>{paper.doi}</div>
    </div>
  )
}

export default function Home() {
  const [tab, setTab] = useState<Tab>('browse')
  const [browse, setBrowse] = useState<Paper[]>([])
  const [related, setRelated] = useState<Paper[]>([])
  const [dlFiles, setDlFiles] = useState<DLFile[]>([])
  const [dlStates, setDlStates] = useState<Record<string, DLState>>({})
  const [loadingBrowse, setLoadingBrowse] = useState(false)
  const [loadingRelated, setLoadingRelated] = useState(false)
  const [input, setInput] = useState('')
  const [domain, setDomain] = useState('sci-hub.su')
  const [toast, setToast] = useState<string | null>(null)
  const browseEndRef = useRef<HTMLDivElement | null>(null)

  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2500) }

  const loadRandom = useCallback(async (n = 20) => {
    setLoadingBrowse(true)
    try {
      const res = await fetch(`/api/papers?action=random&n=${n}`)
      const data = await res.json()
      if (data.papers) {
        setBrowse(prev => {
          const seen = new Set(prev.map(p => p.doi))
          return [...prev, ...data.papers.filter((p: Paper) => !seen.has(p.doi))]
        })
      } else if (data.error) showToast(data.error)
    } catch (e) { showToast(String(e)) }
    finally { setLoadingBrowse(false) }
  }, [])

  useEffect(() => { loadRandom(20) }, [loadRandom])

  useEffect(() => {
    const el = browseEndRef.current
    if (!el) return
    const obs = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !loadingBrowse) loadRandom(20)
    }, { rootMargin: '400px' })
    obs.observe(el)
    return () => obs.disconnect()
  }, [loadingBrowse, loadRandom])

  const refreshBrowse = () => { setBrowse([]); loadRandom(20) }

  const refreshDownloads = useCallback(async () => {
    try {
      const res = await fetch('/api/papers?action=list')
      const data = await res.json()
      if (data.files) setDlFiles(data.files)
    } catch (e) { showToast(String(e)) }
  }, [])

  useEffect(() => { if (tab === 'downloads') refreshDownloads() }, [tab, refreshDownloads])

  const search = async () => {
    const doi = parseDoi(input)
    if (!doi) { showToast('No DOI found in input'); return }
    setLoadingRelated(true); setRelated([])
    try {
      const res = await fetch(`/api/papers?action=search&doi=${encodeURIComponent(doi)}&domain=${encodeURIComponent(domain)}`)
      const data = await res.json()
      if (data.papers) setRelated(data.papers)
      if (data.error) showToast(data.error)
    } catch (e) { showToast(String(e)) }
    finally { setLoadingRelated(false) }
  }

  const downloadPaper = async (paper: Paper) => {
    setDlStates(prev => ({ ...prev, [paper.doi]: 'resolving' }))
    try {
      const res = await fetch('/api/papers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'download', doi: paper.doi, title: paper.title, domain }),
      })
      const data = await res.json()
      setDlStates(prev => ({ ...prev, [paper.doi]: data.success ? 'done' : 'failed' }))
      if (data.success) showToast(`Downloaded: ${safeName(paper.doi)}.pdf`)
      else showToast(data.error || 'Download failed')
    } catch (e) {
      setDlStates(prev => ({ ...prev, [paper.doi]: 'failed' }))
      showToast(String(e))
    }
  }

  const openFile = (filename: string) => {
    window.open(`/api/papers?action=open&file=${encodeURIComponent(filename)}`, '_blank')
  }

  const renderCard = (paper: Paper) => (
    <PaperCard key={paper.doi}
      paper={paper}
      state={dlStates[paper.doi] || 'idle'}
      onDownload={() => downloadPaper(paper)}
      onOpen={() => openFile(`${safeName(paper.doi)}.pdf`)}
    />
  )

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text, display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <header style={{ background: C.bgDark, padding: '12px 16px', position: 'sticky', top: 0, zIndex: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, letterSpacing: 2, margin: 0 }}>SUBJECTED</h1>
          <button onClick={() => setTab('settings')} style={{
            background: 'transparent', color: C.text2, border: `1px solid ${C.sep}`,
            padding: '6px 12px', fontSize: 12, cursor: 'pointer', borderRadius: 0,
          }}>Settings</button>
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') search() }}
            placeholder="DOI or URL (10.xxxx/...)"
            style={{
              flex: 1, background: C.card, color: C.text, border: `1px solid ${C.sep}`,
              padding: '8px 10px', fontSize: 13, borderRadius: 0, outline: 'none',
            }}
          />
          <button onClick={search} style={{ background: C.blue, color: '#fff', border: 'none', padding: '8px 14px', fontSize: 13, cursor: 'pointer', borderRadius: 0 }}>→</button>
          <button onClick={refreshBrowse} style={{ background: C.card2, color: C.text, border: 'none', padding: '8px 14px', fontSize: 13, cursor: 'pointer', borderRadius: 0 }}>↻</button>
          <button onClick={() => setInput('')} style={{ background: C.card2, color: C.text, border: 'none', padding: '8px 14px', fontSize: 13, cursor: 'pointer', borderRadius: 0 }}>×</button>
        </div>
        <div style={{ display: 'flex', borderBottom: `1px solid ${C.sep}` }}>
          {TABS.map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              flex: 1, background: 'transparent', color: tab === t ? C.text : C.text3,
              border: 'none', borderBottom: tab === t ? `2px solid ${C.blue}` : '2px solid transparent',
              padding: '10px 0', fontSize: 12, textTransform: 'capitalize', cursor: 'pointer', borderRadius: 0,
            }}>{t}</button>
          ))}
        </div>
      </header>

      {/* Content */}
      <main style={{ flex: 1, overflow: 'auto' }}>
        {tab === 'browse' && (
          <div>
            {browse.map(renderCard)}
            {browse.length === 0 && !loadingBrowse && (
              <div style={{ padding: 20, color: C.text3, textAlign: 'center', fontSize: 13 }}>No papers. Tap ↻ to load.</div>
            )}
            {loadingBrowse && (
              <div style={{ padding: 20, color: C.text2, textAlign: 'center', fontSize: 13 }}>Loading…</div>
            )}
            <div ref={browseEndRef} style={{ height: 1 }} />
          </div>
        )}
        {tab === 'related' && (
          <div>
            {related.map(renderCard)}
            {related.length === 0 && !loadingRelated && (
              <div style={{ padding: 20, color: C.text3, textAlign: 'center', fontSize: 13 }}>Search a DOI to load related papers.</div>
            )}
            {loadingRelated && (
              <div style={{ padding: 20, color: C.text2, textAlign: 'center', fontSize: 13 }}>Resolving…</div>
            )}
          </div>
        )}
        {tab === 'downloads' && (
          <div>
            <div style={{ padding: '10px 16px', color: C.text2, fontSize: 12, borderBottom: `1px solid ${C.sep}` }}>
              Downloaded ({dlFiles.length})
            </div>
            {dlFiles.map(f => (
              <div key={f.filename} style={{ background: C.card, padding: 12, borderBottom: `1px solid ${C.sep}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                <div style={{ flex: 1, overflow: 'hidden' }}>
                  <div style={{ color: C.text, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.filename}</div>
                  <div style={{ color: C.text3, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.title || f.doi}</div>
                  <div style={{ color: C.text3, fontSize: 10 }}>{(f.size / 1024).toFixed(1)} KB</div>
                </div>
                <button onClick={() => openFile(f.filename)} style={{ background: C.green, color: '#fff', border: 'none', padding: '6px 12px', fontSize: 12, cursor: 'pointer', borderRadius: 0 }}>Open</button>
              </div>
            ))}
            {dlFiles.length === 0 && (
              <div style={{ padding: 20, color: C.text3, textAlign: 'center', fontSize: 13 }}>No downloads yet.</div>
            )}
          </div>
        )}
        {tab === 'settings' && (
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label style={{ color: C.text2, fontSize: 12, display: 'block', marginBottom: 6 }}>Sci-Hub domain</label>
              <input value={domain} onChange={e => setDomain(e.target.value)}
                style={{ background: C.card, color: C.text, border: `1px solid ${C.sep}`, padding: '8px 10px', fontSize: 13, width: '100%', borderRadius: 0, outline: 'none' }}
              />
              <div style={{ color: C.text3, fontSize: 11, marginTop: 6 }}>Stored locally. Used for resolvePdf / similar.</div>
            </div>
            <div>
              <label style={{ color: C.text2, fontSize: 12, display: 'block', marginBottom: 6 }}>Download folder</label>
              <div style={{ color: C.text3, fontSize: 12 }}>/home/z/my-project/download/</div>
            </div>
          </div>
        )}
      </main>

      {toast && (
        <div style={{
          position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)',
          background: C.card2, color: C.text, padding: '10px 16px', fontSize: 12,
          border: `1px solid ${C.sep}`, borderRadius: 0, zIndex: 100, maxWidth: '90vw',
        }}>{toast}</div>
      )}
    </div>
  )
}
