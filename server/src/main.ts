import { app } from './app.js'
import { config } from './config/index.js'

app.listen(config.port, () => {
  console.log(`🚀 MoNexus API running at http://localhost:${config.port}`)
})
