import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { promises as fs, existsSync, createWriteStream } from 'fs'
import { spawn } from 'child_process'
import path from 'path'
import { pipeline } from 'stream/promises'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const DOWNLOAD_DIR = '/home/z/my-project/download'
const TRACK_DIR = path.join(DOWNLOAD_DIR, 'track')
const TRACK_BATCH = 100
const CONCURRENCY = 25

type Paper = {
  doi: string; title: string; journal?: string
  year?: string; authors?: string; abstract?: string
}

type DLFile = { filename: string; doi: string; size: number }
type TrackEntry = { doi: string; title: string; filename: string; added_at: number }

const safeFilename = (doi: string) => doi.replaceAll(/[^A-Za-z0-9._-]/g, '_')

const parseDoiInput = (s: string): string => {
  const m = (s || '').match(/\b10\.\d{4,9}\/[^\s"<>]+/)
  if (!m) return ''
  return m[0].replace(/[.,;)]+$/, '')
}

// ---------- CrossRef ----------
function parseCrossRefItem(it: any): Paper {
  const authors = (it.author || []).map((a: any) =>
    [a.given, a.family].filter(Boolean).join(' ')
  ).join(', ')
  let year: string | undefined
  const dp = it.published?.['date-parts']?.[0]
  if (dp && dp[0]) year = String(dp[0])
  else if (it.published?.year) year = String(it.published.year)
  let abstract: string | undefined
  if (it.abstract) abstract = it.abstract.replace(/<[^>]+>/g, '').trim()
  const title = Array.isArray(it.title) ? it.title[0] : it.title
  const journal = Array.isArray(it['container-title']) ? it['container-title'][0] : it['container-title']
  return {
    doi: it.DOI, title: title || '',
    journal: journal || undefined, year,
    authors: authors || undefined, abstract,
  }
}

async function fetchRandom(n: number): Promise<Paper[]> {
  const url = `https://api.crossref.org/works?sample=${n}&select=DOI,title,author,container-title,published,abstract,type,publisher`
  const res = await fetch(url, { headers: { 'User-Agent': UA }, cache: 'no-store' })
  if (!res.ok) throw new Error(`CrossRef random failed: ${res.status}`)
  const data = await res.json()
  const items = data.message?.items || []
  return items.map(parseCrossRefItem).filter((p: Paper) => p.doi && p.title)
}

async function lookupDoi(doi: string): Promise<Paper | null> {
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) return null
  const data = await res.json()
  return parseCrossRefItem(data.message)
}

// ---------- sci-hub helpers ----------
// §7.4 PDF URL extraction (in order of preference)
function extractPdfUrl(html: string, base: string): string {
  let m = html.match(/class\s*=\s*"download"[\s\S]*?<a[^>]+href\s*=\s*"([^"]+)"/i)
  if (m) return toAbsolute(m[1], base)
  m = html.match(/<meta[^>]+name\s*=\s*["']citation_pdf_url["'][^>]+content\s*=\s*["']([^"']+)["']/i)
  if (m) return toAbsolute(m[1], base)
  m = html.match(/\/storage\/[^"'\s<>]+\.pdf/i)
  if (m) return toAbsolute(m[0], base)
  return ''
}

function toAbsolute(url: string, base: string): string {
  try { return new URL(url, base).toString() }
  catch { return url }
}

function mergeCookies(prev: string, res: Response): string {
  let setCookie: string[] = []
  try { setCookie = (res.headers as any).getSetCookie?.() || [] } catch {}
  if (setCookie.length === 0) {
    const raw = res.headers.get('set-cookie')
    if (raw) setCookie = [raw]
  }
  if (setCookie.length === 0) return prev
  const map = new Map<string, string>()
  for (const part of prev.split(';').map(s => s.trim()).filter(Boolean)) {
    const i = part.indexOf('=')
    if (i > 0) map.set(part.slice(0, i), part.slice(i + 1))
  }
  for (const sc of setCookie) {
    const pair = sc.split(';')[0]
    const i = pair.indexOf('=')
    if (i > 0) map.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim())
  }
  return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join('; ')
}

// §7.1 Step 4-5 altcha proof-of-work — OPTIMIZED binary buffer compare (≈2x faster than hex+startsWith)
function solveAltcha(challengeJson: any): { payload: string; number: number; took: number } {
  const { algorithm, challenge, maxNumber, salt, signature } = challengeJson
  const target = Buffer.from(challenge, 'hex')
  const tlen = target.length
  const start = Date.now()
  for (let n = 0; n <= maxNumber; n++) {
    const hash = createHash('sha256').update(salt + String(n)).digest()
    let ok = true
    for (let i = 0; i < tlen; i++) {
      if (hash[i] !== target[i]) { ok = false; break }
    }
    if (ok) {
      const took = Date.now() - start
      const payload = { algorithm, challenge, number: n, salt, signature, test: false, took }
      return { payload: Buffer.from(JSON.stringify(payload)).toString('base64'), number: n, took }
    }
  }
  throw new Error('altcha: no solution found in range')
}

type ResolveResult = { pdfUrl: string; reason?: string; error?: string }

// §7.1 resolvePdf(doi) → pdfUrl — with classified errors
async function resolvePdf(doi: string, baseUrl: string): Promise<ResolveResult> {
  let cookies = ''
  const doiUrl = `${baseUrl}/${doi}`
  let res: Response
  try {
    res = await fetch(doiUrl, { headers: { 'User-Agent': UA, 'Accept': 'text/html' } })
  } catch {
    return { pdfUrl: '', reason: 'DOMAIN_DOWN', error: `Cannot reach ${baseUrl}` }
  }
  if (res.status === 404) return { pdfUrl: '', reason: 'NOT_FOUND', error: 'Not found on this mirror (404)' }
  if (res.status === 403) return { pdfUrl: '', reason: 'BLOCKED', error: 'Blocked by server (403)' }
  if (res.status >= 500) return { pdfUrl: '', reason: 'SERVER_ERROR', error: `Server error (${res.status})` }
  cookies = mergeCookies('', res)
  let html = await res.text()

  if (!html.includes('/captcha/challenge')) {
    const pdfUrl = extractPdfUrl(html, baseUrl)
    return pdfUrl ? { pdfUrl } : { pdfUrl: '', reason: 'NO_PDF', error: 'PDF not available on this mirror' }
  }

  const m = html.match(/\/captcha\/challenge\/(\d+)/)
  if (!m) return { pdfUrl: '', reason: 'NO_PDF', error: 'No challenge id found' }
  const id = m[1]

  try {
    res = await fetch(`${baseUrl}/captcha/challenge/${id}`, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json', Cookie: cookies },
    })
  } catch {
    return { pdfUrl: '', reason: 'DOMAIN_DOWN', error: `Challenge fetch failed on ${baseUrl}` }
  }
  cookies = mergeCookies(cookies, res)
  let challengeJson: any
  try { challengeJson = await res.json() }
  catch { return { pdfUrl: '', reason: 'CAPTCHA_FAILED', error: 'Invalid challenge JSON' } }

  let payload: string
  try { ({ payload } = solveAltcha(challengeJson)) }
  catch { return { pdfUrl: '', reason: 'CAPTCHA_FAILED', error: 'Proof-of-work unsolvable' } }

  try {
    res = await fetch(`${baseUrl}/captcha/solution/${id}`, {
      method: 'POST',
      headers: {
        'User-Agent': UA, 'Content-Type': 'application/json', 'Accept': 'application/json',
        Cookie: cookies, Referer: doiUrl, Origin: baseUrl,
      },
      body: JSON.stringify({ captcha: payload }),
    })
  } catch {
    return { pdfUrl: '', reason: 'DOMAIN_DOWN', error: `Solution submit failed on ${baseUrl}` }
  }
  cookies = mergeCookies(cookies, res)
  const sol = await res.json().catch(() => ({} as any))
  if (!sol.success) return { pdfUrl: '', reason: 'CAPTCHA_FAILED', error: 'Captcha rejected' }

  try {
    res = await fetch(doiUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html', Cookie: cookies, Referer: doiUrl },
    })
  } catch {
    return { pdfUrl: '', reason: 'DOMAIN_DOWN', error: `Reload failed on ${baseUrl}` }
  }
  html = await res.text()
  const pdfUrl = extractPdfUrl(html, baseUrl)
  return pdfUrl ? { pdfUrl } : { pdfUrl: '', reason: 'NO_PDF', error: 'PDF not available after captcha' }
}

function stripHtml(s: string): string {
  return (s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .trim()
}

// §7.5 similar-page article block parser
function parseSimilar(html: string): Paper[] {
  const out: Paper[] = []
  const re = /<a[^>]*class\s*=\s*"article"[^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const block = m[0]
    const href = block.match(/href\s*=\s*"([^"]+)"/)?.[1] || ''
    const doi = href.replace(/^\//, '')
    const title = stripHtml(block.match(/<div[^>]*class\s*=\s*"title"[^>]*>([\s\S]*?)<\/div>/i)?.[1] || '')
    const journal = stripHtml(block.match(/<span[^>]*class\s*=\s*"journal"[^>]*>([\s\S]*?)<\/span>/i)?.[1] || '')
    const year = stripHtml(block.match(/<span[^>]*class\s*=\s*"year"[^>]*>([\s\S]*?)<\/span>/i)?.[1] || '')
    const abstract = stripHtml(block.match(/<div[^>]*class\s*=\s*"abstract"[^>]*>([\s\S]*?)<\/div>/i)?.[1] || '')
    if (doi && title) {
      out.push({ doi, title, journal: journal || undefined, year: year || undefined, abstract: abstract || undefined })
    }
  }
  return out
}

// §7.2 fetchRelated(doi)
async function fetchRelated(doi: string, baseUrl: string): Promise<Paper[]> {
  let cookies = ''
  const similarUrl = `${baseUrl}/similar/${doi}`
  let res: Response
  try {
    res = await fetch(similarUrl, { headers: { 'User-Agent': UA, 'Accept': 'text/html' } })
  } catch { return [] }
  if (!res.ok) return []
  cookies = mergeCookies('', res)
  let html = await res.text()
  if (html.includes('/captcha/challenge')) {
    const m = html.match(/\/captcha\/challenge\/(\d+)/)
    if (m) {
      const id = m[1]
      try {
        const r2 = await fetch(`${baseUrl}/captcha/challenge/${id}`, {
          headers: { 'User-Agent': UA, 'Accept': 'application/json', Cookie: cookies },
        })
        cookies = mergeCookies(cookies, r2)
        const ch = await r2.json()
        const { payload } = solveAltcha(ch)
        await fetch(`${baseUrl}/captcha/solution/${id}`, {
          method: 'POST',
          headers: {
            'User-Agent': UA, 'Content-Type': 'application/json', 'Accept': 'application/json',
            Cookie: cookies, Referer: similarUrl, Origin: baseUrl,
          },
          body: JSON.stringify({ captcha: payload }),
        })
        res = await fetch(similarUrl, {
          headers: { 'User-Agent': UA, 'Accept': 'text/html', Cookie: cookies, Referer: similarUrl },
        })
        html = await res.text()
      } catch { /* fall through with whatever html we have */ }
    }
  }
  return parseSimilar(html)
}

// multi-domain fallback — tries each domain until one yields a PDF URL
async function resolveWithFallback(doi: string, domains: string[]): Promise<{ pdfUrl: string; domain?: string; reason?: string; error?: string }> {
  const tried: string[] = []
  for (const domain of domains) {
    const base = `https://${domain}`
    const { pdfUrl, reason, error } = await resolvePdf(doi, base)
    if (pdfUrl) return { pdfUrl, domain }
    tried.push(`${domain}: ${reason}`)
    // only try next domain if this one didn't clearly say "no PDF on this mirror"
    // (NO_PDF is often mirror-specific; DOMAIN_DOWN means try next)
    if (reason === 'NO_PDF' || reason === 'NOT_FOUND') continue
    if (reason === 'DOMAIN_DOWN' || reason === 'SERVER_ERROR') continue
    // CAPTCHA_FAILED / BLOCKED — try next too
    continue
  }
  return { pdfUrl: '', reason: 'ALL_DOMAINS_FAILED', error: tried.join('; ') || 'No domains configured' }
}

// ---------- Track store (batched JSON, rotate at 100) ----------
async function currentTrackFile(): Promise<string> {
  await fs.mkdir(TRACK_DIR, { recursive: true })
  let i = 1
  while (true) {
    const f = path.join(TRACK_DIR, `papers${String(i).padStart(3, '0')}.json`)
    if (!existsSync(f)) return f
    try {
      const data = JSON.parse(await fs.readFile(f, 'utf8'))
      if ((data.papers || []).length < TRACK_BATCH) return f
    } catch { return f }
    i++
  }
}

async function markDownloaded(doi: string, title: string, filename: string): Promise<void> {
  const f = await currentTrackFile()
  let data: any = { papers: [] }
  if (existsSync(f)) {
    try { data = JSON.parse(await fs.readFile(f, 'utf8')) } catch { data = { papers: [] } }
  }
  if (!data.papers) data.papers = []
  // avoid duplicates
  if (data.papers.some((p: TrackEntry) => p.doi === doi)) return
  data.papers.push({ doi, title, filename, added_at: Date.now() })
  await fs.writeFile(f, JSON.stringify(data, null, 2))
}

async function getAllTrackEntries(): Promise<TrackEntry[]> {
  const names = await fs.readdir(TRACK_DIR).catch(() => [] as string[])
  const out: TrackEntry[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const data = JSON.parse(await fs.readFile(path.join(TRACK_DIR, name), 'utf8'))
      for (const p of data.papers || []) out.push(p)
    } catch {}
  }
  return out
}

// ---------- Zip (system zip command, fast native) ----------
async function createZipOfFiles(files: string[], outputName: string): Promise<string> {
  const outPath = path.join(DOWNLOAD_DIR, outputName)
  try { await fs.unlink(outPath) } catch {}
  await fs.mkdir(DOWNLOAD_DIR, { recursive: true })
  if (files.length === 0) {
    // minimal valid empty zip (EOCD record)
    await fs.writeFile(outPath, Buffer.from('PK\x05\x06' + '\x00'.repeat(18)))
    return outPath
  }
  const args = files.length > 50 ? ['-j', '-q', outPath, '-@'] : ['-j', '-q', outPath, ...files]
  const proc = spawn('zip', args, { cwd: DOWNLOAD_DIR })
  if (files.length > 50) {
    proc.stdin.write(files.join('\n'))
    proc.stdin.end()
  }
  await new Promise<void>((res, rej) => {
    const chunks: Buffer[] = []
    proc.stderr.on('data', d => chunks.push(d))
    proc.on('close', code => code === 0 ? res() : rej(new Error('zip failed: ' + Buffer.concat(chunks).toString())))
    proc.on('error', rej)
  })
  return outPath
}

// ---------- Download (resumable via Range) ----------
async function downloadPdf(doi: string, pdfUrl: string): Promise<{ filename: string; success: boolean; error?: string; size?: number }> {
  const filename = `${safeFilename(doi)}.pdf`
  const target = path.join(DOWNLOAD_DIR, filename)
  await fs.mkdir(DOWNLOAD_DIR, { recursive: true })
  if (existsSync(target)) {
    const st = await fs.stat(target)
    return { filename, success: true, size: st.size }
  }
  const partial = `${target}.partial`
  let startPos = 0
  try {
    const st = await fs.stat(partial)
    startPos = st.size
  } catch {}
  const headers: Record<string, string> = { 'User-Agent': UA, 'Accept': '*/*' }
  if (startPos > 0) headers['Range'] = `bytes=${startPos}-`
  const res = await fetch(pdfUrl, { headers })
  if (!res.ok && res.status !== 206) {
    return { filename, success: false, error: `download HTTP ${res.status}` }
  }
  const writeStream = createWriteStream(partial, { flags: startPos > 0 ? 'a' : 'w' })
  if (!res.body) return { filename, success: false, error: 'no response body' }
  await pipeline(res.body as any, writeStream)
  await fs.rename(partial, target)
  const st = await fs.stat(target)
  return { filename, success: true, size: st.size }
}

// ---------- Concurrency pool (no rate limiting) ----------
async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let idx = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}

// ---------- Routes ----------
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const action = url.searchParams.get('action')
  try {
    if (action === 'random') {
      const n = Math.min(parseInt(url.searchParams.get('n') || '20', 10) || 20, 100)
      const papers = await fetchRandom(n)
      return NextResponse.json({ papers })
    }
    if (action === 'lookup') {
      const doi = parseDoiInput(url.searchParams.get('doi') || '')
      if (!doi) return NextResponse.json({ error: 'no doi' }, { status: 400 })
      const paper = await lookupDoi(doi)
      return NextResponse.json({ paper })
    }
    if (action === 'search') {
      const doi = parseDoiInput(url.searchParams.get('doi') || '')
      if (!doi) return NextResponse.json({ error: 'no doi' }, { status: 400 })
      const domains = (url.searchParams.get('domains') || 'sci-hub.su').split(',').map(s => s.trim()).filter(Boolean)
      const paper = await lookupDoi(doi)
      let related: Paper[] = []
      for (const d of domains) {
        related = await fetchRelated(doi, `https://${d}`)
        if (related.length) break
      }
      return NextResponse.json({ paper, related })
    }
    if (action === 'list') {
      await fs.mkdir(DOWNLOAD_DIR, { recursive: true })
      const names = await fs.readdir(DOWNLOAD_DIR)
      const out: DLFile[] = []
      for (const name of names) {
        if (!name.endsWith('.pdf')) continue
        const full = path.join(DOWNLOAD_DIR, name)
        const st = await fs.stat(full)
        const doi = name.replace(/\.pdf$/, '').replaceAll('_', '/')
        out.push({ filename: name, doi, size: st.size })
      }
      return NextResponse.json({ files: out })
    }
    if (action === 'track') {
      const entries = await getAllTrackEntries()
      return NextResponse.json({ entries, count: entries.length })
    }
    if (action === 'track-backup') {
      const tnames = (await fs.readdir(TRACK_DIR).catch(() => [] as string[])).filter(f => f.endsWith('.json'))
      const files = tnames.map(f => path.join(TRACK_DIR, f))
      const zipName = `track-backup-${Date.now()}.zip`
      await createZipOfFiles(files, zipName)
      return NextResponse.json({ zipUrl: `/api/papers?action=open&file=${encodeURIComponent(zipName)}` })
    }
    if (action === 'open') {
      const file = url.searchParams.get('file') || ''
      const target = path.join(DOWNLOAD_DIR, path.basename(file))
      if (!existsSync(target)) return NextResponse.json({ error: 'not found' }, { status: 404 })
      const buf = await fs.readFile(target)
      const isZip = file.endsWith('.zip')
      return new NextResponse(buf, {
        headers: {
          'Content-Type': isZip ? 'application/zip' : 'application/pdf',
          'Content-Disposition': `${isZip ? 'attachment' : 'inline'}; filename="${path.basename(file)}"`,
          'Content-Length': String(buf.length),
        },
      })
    }
    return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()

    // single download
    if (body.action === 'download') {
      const doi = parseDoiInput(body.doi)
      if (!doi) return NextResponse.json({ success: false, reason: 'NO_DOI', error: 'no doi' }, { status: 400 })
      const domains = (body.domains && body.domains.length ? body.domains : ['sci-hub.su']).map((d: string) => d.replace(/^https?:\/\//, '').replace(/\/$/, ''))
      const { pdfUrl, domain, reason, error } = await resolveWithFallback(doi, domains)
      if (!pdfUrl) return NextResponse.json({ success: false, reason: reason || 'NO_PDF', error: error || 'no pdf url' })
      const r = await downloadPdf(doi, pdfUrl)
      if (!r.success) return NextResponse.json({ success: false, reason: 'DOWNLOAD_FAILED', error: r.error })
      await markDownloaded(doi, body.title || doi, r.filename)
      return NextResponse.json({ success: true, filename: r.filename, domain, size: r.size })
    }

    // bulk parallel — streaming NDJSON
    if (body.action === 'bulk') {
      const items: { doi: string; title: string }[] = (body.items || []).filter((x: any) => x && parseDoiInput(x.doi)).map((x: any) => ({ doi: parseDoiInput(x.doi), title: x.title || x.doi }))
      const mode: 'loose' | 'zip' = body.mode === 'zip' ? 'zip' : 'loose'
      const domains: string[] = (body.domains && body.domains.length ? body.domains : ['sci-hub.su']).map((d: string) => d.replace(/^https?:\/\//, '').replace(/\/$/, ''))
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        async start(controller) {
          const send = (obj: any) => { try { controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n')) } catch {} }
          const okResults: { doi: string; filename: string }[] = []
          await pool(items, CONCURRENCY, async (item) => {
            try {
              const { pdfUrl, domain, reason, error } = await resolveWithFallback(item.doi, domains)
              if (!pdfUrl) {
                send({ doi: item.doi, success: false, reason: reason || 'NO_PDF', error: error || 'no pdf url' })
                return
              }
              const r = await downloadPdf(item.doi, pdfUrl)
              if (r.success) {
                await markDownloaded(item.doi, item.title, r.filename)
                okResults.push({ doi: item.doi, filename: r.filename })
                send({ doi: item.doi, success: true, filename: r.filename, domain, size: r.size })
              } else {
                send({ doi: item.doi, success: false, reason: 'DOWNLOAD_FAILED', error: r.error })
              }
            } catch (e: any) {
              send({ doi: item.doi, success: false, reason: 'EXCEPTION', error: e?.message || String(e) })
            }
          })
          if (mode === 'zip' && okResults.length > 0) {
            const zipName = `${(body.zipName || 'papers').replace(/\.zip$/i, '')}.zip`
            try {
              const files = okResults.map(r => path.join(DOWNLOAD_DIR, r.filename))
              await createZipOfFiles(files, zipName)
              send({ type: 'zip-ready', zipUrl: `/api/papers?action=open&file=${encodeURIComponent(zipName)}`, count: okResults.length })
            } catch (e: any) {
              send({ type: 'zip-error', error: e?.message || String(e) })
            }
          }
          send({ type: 'done', total: items.length, succeeded: okResults.length })
          controller.close()
        },
      })
      return new NextResponse(stream, {
        headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' },
      })
    }

    return NextResponse.json({ success: false, error: 'unknown action' }, { status: 400 })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 })
  }
}
