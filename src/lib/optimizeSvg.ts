import SVGO from 'svgo'
import fs from 'fs'

let svgOptimizer: SVGO

const fsp = fs.promises

export default async function optimizeSvg(
  filePath: string,
  svgOpts?: SvgOptions
) {
  const content = await fsp.readFile(filePath, 'utf8')

  svgOptimizer ??= new SVGO({
    plugins: Object.entries({
      removeViewBox: false,
      removeDimensions: true,
      ...svgOpts,
    }).map(([name, value]): any => ({ [name]: value })),
  })

  const svg = await svgOptimizer.optimize(content, { path: filePath })
  return svg.data
}
