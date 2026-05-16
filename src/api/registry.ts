import api from './client'
import { ConfigRegistry } from '../types/config'

let registryCache: ConfigRegistry | null = null
let registryPromise: Promise<ConfigRegistry> | null = null

export async function getConfigRegistry(): Promise<ConfigRegistry> {
  if (registryCache) {
    return registryCache
  }
  if (registryPromise) {
    return registryPromise
  }
  
  registryPromise = api.get<ConfigRegistry>('/config/registry')
    .then(res => {
      registryCache = res.data
      registryPromise = null
      return res.data
    })
    .catch(err => {
      registryPromise = null
      throw err
    })

  return registryPromise
}
