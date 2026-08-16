// preview.mjs — 实时预览管线
// 完整复用博客 src/plugins 下的自定义语法插件，输出与博客一致的 HTML
import { Hono } from 'hono'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkDirective from 'remark-directive'
import remarkFrontmatter from 'remark-frontmatter'
import remarkRehype from 'remark-rehype'
import rehypeKatex from 'rehype-katex'
import rehypeStringify from 'rehype-stringify'
import rehypeComponents from 'rehype-components'
import { visit } from 'unist-util-visit'
import { codeToHtml } from 'shiki'
import { readFile } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import matter from 'gray-matter'

import { remarkTypst } from '../../src/plugins/remark-typst.mjs'
import { parseDirectiveNode } from '../../src/plugins/remark-directive-rehype.js'
import { remarkCombined } from '../../src/plugins/remark-combined.mjs'
import { customFigurePlugin } from '../../src/plugins/rehype-figure-plugin.mjs'
import { admonition } from '../../src/plugins/rehype-component-admonition.mjs'
import { GithubCardComponent } from '../../src/plugins/rehype-component-github-card.mjs'
import { MusicCardComponent } from '../../src/plugins/rehype-component-music-card.mjs'
import { QuoteComponent } from '../../src/plugins/rehype-component-quote.mjs'
import { normalizeData } from './store.mjs'

// ---------- 代码高亮（shiki，主题与博客一致：one-dark-pro） ----------
function rehypeShiki() {
  return async (tree) => {
    const blocks = []
    visit(tree, 'element', (node) => {
      if (node.tagName !== 'pre' || !node.children || node.children.length !== 1) return
      const code = node.children[0]
      if (code.tagName !== 'code') return
      blocks.push({ pre: node, code })
    })
    for (const { pre, code } of blocks) {
      const cls = Array.isArray(code.properties?.className) ? code.properties.className : []
      const lang = String(cls[0] || '').replace(/^language-/, '') || 'text'
      const text = (code.children || []).map((n) => (n.type === 'text' ? n.value : '')).join('')
      try {
        const html = await codeToHtml(text, { lang, theme: 'one-dark-pro' })
        // 用 raw 节点替换整个 pre 元素
        pre.type = 'raw'
        pre.value = html
        delete pre.tagName
        delete pre.properties
        delete pre.children
      } catch {
        /* 高亮失败则保留原始代码块 */
      }
    }
  }
}

// ---------- 图片相对路径重写：./x.png -> /blog-content/<base>/x.png ----------
// 注意：必须是 unified 插件工厂（返回 transformer），不能直接返回 transformer
function rewriteImageSrcs(base) {
  return () => (tree) => {
    if (!base) return
    visit(tree, 'element', (node) => {
      if (node.tagName === 'img' && node.properties?.src) {
        node.properties.src = resolveImg(String(node.properties.src), base)
      }
    })
  }
}

function resolveImg(src, base) {
  if (/^(https?:|data:|#|\/)/.test(src)) return src
  const resolved = posix.normalize(posix.join(base, src))
  return '/blog-content/' + resolved
}

// ---------- KaTeX CSS（内联 + 字体路径改写） ----------
const require = createRequire(import.meta.url)
const katexDir = dirname(require.resolve('katex/package.json'))
const katexCss = await readFile(join(katexDir, 'dist', 'katex.min.css'), 'utf-8')
  .then((css) => css.replace(/url\(fonts\//g, 'url(/katex-fonts/'))

// KaTeX 字体静态服务（加 CORS 头：预览 iframe 的 srcdoc origin 为 null，跨源加载字体需要放行）
const katexFonts = new Hono()
katexFonts.get('/*', async (c) => {
  const name = decodeURIComponent(c.req.path.slice('/katex-fonts/'.length))
  if (!name || name.includes('..')) return c.notFound()
  const file = join(katexDir, 'dist', 'fonts', name)
  const buf = await readFile(file).catch(() => null)
  if (!buf) return c.notFound()
  const ext = name.split('.').pop() || ''
  const mime =
    ext === 'woff2' ? 'font/woff2' :
    ext === 'woff' ? 'font/woff' :
    ext === 'ttf' ? 'font/ttf' : 'application/octet-stream'
  return c.body(buf, 200, {
    'Content-Type': mime,
    'Cache-Control': 'public, max-age=86400',
    'Access-Control-Allow-Origin': '*',
  })
})

// ---------- 正文样式（与博客 markdown.css 一致的精简版） ----------
const proseCss = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'prose.css'), 'utf-8')

// ---------- 主管线：remark 阶段（与 astro.config.mjs 顺序一致） ----------
// unified 的 processor 一旦 process 就会被冻结，因此每个请求都新建
function createProcessor(base) {
  return unified()
    .use(remarkParse)
    // 解析并丢弃 frontmatter（yaml 节点在 remark-rehype 转换时被忽略，不会显示）
    .use(remarkFrontmatter)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkDirective)
    .use(remarkTypst)
    .use(parseDirectiveNode)
    .use(remarkCombined)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeKatex)
    .use(customFigurePlugin)
    .use(rehypeComponents, {
      components: {
        github: GithubCardComponent,
        music: MusicCardComponent,
        quote: QuoteComponent,
        note: admonition('note'),
        tip: admonition('tip'),
        important: admonition('important'),
        caution: admonition('caution'),
        warning: admonition('warning'),
      },
    })
    .use(rewriteImageSrcs(base))
    .use(rehypeShiki)
    .use(rehypeStringify, { allowDangerousHtml: true })
}

const preview = new Hono()

// POST /api/preview  { data, body, base? }
preview.post('/', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object') return c.json({ error: '无效请求体' }, 400)

  const data = normalizeData(body.data || {})
  const markdown = matter.stringify(body.body || '', data)
  const base = typeof body.base === 'string' ? body.base.replace(/^\/+/, '').replace(/\/+$/, '') : ''

  let html
  try {
    const file = await createProcessor(base).process(markdown)
    html = String(file)
  } catch (e) {
    console.error('[preview] render failed:', e?.stack || e)
    return c.json({ error: e?.message || String(e) }, 400)
  }

  const doc =
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    `<style>${katexCss}\n${proseCss}</style></head>` +
    `<body><article class="markdown-content">${html}</article>` +
    PREVIEW_SYNC_SCRIPT +
    '</body></html>'

  // 用 text/plain 返回，避免 dev server 向预览文档注入 HMR 脚本（srcdoc 仍按 HTML 渲染）
  return c.text(doc)
})

// 预览内脚本：与父窗口（编辑器）按滚动比例双向同步
const PREVIEW_SYNC_SCRIPT = `<script>
(function () {
  var root = document.documentElement
  var lastRatio = -1
  function send() {
    var max = root.scrollHeight - root.clientHeight
    var ratio = max > 0 ? root.scrollTop / max : 0
    if (Math.abs(ratio - lastRatio) < 0.0001) return
    lastRatio = ratio
    parent.postMessage({ type: 'cms-preview-scroll', ratio: ratio }, '*')
  }
  window.addEventListener('scroll', send, { passive: true })
  window.addEventListener('resize', send)
  window.addEventListener('message', function (e) {
    var d = e.data
    if (d && d.type === 'cms-scroll-to' && typeof d.ratio === 'number') {
      var max = root.scrollHeight - root.clientHeight
      window.scrollTo(0, Math.round(d.ratio * max))
    }
  })
})()
</script>`

export { preview, katexFonts }
