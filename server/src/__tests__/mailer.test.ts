import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const nodemailerMock = vi.hoisted(() => ({
  createTransport: vi.fn(),
  sendMail: vi.fn(),
  close: vi.fn(),
}))

vi.mock('nodemailer', () => ({
  default: {
    createTransport: nodemailerMock.createTransport,
  },
  createTransport: nodemailerMock.createTransport,
}))

describe('mailer adapter', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
    nodemailerMock.createTransport.mockReset()
    nodemailerMock.sendMail.mockReset()
    nodemailerMock.close.mockReset()
    nodemailerMock.createTransport.mockReturnValue({
      sendMail: nodemailerMock.sendMail,
      close: nodemailerMock.close,
    })
    nodemailerMock.sendMail.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('sends through SMTP transport when SMTP_HOST is set and uses SMTP_USER as from fallback', async () => {
    vi.stubEnv('SMTP_HOST', 'smtp.monexus.test')
    vi.stubEnv('SMTP_USER', 'sender@monexus.test')
    vi.stubEnv('SMTP_PASS', 'super-secret-smtp-pass')
    vi.stubEnv('SMTP_FROM', undefined)

    const { getMailer } = await import('../lib/mailer/index.js')
    const mailer = await getMailer()

    await mailer.send({
      to: 'recipient@monexus.test',
      subject: 'Verify your email',
      text: 'Plain text body',
      html: '<p>HTML body</p>',
    })

    // R4/R5:transport 按次创建(socket 一一对应),getSocket 是总 deadline
    // 与自实现连接段超时的抓手;dnsTimeout/connectionTimeout 对自备连接
    // 不生效,不配置(建连段超时在 getSocket 内自实现)。
    expect(nodemailerMock.createTransport).toHaveBeenCalledTimes(1)
    expect(nodemailerMock.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: 'smtp.monexus.test',
      port: 587,
      secure: false,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
      auth: {
        user: 'sender@monexus.test',
        pass: 'super-secret-smtp-pass',
      },
      getSocket: expect.any(Function),
    }))
    expect(nodemailerMock.createTransport).not.toHaveBeenCalledWith(
      expect.objectContaining({ dnsTimeout: expect.anything() })
    )
    expect(nodemailerMock.sendMail).toHaveBeenCalledTimes(1)
    expect(nodemailerMock.sendMail).toHaveBeenCalledWith({
      // Default display name MoNexus when SMTP_FROM_NAME is unset.
      from: '"MoNexus" <sender@monexus.test>',
      to: 'recipient@monexus.test',
      subject: 'Verify your email',
      text: 'Plain text body',
      html: '<p>HTML body</p>',
    })
  })

  it('uses console fallback without creating SMTP transport when SMTP_HOST is unset', async () => {
    vi.stubEnv('SMTP_HOST', undefined)
    vi.stubEnv('SMTP_USER', 'sender@monexus.test')
    vi.stubEnv('SMTP_PASS', 'super-secret-smtp-pass')
    vi.stubEnv('SMTP_FROM', 'no-reply@monexus.test')
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    const { getMailer } = await import('../lib/mailer/index.js')
    const mailer = await getMailer()

    await mailer.send({
      to: 'recipient@monexus.test',
      subject: 'Fallback email',
      text: 'Reset link: https://app.monexus.test/reset-password/deadbeef123456',
    })

    expect(nodemailerMock.createTransport).not.toHaveBeenCalled()
    expect(nodemailerMock.sendMail).not.toHaveBeenCalled()
    expect(consoleLog).toHaveBeenCalledTimes(1)
    const logged = consoleLog.mock.calls[0][0]
    expect(logged).toContain('[mailer] to: recipient@monexus.test')
    expect(logged).toContain('[mailer] subject: Fallback email')
    expect(logged).not.toContain('deadbeef123456')
    expect(logged).not.toContain('super-secret-smtp-pass')
  })
})
