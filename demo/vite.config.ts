import compress from 'vite-plugin-compress'
import viteSSR from 'vite-ssr/plugin'
import type { UserConfig } from 'vite'

const config: UserConfig = {
  plugins: [
    viteSSR(),
    compress({
      verbose: true,
    }),
  ],
}

export default config
