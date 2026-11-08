// Composition root: the only place that knows concrete fulfillment providers.
// Add a provider here (plus its config/migrations); core calls it via the registry.
import { config } from '../config/index.js'
import { registerFulfillmentProvider } from '../modules/fulfillment/registry.js'
import { createJobFulfillmentProvider } from '../modules/fulfillment/jobProvider.js'
import { xboardFulfillmentProvider } from '../modules/fakaBridge/provider.js'
import { demoLicenseAdapter } from '../plugins/demoLicense/adapter.js'

registerFulfillmentProvider(xboardFulfillmentProvider)
// Developer example on the core job engine; never sellable in production.
if (config.nodeEnv !== 'production') registerFulfillmentProvider(createJobFulfillmentProvider(demoLicenseAdapter))
