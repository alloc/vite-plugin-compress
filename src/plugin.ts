import { normalizePath, Plugin } from 'vite'
import { crawl } from 'recrawl-sync'
import imagemin from 'imagemin'
import webp, { Options as WebpOptions } from 'imagemin-webp'
import pngquant, { Options as PngOptions } from 'imagemin-pngquant'
import {
  minify as minifyHtml,
  Options as HtmlMinifyOptions,
} from 'html-minifier-terser'
import createDebug from 'debug'
import globRegex from 'glob-regex'
import chalk from 'chalk'
import SVGO from 'svgo'
import zlib from 'zlib'
import path from 'path'
import fs from 'fs'

const fsp = fs.promises
const debug = createDebug('vite:plugin-compress')

type PluginOptions = {
  /**
   * Log compressed files and their compression ratios.
   */
  verbose?: boolean
  /**
   * Set false to disable Brotli compression.
   * Useful when your web server handles compression.
   * @default true
   */
  brotli?: boolean | { exclude?: string[] }
  /**
   * Brotli compression quality (from `0` to `11`).
   * @default 11
   */
  quality?: number
  /**
   * Minimum file size before compression is used.
   * @default 1501
   */
  threshold?: number
  /**
   * Globs to exclude certain files from being compressed.
   */
  exclude?: string[]
  /**
   * Additional extensions for Brotli compression.
   */
  extensions?: string[]
  /**
   * Set false to disable the SVG optimizer.
   */
  svgo?: SvgOptions | false
  /**
   * Set false to disable the PNG optimizer.
   */
  pngquant?: PngOptions | false
  /**
   * Set to convert PNG images to WEBP format.
   * This also sets the `pngquant` option to false.
   */
  webp?: WebpOptions | true
  /**
   * Set to minify HTML outputs.
   */
  minifyHtml?: HtmlMinifyOptions | true
}

const mtimeCache = new Map<string, number>()
const defaultExts = ['html', 'js', 'css', 'svg', 'json']
const dataUriPrefix = 'data:image/svg+xml,'
const htmlExt = /\.html$/
const pngExt = /\.png$/
const svgExt = /\.svg$/

export default (opts: PluginOptions = {}): Plugin[] => {
  const excludeRegex = opts.exclude ? globRegex(opts.exclude) : /^$/
  const brotliExcludeRegex =
    opts.brotli && opts.brotli !== true && opts.brotli.exclude
      ? globRegex(opts.brotli.exclude)
      : opts.brotli !== false
      ? /^$/
      : /.+/

  const extensionRegex = new RegExp(
    '\\.(png|' +
      defaultExts
        .concat(opts.extensions || [])
        .map(ext => ext.replace(/^\./, ''))
        .join('|') +
      ')$'
  )

  let pngOptimizer: any
  let webpGenerator: any
  let svgOptimizer: SVGO

  async function optimizeSvg(content: string, filePath: string) {
    svgOptimizer ??= new SVGO({
      plugins: Object.entries({
        removeViewBox: false,
        removeDimensions: true,
        ...opts.svgo,
      }).map(([name, value]): any => ({ [name]: value })),
    })

    try {
      const svg = await svgOptimizer.optimize(content, { path: filePath })
      return svg.data
    } catch (err) {
      debug(`Failed to optimize "${filePath}". ` + err.message)
      return content
    }
  }

  let outRoot: string

  const prePlugin: Plugin = {
    name: 'vite:compress',
    apply: 'build',
    enforce: 'pre',
    configResolved({ root, publicDir, build: { outDir, ssr } }) {
      if (ssr) return
      outRoot = normalizePath(path.resolve(root, outDir))

      if (publicDir && opts.webp) {
        const pngFiles = crawl(publicDir, {
          only: ['*.png'],
        })
        this.resolveBuiltUrl = url => {
          if (url[0] === '/' && pngFiles.includes(url.slice(1))) {
            return url.replace(pngExt, '.webp')
          }
        }
      }

      if (opts.svgo !== false)
        // Optimize any inlined SVGs. Non-inlined SVGs are optimized
        // in the `closeBundle` phase.
        this.transform = async function (code, id) {
          if (svgExt.test(id)) {
            let exported = /^export default (".+?")$/.exec(code)?.[1]
            if (!exported) return
            const isRaw = /(\?|&)raw(?:&|$)/.test(id)
            try {
              let content = JSON.parse(exported)
              if (!isRaw) {
                if (!content.startsWith(dataUriPrefix)) return
                content = decodeURIComponent(
                  content.slice(dataUriPrefix.length)
                )
              }
              let optimized = await optimizeSvg(content, id)
              if (!isRaw) {
                optimized = dataUriPrefix + encodeURIComponent(optimized)
              }
              console.log('optimizeSvg:', { id, content, optimized })
              return code.replace(exported, JSON.stringify(optimized))
            } catch (err) {
              debug(`Failed to transform "${id}". ` + err.message)
            }
          }
        }
    },
  }

  const postPlugin: Plugin = {
    name: 'vite:compress',
    apply: 'build',
    enforce: 'post',
    configResolved({ root, logger, build: { ssr, watch } }) {
      if (ssr) return
      const threshold = opts.threshold ?? 1501

      this.buildStart = () => {
        this.closeBundle = closeBundle
      }
      this.buildEnd = error => {
        if (error) this.closeBundle = undefined
      }

      async function closeBundle() {
        const files = crawl(outRoot, {
          skip: ['.DS_Store'],
        })
        const compressed = new Map<string, number>()
        await Promise.all(
          files.map(
            async (name): Promise<any> => {
              if (!extensionRegex.test(name) || excludeRegex.test(name)) return
              let filePath = path.posix.join(outRoot, name)
              if (excludeRegex.test(filePath)) return

              let { mtimeMs, size: oldSize } = await fsp.stat(filePath)
              if (mtimeMs <= (mtimeCache.get(filePath) || 0)) return

              let newFilePath: string | undefined
              let compress:
                | ((content: Buffer) => Buffer | Promise<Buffer>)
                | undefined

              if (pngExt.test(name)) {
                if (opts.webp) {
                  webpGenerator ??= webp(
                    opts.webp === true ? undefined : opts.webp
                  )
                  newFilePath = filePath.replace(pngExt, '.webp')
                  compress = content =>
                    imagemin.buffer(content, {
                      plugins: [webpGenerator],
                    })
                } else if (opts.pngquant !== false) {
                  pngOptimizer ??= pngquant(opts.pngquant)
                  compress = content =>
                    imagemin.buffer(content, {
                      plugins: [pngOptimizer],
                    })
                }
              } else {
                const useBrotli =
                  oldSize >= threshold &&
                  !brotliExcludeRegex.test(name) &&
                  !brotliExcludeRegex.test(filePath)
                if (opts.minifyHtml && htmlExt.test(name)) {
                  compress = content => {
                    const html = minifyHtml(content.toString('utf8'), {
                      collapseBooleanAttributes: true,
                      collapseWhitespace: true,
                      keepClosingSlash: true,
                      minifyCSS: true,
                      minifyJS: true,
                      minifyURLs: true,
                      removeAttributeQuotes: true,
                      removeComments: true,
                      removeEmptyAttributes: true,
                      removeRedundantAttributes: true,
                      removeScriptTypeAttributes: true,
                      removeStyleLinkTypeAttributes: true,
                      useShortDoctype: true,
                      ...(opts.minifyHtml === true ? {} : opts.minifyHtml),
                    })
                    content = Buffer.from(html)
                    return useBrotli && content.byteLength >= threshold
                      ? brotli(content)
                      : content
                  }
                } else if (useBrotli) {
                  compress = brotli
                }
              }

              let content: Buffer | undefined
              if (opts.svgo !== false && svgExt.test(name)) {
                content = await fsp.readFile(filePath)
                content = Buffer.from(
                  await optimizeSvg(content.toString('utf8'), filePath)
                )
              } else if (compress) {
                content = await fsp.readFile(filePath)
                content = await compress(content)
              }

              if (content) {
                mtimeCache.set(filePath, Date.now())
                if (newFilePath) {
                  await fsp.unlink(filePath)
                  name = path.relative(outRoot, (filePath = newFilePath))
                }
                await fsp.writeFile(filePath, content)
                compressed.set(name, 1 - content.byteLength / oldSize)
              }
            }
          )
        )
        if (opts.verbose) {
          logger.info('\nFiles compressed:')
          const lengths = Array.from(compressed.keys(), name => name.length)
          const maxLength = Math.max(...lengths)
          const outDir = path.posix.relative(root, outRoot)
          compressed.forEach((ratio, name) => {
            logger.info(
              '  ' +
                chalk.gray(outDir + '/') +
                chalk.green(name) +
                ' '.repeat(2 + maxLength - name.length) +
                chalk.blueBright(`${Math.floor(100 * ratio)}% smaller`)
            )
          })
          logger.info('')
        }
      }

      function brotli(content: Buffer) {
        const params = {
          [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
          [zlib.constants.BROTLI_PARAM_QUALITY]:
            opts.quality ?? zlib.constants.BROTLI_MAX_QUALITY,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: content.byteLength,
        }
        return new Promise<Buffer>((resolve, reject) => {
          zlib.brotliCompress(content, { params }, (err, result) =>
            err ? reject(err) : resolve(result)
          )
        })
      }
    },
  }

  return [prePlugin, postPlugin]
}

export { PngOptions }

export type SvgOptions = Partial<
  Remap<UnionToIntersection<import('svgo').PluginConfig>>
>

type Remap<T> = {} & { [P in keyof T]: T[P] }

type UnionToIntersection<T> = (T extends any ? (x: T) => any : never) extends (
  x: infer R
) => any
  ? R
  : never
