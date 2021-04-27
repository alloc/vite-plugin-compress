import type { Plugin } from 'vite'
import { Options as PngOptions } from 'imagemin-pngquant'
import { crawl } from 'recrawl-sync'
import imagemin from 'imagemin'
import pngquant from 'imagemin-pngquant'
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
  brotli?: boolean
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
}

const mtimeCache = new Map<string, number>()
const defaultExts = ['html', 'js', 'css', 'svg', 'json']
const pngExt = /\.png$/
const svgExt = /\.svg$/

export default (opts: PluginOptions = {}): Plugin => {
  const excludeRegex = opts.exclude ? globRegex(opts.exclude) : /^$/
  const extensionRegex = new RegExp(
    '\\.(png|' +
      defaultExts
        .concat(opts.extensions || [])
        .map(ext => ext.replace(/^\./, ''))
        .join('|') +
      ')$'
  )

  let pngOptimizer: any
  let svgOptimizer: SVGO

  return {
    name: 'vite:compress',
    apply: 'build',
    enforce: 'post',
    configResolved({ root, logger, build: { outDir, ssr } }) {
      if (ssr) return
      const outRoot = path.posix.resolve(root, outDir)

      this.writeBundle = async function () {
        const files = crawl(outRoot, {
          skip: ['.DS_Store'],
        })
        const compressed = new Map<string, number>()
        await Promise.all(
          files.map(
            async (name): Promise<any> => {
              if (!extensionRegex.test(name) || excludeRegex.test(name)) return
              const filePath = path.posix.join(outRoot, name)
              if (excludeRegex.test(filePath)) return

              let { mtimeMs, size: oldSize } = await fsp.stat(filePath)
              if (mtimeMs <= (mtimeCache.get(filePath) || 0)) return

              let compress: ((content: Buffer) => Promise<Buffer>) | undefined
              if (pngExt.test(name)) {
                if (opts.pngquant !== false) {
                  pngOptimizer ??= pngquant(opts.pngquant)
                  compress = content =>
                    imagemin.buffer(content, {
                      plugins: [pngOptimizer],
                    })
                }
              } else if (
                opts.brotli !== false &&
                oldSize >= (opts.threshold ?? 1501)
              ) {
                compress = brotli
              }

              let content: Buffer | undefined
              if (opts.svgo !== false && svgExt.test(name)) {
                content = Buffer.from(await optimizeSvg(filePath))
              } else if (compress) {
                content = await fsp.readFile(filePath)
              }

              if (content) {
                if (compress) {
                  content = await compress(content)
                }
                await fsp.writeFile(filePath, content)
                mtimeCache.set(filePath, Date.now())
                compressed.set(name, 1 - content.byteLength / oldSize)
              }
            }
          )
        )
        if (opts.verbose) {
          logger.info('\nFiles compressed:')
          const lengths = Array.from(compressed.keys(), name => name.length)
          const maxLength = Math.max(...lengths)
          const outDir = path.relative(root, outRoot)
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
