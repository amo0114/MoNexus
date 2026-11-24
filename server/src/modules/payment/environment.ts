import { config } from '../../config/index.js'

export function providerEnvironment(): 'sandbox' | 'live' {
  return config.recharge.mode === 'live' ? 'live' : 'sandbox'
}
