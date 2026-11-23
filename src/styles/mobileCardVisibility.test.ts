import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const stylesDir = join(process.cwd(), 'src', 'styles')
const stripCssComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

describe('mobile store card visibility CSS guards', () => {
  it('uses overflow-x: clip instead of overflow-x: hidden on body', () => {
    const baseCss = stripCssComments(readFileSync(join(stylesDir, '20-base.css'), 'utf8'))
    const bodyMatch = baseCss.match(/body\s*\{[^}]*\}/)
    expect(bodyMatch).not.toBeNull()
    expect(bodyMatch?.[0]).toContain('overflow-x: clip;')
    expect(bodyMatch?.[0]).not.toContain('overflow-x: hidden;')
  })

  it('does not gate .reveal visibility behind animation-timeline: view()', () => {
    const revealCss = stripCssComments(readFileSync(join(stylesDir, '50-island-reveal.css'), 'utf8'))
    expect(revealCss).not.toMatch(/animation-timeline\s*:\s*view\(\)/)
    expect(revealCss).toMatch(/\.reveal\s*\{[^}]*opacity:\s*1/)
  })

  it('disables backdrop-filter on .store-card-chip under mobile viewports', () => {
    const baseCss = stripCssComments(readFileSync(join(stylesDir, '20-base.css'), 'utf8'))
    const mobileBlock = baseCss.slice(baseCss.indexOf('@media (max-width: 767px)'))
    expect(mobileBlock).toMatch(/\.store-card-chip\s*\{[^}]*backdrop-filter:\s*none/)
    expect(mobileBlock).toMatch(/\.store-card-chip\s*\{[^}]*-webkit-backdrop-filter:\s*none/)
  })
})
