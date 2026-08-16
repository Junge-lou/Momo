// 与博客 src/content.config.ts 的 schema 对应
export interface FrontmatterData {
  title: string
  pubDate: string
  description: string
  image: string
  draft: boolean
  slugId: string
  category: string
  pinTop: number
  [key: string]: unknown
}

export interface ArticleSummary {
  path: string
  langs: string[]
  title: string
  description: string
  category: string
  pubDate: string
  draft: boolean
  pinTop: number
}

export interface ArticleDetail {
  path: string
  files: Record<string, { content: string; data: FrontmatterData }>
}

export interface MetaInfo {
  total: number
  drafts: number
  categories: { name: string; count: number }[]
}

export interface Stats {
  total: number
  published: number
  drafts: number
  pinned: number
  categories: { name: string; count: number }[]
  langs: Record<string, number>
  both: number
  words: { cjk: number; latin: number; total: number }
  recent: ArticleSummary[]
}
