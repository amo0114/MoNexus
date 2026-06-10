const expectedNodeMajor = 20
const expectedNpmMajor = 10

const nodeMajor = Number(process.versions.node.split('.')[0])
const npmUserAgent = process.env.npm_config_user_agent ?? ''
const npmMajorMatch = npmUserAgent.match(/npm\/(\d+)\./)
const npmMajor = npmMajorMatch ? Number(npmMajorMatch[1]) : null

let hasError = false

if (nodeMajor !== expectedNodeMajor) {
  console.error(
    `[runtime] Node.js ${expectedNodeMajor}.x is required, current version is ${process.versions.node}.`
  )
  hasError = true
}

if (npmMajor !== null && npmMajor !== expectedNpmMajor) {
  console.error(
    `[runtime] npm ${expectedNpmMajor}.x is required, current npm user agent is ${npmUserAgent}.`
  )
  hasError = true
}

if (hasError) {
  console.error('[runtime] Run `nvm use` from the repository root, then reinstall dependencies with npm 10.')
  process.exit(1)
}
