// Composition root: the only place that knows concrete fulfillment providers.
// Add a provider here (plus its config/migrations); core calls it via the registry.
import { registerFulfillmentProvider } from '../modules/fulfillment/registry.js'
import { xboardFulfillmentProvider } from '../modules/fakaBridge/provider.js'

registerFulfillmentProvider(xboardFulfillmentProvider)
