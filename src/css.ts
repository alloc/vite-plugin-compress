import createDebug from 'debug'
import CleanCSS from 'clean-css'

const debug = createDebug('vite:plugin-compress')

// Wrap CSS declarations for CleanCSS > 3.x
// See https://github.com/jakubpawlowicz/clean-css/issues/418
const wrapCss = (css: string, type?: string) =>
  type == 'inline'
    ? '*{' + css + '}'
    : type == 'media'
    ? '@media ' + css + '{a{top:0}}'
    : css

const unwrapCss = (css: string, type?: string) =>
  (type == 'inline'
    ? css.match(/^\*\{([\s\S]*)\}$/)
    : type == 'media'
    ? css.match(/^@media ([\s\S]*?)\s*{[\s\S]*}$/)
    : null)?.[1] ?? css

export type MinifyCSSOption =
  | boolean
  | CleanCSS.OptionsOutput
  | ((css: string, type?: 'inline' | 'media') => string)

export function minifyCss(minifyCss?: MinifyCSSOption) {
  if (minifyCss === false || typeof minifyCss === 'function') {
    return minifyCss
  }

  const cssOptions = minifyCss !== true ? minifyCss : undefined
  const defaultMinifier = new CleanCSS(cssOptions)

  // Play nicely with SSR hydration when minifying inline "style" attributes.
  const inlineMinifier =
    cssOptions?.level !== 0
      ? new CleanCSS({ ...cssOptions, level: 0 })
      : defaultMinifier

  return (css: string, type?: string) => {
    const minifier = type == 'inline' ? inlineMinifier : defaultMinifier
    const output = minifier.minify(wrapCss(css, type))
    if (output.errors.length > 0) {
      debug(`Failed to minify CSS:\n  ${output.errors.join(`\n  `)}`)
      return css
    }
    return unwrapCss(output.styles, type)
  }
}
