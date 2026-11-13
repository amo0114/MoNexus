import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Read the same single-line dotenv syntax accepted by check-prod-env.sh.
// Never include values in diagnostics, including invalid or duplicate values.
export function prepareStagingRuntime(text, storageRows, mailRows, integrationRows) {
  const values = new Map()
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)\s*=(.*)$/)
    if (!match) continue
    let quote = '', value = ''
    for (const char of match[2].trim()) {
      if (!quote && char === '#') break
      if (char === '"' || char === "'") quote = quote === char ? '' : quote || char
      value += char
    }
    value = value.trim()
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1)
    if (values.has(match[1])) throw new Error('Duplicate environment assignment: ' + match[1])
    values.set(match[1], value)
  }
  if (values.get('FRONTEND_ORIGIN') !== 'https://staging.monexus.oai-o.com') throw new Error('Dedicated staging origin required')
  if (!['1', '2'].includes(values.get('TRUST_PROXY'))) throw new Error('Existing staging TRUST_PROXY must be a known numeric hop count')
  if (values.get('DEPLOY_TOPOLOGY') && values.get('DEPLOY_TOPOLOGY') !== 'caddy') throw new Error('Existing staging topology is incompatible')
  const additions = new Map()
  if (!values.get('DEPLOY_TOPOLOGY')) additions.set('DEPLOY_TOPOLOGY', 'caddy')
  if (values.get('TRUST_PROXY') !== '2') additions.set('TRUST_PROXY', '2')
  if (!values.get('HUMAN_VERIFICATION_PROVIDER')) {
    if (!values.get('TURNSTILE_SITE_KEY') || !values.get('TURNSTILE_SECRET_KEY')) throw new Error('Existing staging Turnstile configuration required')
    additions.set('HUMAN_VERIFICATION_PROVIDER', 'turnstile')
  }
  for (const key of ['MAIL_CREDENTIALS_ENC_KEY', 'INTEGRATION_CREDENTIALS_ENC_KEY', 'STORAGE_CREDENTIALS_ENC_KEY']) {
    if (values.get(key) && !/^[a-fA-F0-9]{64}$/.test(values.get(key))) throw new Error('Invalid existing key: ' + key)
    const rows = key === 'STORAGE_CREDENTIALS_ENC_KEY' ? storageRows : key === 'MAIL_CREDENTIALS_ENC_KEY' ? mailRows : integrationRows
    if (!values.get(key) && rows !== 0) throw new Error('Cannot initialize root without evidence of empty configuration tables: ' + key)
    if (!values.get(key)) additions.set(key, randomBytes(32).toString('hex'))
  }
  // Replace empty assignments rather than creating ambiguous duplicate keys.
  const retained = text.split(/\r?\n/).filter(line => {
    const match = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)\s*=/)
    return !match || !additions.has(match[1])
  }).join('\n')
  return { text: retained + '\n' + [...additions].map(([key, value]) => `${key}=${value}`).join('\n') + '\n', keys: [...additions.keys()] }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const prepared = prepareStagingRuntime(readFileSync(process.argv[2], 'utf8'), Number(process.argv[4]), Number(process.argv[5]), Number(process.argv[6]))
    writeFileSync(process.argv[3], prepared.text, { mode: 0o600 })
    console.log('Prepared staging fields: ' + (prepared.keys.join(', ') || 'already present'))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
