import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { promises as fs, existsSync, createWriteStream } from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const DOWNLOAD_DIR = '/home/z/my-project/download'

type Paper = {
  doi: string; title: string; journal?: string
  year?: string; authors?: string; abstract?: string
}

type DLFile = { filename: string; title: string; doi: string; size: number }

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

// §7.1 Step 4-5 altcha proof-of-work solver
async function solveAltcha(challengeJson: any): Promise<string> {
  const { algorithm, challenge, maxNumber, salt, signature } = challengeJson
  const algo = algorithm === 'SHA-256' ? 'sha256' : 'sha256'
  const start = Date.now()
  for (let n = 0; n <= maxNumber; n++) {
    const hash = createHash(algo).update(salt + String(n)).digest('hex')
    if (hash.startsWith(challenge)) {
      const took = Date.now() - start
      const payload = { algorithm, challenge, number: n, salt, signature, test: false, took }
      return Buffer.from(JSON.stringify(payload)).toString('base64')
    }
  }
  throw new Error('altcha solve failed')
}

// §7.1 resolvePdf(doi) → pdfUrl
async function resolvePdf(doi: string, baseUrl: string): Promise<{ pdfUrl: string; error?: string }> {
  let cookies = ''
  const doiUrl = `${baseUrl}/${doi}`
  // Step 1: initial GET, capture cookies
  let res = await fetch(doiUrl, { headers: { 'User-Agent': UA, 'Accept': 'text/html' } })
  cookies = mergeCookies('', res)
  let html = await res.text()
  // No captcha interstitial → PDF link already on page, skip to step 7
  if (!html.includes('/captcha/challenge')) {
    const pdfUrl = extractPdfUrl(html, baseUrl)
    return { pdfUrl, error: pdfUrl ? undefined : 'no captcha but no pdf url found' }
  }
  // Step 2: extract challenge id
  const m = html.match(/\/captcha\/challenge\/(\d+)/)
  if (!m) return { pdfUrl: '', error: 'no challenge id' }
  const id = m[1]
  // Step 3: fetch challenge JSON
  res = await fetch(`${baseUrl}/captcha/challenge/${id}`, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json', Cookie: cookies },
  })
  cookies = mergeCookies(cookies, res)
  const challengeJson = await res.json()
  // Step 4-5: solve PoW + build base64 payload
  const payload = await solveAltcha(challengeJson)
  // Step 6: POST solution
  res = await fetch(`${baseUrl}/captcha/solution/${id}`, {
    method: 'POST',
    headers: {
      'User-Agent': UA, 'Content-Type': 'application/json', 'Accept': 'application/json',
      Cookie: cookies, Referer: doiUrl, Origin: baseUrl,
    },
    body: JSON.stringify({ captcha: payload }),
  })
  cookies = mergeCookies(cookies, res)
  const sol = await res.json().catch(() => ({} as any))
  if (!sol.success) return { pdfUrl: '', error: 'captcha solution rejected' }
  // Step 7: reload with verified cookie
  res = await fetch(doiUrl, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html', Cookie: cookies, Referer: doiUrl },
  })
  html = await res.text()
  const pdfUrl = extractPdfUrl(html, baseUrl)
  return { pdfUrl, error: pdfUrl ? undefined : 'no pdf url after captcha' }
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

// §7.2 fetchRelated(doi) → List<Paper>
async function fetchRelated(doi: string, baseUrl: string): Promise<Paper[]> {
  let cookies = ''
  const similarUrl = `${baseUrl}/similar/${doi}`
  let res = await fetch(similarUrl, { headers: { 'User-Agent': UA, 'Accept': 'text/html' } })
  cookies = mergeCookies('', res)
  let html = await res.text()
  if (html.includes('/captcha/challenge')) {
    const m = html.match(/\/captcha\/challenge\/(\d+)/)
    if (m) {
      const id = m[1]
      const r2 = await fetch(`${baseUrl}/captcha/challenge/${id}`, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json', Cookie: cookies },
      })
      cookies = mergeCookies(cookies, r2)
      const ch = await r2.json()
      const payload = await solveAltcha(ch)
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
    }
  }
  return parseSimilar(html)
}

// §8 download — resumable via HTTP Range
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
    return { filename, success: false, error: `download failed: ${res.status}` }
  }
  const writeStream = createWriteStream(partial, { flags: startPos > 0 ? 'a' : 'w' })
  if (!res.body) return { filename, success: false, error: 'no body' }
  await pipeline(res.body as any, writeStream)
  await fs.rename(partial, target)
  const st = await fs.stat(target)
  return { filename, success: true, size: st.size }
}

// ---------- routes ----------
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const action = url.searchParams.get('action')
  try {
    if (action === 'random') {
      const n = Math.min(parseInt(url.searchParams.get('n') || '20', 10) || 20, 100)
      const papers = await fetchRandom(n)
      return NextResponse.json({ papers })
    }
    if (action === 'search') {
      const doi = parseDoiInput(url.searchParams.get('doi') || '')
      if (!doi) return NextResponse.json({ error: 'no doi' }, { status: 400 })
      const domain = (url.searchParams.get('domain') || 'sci-hub.su').replace(/^https?:\/\//, '').replace(/\/$/, '')
      const base = `https://${domain}`
      const looked = await lookupDoi(doi)
      let related: Paper[] = []
      try {
        related = await fetchRelated(doi, base)
      } catch (e: any) {
        console.error('related failed', e?.message || e)
      }
      const papers = [looked, ...related].filter((p): p is Paper => !!p && !!p.doi)
      return NextResponse.json({ papers })
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
        out.push({ filename: name, title: '', doi, size: st.size })
      }
      return NextResponse.json({ files: out })
    }
    if (action === 'open') {
      const file = url.searchParams.get('file') || ''
      const target = path.join(DOWNLOAD_DIR, path.basename(file))
      if (!existsSync(target)) return NextResponse.json({ error: 'not found' }, { status: 404 })
      const buf = await fs.readFile(target)
      return new NextResponse(buf, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="${path.basename(file)}"`,
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
    if (body.action === 'download') {
      const doi = parseDoiInput(body.doi)
      if (!doi) return NextResponse.json({ success: false, error: 'no doi' }, { status: 400 })
      const domain = (body.domain || 'sci-hub.su').replace(/^https?:\/\//, '').replace(/\/$/, '')
      const base = `https://${domain}`
      const { pdfUrl, error } = await resolvePdf(doi, base)
      if (!pdfUrl) return NextResponse.json({ success: false, error: error || 'no pdf url' })
      const result = await downloadPdf(doi, pdfUrl)
      return NextResponse.json({ ...result, pdfUrl })
    }
    return NextResponse.json({ success: false, error: 'unknown action' }, { status: 400 })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 })
  }
}
