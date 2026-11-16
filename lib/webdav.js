/**
 * A deliberately small WebDAV client: MKCOL, PUT and GET over Basic auth.
 *
 * Only what a one-way upload needs is implemented, so there is no PROPFIND,
 * LOCK or partial-read surface to get wrong.
 *
 * @module @local/dsh-nas-sync/lib/webdav
 */

/** Raised when the remote answers with an unusable status. */
export class WebdavError extends Error {
  /**
   * @param message - operator-facing explanation.
   * @param status - HTTP status that produced it, when there was one.
   */
  constructor(message, status) {
    super(message)
    this.name = 'WebdavError'
    this.status = status
  }
}

/** Encode one path segment without letting `encodeURIComponent` mangle slashes. */
const encodeSegment = segment => encodeURIComponent(segment).replace(/%2F/gi, '/')

/** Minimal PROPFIND body: names, collection flag, size, and modification time. */
const PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?>'
  + '<d:propfind xmlns:d="DAV:"><d:prop>'
  + '<d:resourcetype/><d:getcontentlength/><d:getlastmodified/>'
  + '</d:prop></d:propfind>'

/**
 * Split a 207 Multi-Status body into child entries.
 *
 * Deliberately tolerant: it looks for `response` blocks and reads `href`,
 * `collection`, `getcontentlength`, and `getlastmodified` whether or not the
 * server prefixes them with `d:`.
 * @param xml - response body.
 * @param requestedPath - decoded path of the directory that was asked for.
 * @returns `{ name, directory, size, lastModified }` per child, self excluded.
 */
function parseMultiStatus(xml, requestedPath) {
  const blocks = xml.split(/<(?:\w+:)?response[\s>]/i).slice(1)
  const children = []
  for (const block of blocks) {
    const hrefMatch = /<(?:\w+:)?href[^>]*>([\s\S]*?)<\/(?:\w+:)?href>/i.exec(block)
    if (hrefMatch === null) continue
    let href = hrefMatch[1].trim()
    try {
      href = decodeURIComponent(href)
    } catch {
      // Leave an undecodable href as-is; it will simply not match a child name.
    }
    const trimmed = href.length > 1 ? href.replace(/\/+$/, '') : href
    const name = trimmed.slice(trimmed.lastIndexOf('/') + 1)
    if (name === '') continue
    if (trimmed === requestedPath.replace(/\/+$/, '')) continue
    const directory = /<(?:\w+:)?collection\s*\/?>/i.test(block)
    const sizeMatch = /<(?:\w+:)?getcontentlength[^>]*>(\d+)</i.exec(block)
    const dateMatch = /<(?:\w+:)?getlastmodified[^>]*>([^<]+)</i.exec(block)
    children.push({
      name,
      directory,
      size: sizeMatch === null ? null : Number(sizeMatch[1]),
      lastModified: dateMatch === null ? null : dateMatch[1].trim(),
    })
  }
  return children
}

/** Client for one WebDAV collection. */
export class WebdavClient {
  #base
  #authorization
  #ensured = new Set()

  /**
   * @param options - endpoint and credentials.
   * @param options.url - absolute http(s) WebDAV collection URL.
   * @param options.username - Basic auth user; omit for anonymous servers.
   * @param options.password - Basic auth password.
   */
  constructor({ url, username, password }) {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      throw new WebdavError(`WebDAV URL is not a valid URL: ${url}`)
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new WebdavError('WebDAV URL must start with https:// or http://')
    }
    this.#base = parsed.href.replace(/\/+$/, '')
    const insecure = parsed.protocol === 'http:'
    this.#authorization = username === '' || username === undefined
      ? undefined
      : `Basic ${Buffer.from(`${username}:${password ?? ''}`).toString('base64')}`
    this.insecure = insecure
    this.origin = `${parsed.protocol}//${parsed.host}`
  }

  /** Build an absolute URL for a remote-relative path. */
  #url(relative) {
    const suffix = relative.split('/').filter(part => part !== '').map(encodeSegment).join('/')
    return suffix === '' ? this.#base : `${this.#base}/${suffix}`
  }

  /** Issue one request, surfacing transport failures as WebdavError. */
  async #send(method, relative, body, headers = {}) {
    const init = {
      method,
      headers: {
        ...(this.#authorization === undefined ? {} : { authorization: this.#authorization }),
        ...headers,
      },
      body,
    }
    try {
      return await fetch(this.#url(relative), init)
    } catch (error) {
      const reason = error?.cause?.code ?? error?.message ?? 'unknown transport error'
      throw new WebdavError(`Cannot reach ${this.origin} (${reason})`)
    }
  }

  /**
   * Create every missing collection along a path.
   * @param relative - remote-relative directory path.
   */
  async ensureDirectory(relative) {
    const parts = relative.split('/').filter(part => part !== '')
    for (let index = 1; index <= parts.length; index += 1) {
      const current = parts.slice(0, index).join('/')
      if (this.#ensured.has(current)) continue
      const response = await this.#send('MKCOL', current)
      if ([201, 301, 302, 405].includes(response.status)) {
        this.#ensured.add(current)
        continue
      }
      // Servers disagree on what MKCOL says for an existing collection: 405 is
      // the common answer, but some (nginx WebDAV among them) answer 400 or 403.
      // Confirm with a depth-0 PROPFIND before treating it as a failure.
      const check = await this.#send('PROPFIND', current, undefined, { depth: '0' })
      if (check.status === 207) {
        this.#ensured.add(current)
        continue
      }
      throw new WebdavError(
        `Cannot create collection ${current}: HTTP ${response.status}`
        + ` (PROPFIND answered ${check.status})`,
        response.status,
      )
    }
  }

  /**
   * Upload one file, creating its parent collections first.
   * @param relative - remote-relative file path.
   * @param content - bytes to store.
   */
  async put(relative, content) {
    const parts = relative.split('/').filter(part => part !== '')
    parts.pop()
    if (parts.length > 0) await this.ensureDirectory(parts.join('/'))
    const response = await this.#send('PUT', relative, content, {
      'content-type': 'application/octet-stream',
    })
    if (!response.ok) {
      throw new WebdavError(`Cannot upload ${relative}: HTTP ${response.status}`, response.status)
    }
  }

  /**
   * Read a text file, treating absence as `null` rather than an error.
   * @param relative - remote-relative file path.
   * @returns the body, or `null` when the remote has no such file.
   */
  async getText(relative) {
    const response = await this.#send('GET', relative)
    if (response.status === 404) return null
    if (!response.ok) {
      throw new WebdavError(`Cannot read ${relative}: HTTP ${response.status}`, response.status)
    }
    return await response.text()
  }

  /**
   * Download one file as bytes, treating absence as `null`.
   * @param relative - remote-relative file path.
   */
  async getBytes(relative) {
    const response = await this.#send('GET', relative)
    if (response.status === 404) return null
    if (!response.ok) {
      throw new WebdavError(`Cannot download ${relative}: HTTP ${response.status}`, response.status)
    }
    return Buffer.from(await response.arrayBuffer())
  }

  /**
   * List one collection without descending.
   * @param relative - remote-relative directory path; empty for the root.
   * @returns `{ name, directory, size, lastModified }` per child.
   */
  async list(relative) {
    const response = await this.#send('PROPFIND', relative, PROPFIND_BODY, {
      depth: '1',
      'content-type': 'application/xml; charset=utf-8',
    })
    if (response.status === 404) return []
    if (response.status !== 207 && !response.ok) {
      throw new WebdavError(`Cannot list ${relative || '/'}: HTTP ${response.status}`, response.status)
    }
    let requestedPath = ''
    try {
      requestedPath = decodeURIComponent(new URL(this.#url(relative)).pathname)
    } catch {
      requestedPath = ''
    }
    return parseMultiStatus(await response.text(), requestedPath)
  }

  /**
   * Walk a collection recursively, listing sibling directories in parallel.
   *
   * A depth-1 PROPFIND per directory is one HTTP round trip, so a tree with
   * hundreds of directories costs hundreds of trips: walking it sequentially is
   * what made status take seconds. This keeps a small concurrency window instead.
   * @param relative - remote-relative directory path.
   * @param budget - shared `{ files, maxFiles }` guard against runaway trees.
   * @returns `{ path, size, lastModified }` per file, path relative to `relative`.
   */
  async walk(relative, budget = { files: 0, maxFiles: 50000 }) {
    const found = []
    let cursor = 0
    let queue = [{ dir: '', prefix: '' }]
    const CONCURRENCY = 8

    while (queue.length > 0) {
      cursor = 0
      const next = []
      // One level at a time, up to CONCURRENCY listings in flight.
      const worker = async () => {
        while (cursor < queue.length) {
          const entry = queue[cursor]
          cursor += 1
          let children
          try {
            children = await this.list(entry.dir === '' ? relative : `${relative}/${entry.dir}`)
          } catch (error) {
            if (budget.strict === true) throw error
            continue
          }
          for (const child of children) {
            const childPrefix = entry.prefix === '' ? child.name : `${entry.prefix}/${child.name}`
            const childDir = entry.dir === '' ? child.name : `${entry.dir}/${child.name}`
            if (child.directory) {
              next.push({ dir: childDir, prefix: childPrefix })
              continue
            }
            budget.files += 1
            if (budget.files > budget.maxFiles) {
              budget.exhausted = true
              return
            }
            found.push({ path: childPrefix, size: child.size, lastModified: child.lastModified })
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))
      if (budget.exhausted === true) return found
      queue = next
    }
    return found
  }

  /**
   * Check reachability and credentials before a long upload.
   * @returns a short description of the answered endpoint.
   */
  async probe() {
    const response = await this.#send('PROPFIND', '', undefined, { depth: '0' })
    if (response.status === 401 || response.status === 403) {
      throw new WebdavError(`WebDAV rejected the credentials: HTTP ${response.status}`, response.status)
    }
    if (!response.ok && response.status !== 405) {
      throw new WebdavError(`WebDAV endpoint answered HTTP ${response.status}`, response.status)
    }
    return `${this.origin} reachable (HTTP ${response.status})`
  }
}
