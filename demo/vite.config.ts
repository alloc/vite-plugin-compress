import rehost from 'vite-plugin-rehost'
import compress from 'vite-plugin-compress'
import { publicHash } from 'vite-plugin-public'
import type { UserConfig } from 'vite'

const config: UserConfig = {
  plugins: [
    rehost(),
    publicHash(),
    compress({
      verbose: true,
    }),
  ],
}

export default config
