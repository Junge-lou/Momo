// store.mjs — 博客文章文件（src/content/blog/**/*.md）的统一读写层
import matter from 'gray-matter'
import { readdir, readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises'
import { join, dirname, basename, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

// 博客内容根目录：cms/server/ -> ../../src/content/blog/
export const BLOG_DIR = fileURLToPath(new URL('../../src/content/blog/', import.meta.url))

export const LANGS = ['zh-cn', 'en']

// 校验相对路径（防止目录穿越）
export function safeRel(rel) {
  if (!rel || typeof rel !== 'string') return null
  const normalized = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalized || normalized.includes('..') || normalized.includes('\0')) return null
  return normalized
}

export function blogPath(rel) {
  return join(BLOG_DIR, ...rel.split('/'))
}

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.isFile()) yield full
  }
}

export function dateStr(v) {
  if (!v) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return String(v).slice(0, 10)
}

// 规范化 frontmatter 字段
export function normalizeData(data) {
  const d = { ...(data || {}) }
  if (d.pubDate) d.pubDate = dateStr(d.pubDate)
  if (typeof d.draft !== 'boolean') d.draft = d.draft ? true : false
  if (typeof d.pinTop !== 'number') d.pinTop = Number(d.pinTop) || 0
  return d
}

// 扫描所有文章（按文件夹分组，每个文件夹 = 一篇逻辑文章的多语言版本）
export async function scanArticles() {
  const byPath = new Map()
  for await (const file of walk(BLOG_DIR)) {
    if (extname(file) !== '.md') continue
    if (basename(file).startsWith('_')) continue
    const rel = file.slice(BLOG_DIR.length).replace(/\\/g, '/').replace(/^\//, '')
    const parts = rel.split('/')
    const lang = parts.pop().replace(/\.md$/, '')
    if (!LANGS.includes(lang)) continue
    const path = parts.join('/')
    if (!byPath.has(path)) byPath.set(path, { files: {} })
    byPath.get(path).files[lang] = file
  }

  const articles = []
  for (const [path, { files }] of byPath) {
    const langs = Object.keys(files).sort()
    let base = null
    const fileData = {}
    for (const lang of langs) {
      const { data } = matter(await readFile(files[lang], 'utf-8'))
      fileData[lang] = data
      if (lang === 'zh-cn' || !base) base = data
    }
    articles.push({
      path,
      langs,
      title: base?.title || '',
      description: base?.description || '',
      category: base?.category || '',
      pubDate: dateStr(base?.pubDate),
      draft: base?.draft ?? false,
      pinTop: base?.pinTop ?? 0,
    })
  }
  return articles
}

// 读取一篇文章的全部语言版本
export async function readArticle(path) {
  const rel = safeRel(path)
  if (!rel) return null
  const dir = blogPath(rel)
  const files = {}
  for (const lang of LANGS) {
    try {
      const raw = await readFile(join(dir, `${lang}.md`), 'utf-8')
      const { data, content } = matter(raw)
      files[lang] = { content, data: normalizeData(data) }
    } catch {
      /* 该语言版本不存在 */
    }
  }
  if (Object.keys(files).length === 0) return null
  return { path: rel, files }
}

// 保存文章；文件夹位置以路径为准，slugId 通常只是元数据（如评论 postSlug，形如 momo/xxx）
export async function saveArticle(path, lang, payload) {
  const rel = safeRel(path)
  if (!rel) return { error: '无效路径' }
  if (!LANGS.includes(lang)) return { error: `不支持的语言: ${lang}` }

  const data = normalizeData(payload.data || {})
  const newRel = safeRel(data.slugId || rel)
  if (!newRel) return { error: '无效的 slugId' }
  data.slugId = newRel

  // 读取当前文件已有的 slugId，用于判断是否真的发生了 slugId 修改
  const raw = await readFile(join(blogPath(rel), `${lang}.md`), 'utf-8').catch(() => null)
  const oldSlug = raw ? String(matter(raw).data?.slugId ?? '') : ''

  const writeOne = async (p, l, d, body) => {
    const file = join(blogPath(p), `${l}.md`)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, matter.stringify(body || '', d), 'utf-8')
  }

  // 仅当 slugId 与当前文件夹路径一致（CMS 创建的文章，slugId == 路径）且确实被修改时，
  // 才整体移动文件夹；否则 slugId 只是元数据，绝不改变文件夹位置
  if (newRel !== rel && oldSlug === rel) {
    // 目标目录已存在且不是当前目录 -> 拒绝，避免覆盖
    const exists = await stat(blogPath(newRel)).then((s) => s.isDirectory()).catch(() => false)
    if (exists) return { error: `目标路径已存在: ${newRel}` }

    // 移动所有语言版本，并更新其 slugId
    const oldDir = blogPath(rel)
    for (const l of LANGS) {
      try {
        const r = await readFile(join(oldDir, `${l}.md`), 'utf-8')
        const { data: d } = matter(r)
        d.slugId = newRel
        await writeOne(newRel, l, d, matter(r).content)
      } catch {
        /* 该语言版本不存在 */
      }
    }
    await rm(oldDir, { recursive: true, force: true })
    // 最后写入本次保存的内容（覆盖上面同语言的文件）
    await writeOne(newRel, lang, data, payload.body)
    return { path: newRel, moved: true }
  }

  await writeOne(rel, lang, data, payload.body)
  return { path: rel }
}

// 新建文章（创建文件夹 + 模板文件）
export async function createArticle(path, lang) {
  const rel = safeRel(path)
  if (!rel) return { error: '无效路径' }
  if (!LANGS.includes(lang)) return { error: `不支持的语言: ${lang}` }

  const dir = blogPath(rel)
  const exists = await stat(join(dir, `${lang}.md`)).then(() => true).catch(() => false)
  if (exists) return { error: '文章已存在' }

  const data = normalizeData({
    title: rel.split('/').pop(),
    pubDate: new Date().toISOString().slice(0, 10),
    description: '',
    image: '',
    draft: true,
    slugId: rel,
    category: '',
    pinTop: 0,
  })
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${lang}.md`), matter.stringify('', data), 'utf-8')
  return { path: rel }
}

// 删除整篇文章（整个文件夹）
export async function deleteArticle(path) {
  const rel = safeRel(path)
  if (!rel) return { error: '无效路径' }
  const dir = blogPath(rel)
  const st = await stat(dir).then((s) => s).catch(() => null)
  if (!st?.isDirectory()) return { error: '文章不存在' }
  await rm(dir, { recursive: true, force: true })
  return { ok: true }
}

// 统计分类
export async function categoryStats() {
  const list = await scanArticles()
  const counts = new Map()
  let drafts = 0
  for (const a of list) {
    if (a.draft) drafts++
    if (a.category) counts.set(a.category, (counts.get(a.category) || 0) + 1)
  }
  const categories = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
  return { total: list.length, drafts, categories }
}

// 概览统计：在前端展示文章信息（含正文字数，需读取全部文件内容）
export async function overviewStats() {
  const base = await categoryStats()
  const list = await scanArticles()

  let pinned = 0
  const langCount = { 'zh-cn': 0, en: 0 }
  let both = 0
  for (const a of list) {
    if (a.pinTop) pinned++
    if (a.langs.includes('zh-cn')) langCount['zh-cn']++
    if (a.langs.includes('en')) langCount.en++
    if (a.langs.includes('zh-cn') && a.langs.includes('en')) both++
  }

  // 正文字数：忽略 frontmatter 与代码块/行内代码，中文字符 + 英文单词粗略统计
  let cjk = 0
  let latin = 0
  for await (const file of walk(BLOG_DIR)) {
    if (extname(file) !== '.md') continue
    if (basename(file).startsWith('_')) continue
    const lang = basename(file).replace(/\.md$/, '')
    if (!LANGS.includes(lang)) continue
    const { content } = matter(await readFile(file, 'utf-8'))
    const body = content.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '')
    cjk += (body.match(/[\u4e00-\u9fff]/g) || []).length
    latin += (body.match(/[A-Za-z0-9]+/g) || []).length
  }

  const recent = [...list]
    .sort(
      (a, b) =>
        (b.pinTop - a.pinTop) ||
        (b.pubDate || '').localeCompare(a.pubDate || ''),
    )
    .slice(0, 8)

  return {
    total: base.total,
    published: base.total - base.drafts,
    drafts: base.drafts,
    pinned,
    categories: base.categories,
    langs: langCount,
    both,
    words: { cjk, latin, total: cjk + latin },
    recent,
  }
}
