import { normalizePath, Plugin } from 'vite'
import { crawl } from 'recrawl-sync'
import imagemin from 'imagemin'
import webp, { Options as WebpOptions } from 'imagemin-webp'
import pngquant, { Options as PngOptions } from 'imagemin-pngquant'
import {
  minify as minifyHtml,
  Options as HtmlMinifyOptions,
} from 'html-minifier-terser'
import globRegex from 'glob-regex'
import chalk from 'chalk'
import SVGO from 'svgo'
import zlib from 'zlib'
import path from 'path'
import fs from 'fs'

const fsp = fs.promises

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
const htmlExt = /\.html$/
const pngExt = /\.png$/
const svgExt = /\.svg$/

export default (opts: PluginOptions = {}): Plugin => {
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

  return {
    name: 'vite:compress',
    apply: 'build',
    enforce: 'post',
    configResolved({ root, logger, build: { outDir, ssr } }) {
      if (ssr) return
      const outRoot = normalizePath(path.resolve(root, outDir))
      const threshold = opts.threshold ?? 1501

      this.closeBundle = async function () {
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
                content = Buffer.from(await optimizeSvg(filePath))
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

      if (opts.svgo !== false)
        this.transform = async function (code, id) {
          if (svgExt.test(id)) {
            const optimized = await optimizeSvg(id)

            // When the SVG is loaded as a JS module, we need to parse the
            // file reference so we can update the source code.
            const fileRef = /__VITE_ASSET__([a-z\d]{8})__/.exec(code)?.[1]
            if (fileRef) {
              this.setAssetSource(fileRef, optimized)
              return code
            }

            // If no file reference exists, the SVG was inlined.
            return code.replace(
              /(;utf8,).+$/,
              `$1${optimized.replace(/"/g, '\\"')}"`
            )
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

      async function optimizeSvg(filePath: string) {
        const content = await fsp.readFile(filePath, 'utf8')

        svgOptimizer ??= new SVGO({
          plugins: Object.entries({
            removeViewBox: false,
            removeDimensions: true,
            ...opts.svgo,
          }).map(([name, value]): any => ({ [name]: value })),
        })

        const svg = await svgOptimizer.optimize(content, { path: filePath })
        return svg.data
      }
    },
  }
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
