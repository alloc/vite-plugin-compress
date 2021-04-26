import compress from 'vite-plugin-compress'
import type { UserConfig } from 'vite'

const config: UserConfig = {
  plugins: [
    compress({
      verbose: true,
    }),
  ],
}

export default config
