import { api } from '../api'
import type { ArticleSummary } from '../types'
import { navigate } from '../router'
import { el, encodePath } from '../dom'
import { toast } from '../ui'
import { pageHeader } from './header'
import { openNewModal } from './new-article'

type ViewMode = 'card' | 'table'

const VIEW_KEY = 'cms-list-view'

interface ListState {
  q: string
  category: string
  draft: string
  categories: string[]
  view: ViewMode
  sort: string
  articles: ArticleSummary[]
}

function loadView(): ViewMode {
  try {
    return localStorage.getItem(VIEW_KEY) === 'table' ? 'table' : 'card'
  } catch {
    return 'card'
  }
}

export async function renderList(root: HTMLElement) {
  const state: ListState = {
    q: '',
    category: '',
    draft: 'all',
    categories: [],
    view: loadView(),
    sort: 'default',
    articles: [],
  }

  root.append(
    pageHeader(
      'list',
      el('button', { class: 'btn btn-primary', id: 'btn-new', onclick: () => openNewModal(root, state.categories) }, [
        '＋ 新建文章',
      ]),
    ),
    el('main', { class: 'cms-main' }, [
      el('div', { class: 'cms-toolbar' }, [
        el('input', {
          class: 'input input-search',
          type: 'search',
          placeholder: '搜索标题 / 描述 / 路径 / 分类…',
          oninput: (e: Event) => {
            state.q = (e.target as HTMLInputElement).value
            debouncedReload()
          },
        }),
        el('select', {
          class: 'input',
          id: 'filter-category',
          onchange: (e: Event) => {
            state.category = (e.target as HTMLSelectElement).value
            reload()
          },
        }),
        el('select', {
          class: 'input',
          id: 'filter-draft',
          onchange: (e: Event) => {
            state.draft = (e.target as HTMLSelectElement).value
            reload()
          },
        }, [
          el('option', { value: 'all' }, ['全部状态']),
          el('option', { value: 'published' }, ['已发布']),
          el('option', { value: 'drafts' }, ['草稿']),
        ]),
        el('select', {
          class: 'input',
          id: 'sort-by',
          title: '排序方式',
          onchange: (e: Event) => {
            state.sort = (e.target as HTMLSelectElement).value
            renderListItems(state.articles)
          },
        }, [
          el('option', { value: 'default' }, ['默认（置顶+日期）']),
          el('option', { value: 'date-desc' }, ['发布日期 新→旧']),
          el('option', { value: 'date-asc' }, ['发布日期 旧→新']),
          el('option', { value: 'title-asc' }, ['标题 A→Z']),
          el('option', { value: 'title-desc' }, ['标题 Z→A']),
          el('option', { value: 'path-asc' }, ['路径 A→Z']),
          el('option', { value: 'path-desc' }, ['路径 Z→A']),
          el('option', { value: 'category-asc' }, ['分类 A→Z']),
        ]),
        el('div', { class: 'view-toggle', role: 'group', title: '切换视图模式' }, [
          el('button', {
            class: 'view-btn' + (state.view === 'card' ? ' active' : ''),
            id: 'view-card',
            onclick: () => setView('card'),
          }, ['卡片']),
          el('button', {
            class: 'view-btn' + (state.view === 'table' ? ' active' : ''),
            id: 'view-table',
            onclick: () => setView('table'),
          }, ['表格']),
        ]),
        el('span', { class: 'cms-count', id: 'count' }),
      ]),
      el('div', { class: 'article-list' + (state.view === 'table' ? ' is-table' : ''), id: 'article-list' }),
      el('div', { class: 'cms-empty', id: 'empty', hidden: true }, [
        '暂无文章，点击右上角「新建文章」开始创作',
      ]),
    ]),
  )

  let timer = 0
  function debouncedReload() {
    clearTimeout(timer)
    timer = window.setTimeout(reload, 250)
  }

  function setView(view: ViewMode) {
    state.view = view
    try {
      localStorage.setItem(VIEW_KEY, view)
    } catch {
      /* localStorage 不可用时忽略 */
    }
    const cardBtn = root.querySelector('#view-card') as HTMLButtonElement | null
    const tableBtn = root.querySelector('#view-table') as HTMLButtonElement | null
    if (cardBtn) cardBtn.classList.toggle('active', view === 'card')
    if (tableBtn) tableBtn.classList.toggle('active', view === 'table')
    const listEl = root.querySelector('#article-list') as HTMLElement
    listEl.classList.toggle('is-table', view === 'table')
    renderListItems(state.articles)
  }

  async function reload() {
    try {
      const { articles } = await api.list({
        q: state.q,
        category: state.category,
        draft: state.draft,
      })
      state.articles = articles
      renderListItems(articles)
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  function renderListItems(articles: ArticleSummary[]) {
    const sorted = sortArticles(articles, state.sort)
    const listEl = root.querySelector('#article-list') as HTMLElement
    const emptyEl = root.querySelector('#empty') as HTMLElement
    const countEl = root.querySelector('#count') as HTMLElement
    listEl.innerHTML = ''
    emptyEl.hidden = sorted.length > 0
    countEl.textContent = `共 ${sorted.length} 篇`
    if (state.view === 'table') listEl.append(articleTable(sorted, () => reload()))
    else for (const a of sorted) listEl.append(articleCard(a))
  }

  async function loadMeta() {
    try {
      const meta = await api.meta()
      state.categories = meta.categories.map((c) => c.name)
      const sel = root.querySelector('#filter-category') as HTMLSelectElement
      sel.innerHTML = ''
      sel.append(el('option', { value: '' }, ['全部分类']))
      for (const c of meta.categories) {
        sel.append(el('option', { value: c.name }, [`${c.name} (${c.count})`]))
      }
    } catch {
      /* meta 加载失败不影响列表 */
    }
  }

  await Promise.all([loadMeta(), reload()])
}

// ---------------- 排序 ----------------

// 中文排序（拼音 + 数字感知）；sensitivity: base 忽略大小写与变音
const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })

function sortArticles(articles: ArticleSummary[], sort: string): ArticleSummary[] {
  const list = [...articles]
  const titleKey = (a: ArticleSummary) => a.title || a.path || ''

  // 日期排序：无日期的文章恒排末尾，再按方向比较，最后用路径兜底保证稳定
  const byDate = (a: ArticleSummary, b: ArticleSummary, dir: 1 | -1) => {
    const da = a.pubDate || ''
    const db = b.pubDate || ''
    if (!da && !db) return collator.compare(a.path, b.path)
    if (!da) return 1
    if (!db) return -1
    return dir * da.localeCompare(db) || collator.compare(a.path, b.path)
  }

  switch (sort) {
    case 'date-asc':
      return list.sort((a, b) => byDate(a, b, 1))
    case 'date-desc':
      return list.sort((a, b) => byDate(a, b, -1))
    case 'title-asc':
      return list.sort((a, b) => collator.compare(titleKey(a), titleKey(b)) || collator.compare(a.path, b.path))
    case 'title-desc':
      return list.sort((a, b) => collator.compare(titleKey(b), titleKey(a)) || collator.compare(a.path, b.path))
    case 'path-asc':
      return list.sort((a, b) => collator.compare(a.path, b.path))
    case 'path-desc':
      return list.sort((a, b) => collator.compare(b.path, a.path))
    case 'category-asc':
      return list.sort(
        (a, b) =>
          collator.compare(a.category || '', b.category || '') || collator.compare(titleKey(a), titleKey(b)),
      )
    default:
      // 默认：置顶优先，其次发布日期倒序，最后路径兜底
      return list.sort(
        (a, b) =>
          (b.pinTop - a.pinTop) ||
          (b.pubDate || '').localeCompare(a.pubDate || '') ||
          collator.compare(a.path, b.path),
      )
  }
}

// ---------------- 卡片视图 ----------------

function articleCard(a: ArticleSummary) {
  const badges: (HTMLElement | string)[] = []
  if (a.draft) badges.push(el('span', { class: 'badge badge-draft' }, ['草稿']))
  if (a.pinTop) badges.push(el('span', { class: 'badge badge-pin' }, ['置顶']))
  for (const lang of a.langs) badges.push(el('span', { class: 'badge badge-lang' }, [lang]))

  return el('a', { class: 'article-card', href: `#/edit/${encodePath(a.path)}` }, [
    el('div', { class: 'article-card-head' }, [
      el('span', { class: 'article-card-title' }, [a.title || a.path]),
      el('div', { class: 'article-card-badges' }, badges),
    ]),
    el('div', { class: 'article-card-meta' }, [
      a.category ? el('span', { class: 'tag' }, [a.category]) : null,
      el('span', {}, [a.pubDate || '—']),
      el('span', { class: 'article-card-path' }, [a.path]),
    ]),
    a.description ? el('p', { class: 'article-card-desc' }, [a.description]) : null,
  ])
}

// ---------------- 表格视图 ----------------

function articleTable(articles: ArticleSummary[], onChanged: () => void) {
  const tbody = el('tbody')
  for (const a of articles) tbody.append(articleRow(a, onChanged))
  return el('div', { class: 'table-wrap' }, [
    el('table', { class: 'article-table' }, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', {}, ['标题']),
          el('th', {}, ['分类']),
          el('th', {}, ['状态']),
          el('th', {}, ['语言']),
          el('th', {}, ['日期']),
          el('th', {}, ['路径']),
          el('th', { class: 'actions' }, ['操作']),
        ]),
      ]),
      tbody,
    ]),
  ])
}

function articleRow(a: ArticleSummary, onChanged: () => void) {
  const badges: (HTMLElement | string)[] = []
  if (a.draft) badges.push(el('span', { class: 'badge badge-draft' }, ['草稿']))
  if (a.pinTop) badges.push(el('span', { class: 'badge badge-pin' }, ['置顶']))
  const langs = a.langs.map((l) => el('span', { class: 'badge badge-lang' }, [l]))

  return el('tr', {
    class: 'article-table-row',
    role: 'link',
    tabindex: '0',
    title: `编辑 ${a.path}`,
    onclick: () => navigate(`#/edit/${encodePath(a.path)}`),
    onkeydown: (e: KeyboardEvent) => {
      // 焦点在操作按钮上时 Enter 触发按钮而非跳转
      if (e.key === 'Enter' && !(e.target as HTMLElement).closest('button')) {
        navigate(`#/edit/${encodePath(a.path)}`)
      }
    },
  }, [
    el('td', {}, [
      el('div', { class: 'article-table-title' }, [a.title || a.path]),
      a.description ? el('div', { class: 'article-table-desc' }, [a.description]) : null,
    ]),
    el('td', {}, [a.category ? el('span', { class: 'tag' }, [a.category]) : null]),
    el('td', {}, badges),
    el('td', {}, langs),
    el('td', {}, [a.pubDate || '—']),
    el('td', { class: 'path' }, [a.path]),
    actionsCell(a, onChanged),
  ])
}

// ---------------- 表格行内操作 ----------------

function actionsCell(a: ArticleSummary, onChanged: () => void) {
  const pinBtn = rowActionBtn(
    '<path d="M12 17v5"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/>',
    a.pinTop ? '取消置顶' : '置顶',
    a.pinTop ? 'active' : '',
    () => togglePin(a, onChanged),
  )
  const draftBtn = rowActionBtn(
    '<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
    a.draft ? '标记为已发布' : '标记为草稿',
    a.draft ? 'active' : '',
    () => toggleDraft(a, onChanged),
  )
  const delBtn = rowActionBtn(
    '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
    '删除文章',
    'row-act-danger',
    () => doRowDelete(a, onChanged),
  )
  return el('td', { class: 'actions' }, [pinBtn, draftBtn, delBtn])
}

// 行内操作按钮：阻止冒泡，避免触发整行的跳转
function rowActionBtn(iconPath: string, title: string, cls: string, onClick: () => void) {
  const span = document.createElement('span')
  span.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPath}</svg>`
  return el('button', {
    class: `row-act ${cls}`.trim(),
    title,
    type: 'button',
    onclick: (e: Event) => {
      e.stopPropagation()
      onClick()
    },
  }, [span])
}

// 切换置顶 / 草稿：写入该文章全部语言版本的 frontmatter
async function setFlag(
  a: ArticleSummary,
  key: 'pinTop' | 'draft',
  value: number | boolean,
  onChanged: () => void,
  onMsg: string,
  offMsg: string,
) {
  try {
    const detail = await api.get(a.path)
    for (const lang of Object.keys(detail.files)) {
      const f = detail.files[lang]
      ;(f.data as Record<string, unknown>)[key] = value
      await api.save(a.path, lang, { data: f.data, body: f.content })
    }
    toast(value ? onMsg : offMsg)
    onChanged()
  } catch (e) {
    toast((e as Error).message, 'error')
  }
}

function togglePin(a: ArticleSummary, onChanged: () => void) {
  return setFlag(a, 'pinTop', a.pinTop ? 0 : 1, onChanged, '已置顶', '已取消置顶')
}

function toggleDraft(a: ArticleSummary, onChanged: () => void) {
  return setFlag(a, 'draft', !a.draft, onChanged, '已标记为草稿', '已发布')
}

async function doRowDelete(a: ArticleSummary, onChanged: () => void) {
  if (!window.confirm(`确定删除文章「${a.title || a.path}」？\n将删除整个文件夹及其所有语言版本，不可恢复。`)) {
    return
  }
  try {
    await api.remove(a.path)
    toast('已删除')
    onChanged()
  } catch (e) {
    toast((e as Error).message, 'error')
  }
}
