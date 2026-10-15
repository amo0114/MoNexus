import { prisma } from '../lib/prisma.js'
import {
  auditRecommendationData,
  renderRecommendationAuditMarkdown,
} from '../modules/products/recommendationAudit.js'

const USAGE = 'Usage: tsx src/scripts/auditRecommendationData.ts [--format=json|md] [--samples=<1-200>] [--compare]'

function parseArgs(args: string[]) {
  const value = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
  const format = value('format') ?? 'json'
  const samples = Number(value('samples') ?? 20)
  const known = (arg: string) => arg === '--compare' || /^--(format|samples)=/.test(arg)
  if (!['json', 'md'].includes(format) || !Number.isInteger(samples) || samples < 1 || samples > 200 || !args.every(known)) {
    throw new Error(USAGE)
  }
  return { format, samples, compare: args.includes('--compare') }
}

async function main() {
  const { format, samples, compare } = parseArgs(process.argv.slice(2))
  await prisma.$connect()
  try {
    const report = await auditRecommendationData({ sampleLimit: samples, compare })
    console.log(format === 'md' ? renderRecommendationAuditMarkdown(report) : JSON.stringify(report, null, 2))
  } finally {
    await prisma.$disconnect()
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Recommendation data audit failed')
  process.exitCode = 1
})
