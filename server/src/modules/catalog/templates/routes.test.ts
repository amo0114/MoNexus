import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { productTemplateRoutes } from './routes.js'
import { TEMPLATE_KEYS } from './types.js'

const app = express()
app.use('/api/product-templates', productTemplateRoutes)

describe('GET /api/product-templates', () => {
  it('returns the frozen registry without examples and allows public caching', async () => {
    const res = await request(app).get('/api/product-templates')
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toMatch(/public/)
    expect(res.body.registryVersion).toBe(1)
    expect(res.body.templates).toHaveLength(7)
    expect(res.body.templates.map((template: { key: string }) => template.key)).toEqual([...TEMPLATE_KEYS])
    for (const template of res.body.templates) {
      expect(template).toEqual(expect.objectContaining({
        key: expect.any(String),
        version: 1,
        label: expect.any(String),
        productSchema: expect.any(Object),
        offerSchema: expect.any(Object),
        ui: expect.objectContaining({
          productOrder: expect.any(Array),
          offerOrder: expect.any(Array),
          widgets: expect.any(Object),
        }),
        fulfillmentRules: expect.any(Array),
      }))
      expect(template).not.toHaveProperty('examples')
    }
    expect(JSON.stringify(res.body)).not.toContain('"examples"')
  })
})
