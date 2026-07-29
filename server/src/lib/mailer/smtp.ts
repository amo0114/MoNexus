import { createConnection, type Socket } from 'node:net'
import nodemailer from 'nodemailer'
import { Mailer, MailMessage } from './types.js'

export interface SmtpConfig {
  host: string
  port: number
  secure: boolean
  user?: string
  pass?: string
  from?: string
  /** 测试注入:覆盖总发送 deadline(生产用默认常量)。 */
  totalDeadlineMs?: number
}

// 复审 R4/R5:分段超时只是快速失败辅助——它们的和 **不能** 当作总时限
// (socketTimeout 是 **无活动** 超时,慢滴/分段响应可无限续命)。
// R5 修正:底层 socket 由我们经 getSocket 自建,nodemailer 的 dnsTimeout/
// connectionTimeout 走它自己的建连流程、对自备连接 **不生效**——DNS+TCP
// 建连段的超时由下面的 SMTP_CONNECT_TIMEOUT_MS **自行实现**(getSocket 内
// 定时器,到点 destroy)。greeting/socket-idle 两段作用于已建立的 socket,
// 对自备连接仍有效,继续交给 nodemailer。
export const SMTP_CONNECT_TIMEOUT_MS = 10_000
export const SMTP_GREETING_TIMEOUT_MS = 10_000
export const SMTP_SOCKET_TIMEOUT_MS = 15_000

/**
 * 真实墙钟总时限:到点 **destroy 底层 socket**(TCP 级中断,不是 Promise
 * race——原发送在 socket 死亡后必然以错误落定,不会在后台继续)。
 * 必须小于 provisionCron 的 NOTIFY_LEASE_MS(有静态断言回归):租约未到期
 * 时在途发送已被强制终止,重发绝不与在途发送重叠。
 */
export const SMTP_TOTAL_DEADLINE_MS = 30_000

export class SmtpMailer implements Mailer {
  private readonly totalDeadlineMs: number

  constructor(private readonly cfg: SmtpConfig) {
    this.totalDeadlineMs = cfg.totalDeadlineMs ?? SMTP_TOTAL_DEADLINE_MS
  }

  async send(msg: MailMessage): Promise<void> {
    // 底层 socket 由我们经 getSocket 代理钩子建立并持有——这是 nodemailer
    // 官方的自备连接路径(smtp-transport getSocket → smtp-connection 的
    // options.connection 分支,secure:true 时自动做 TLS 升级)。deadline 到点
    // 直接 destroy,SMTP 连接被实际切断。socket 按次一一对应,故 transport
    // 按次创建(getMailer 单例被多个 cron 并发共用,不能共享可变 socket 槽)。
    let socket: Socket | null = null
    let timedOut = false
    const deadlineError = () => new Error(`SMTP send exceeded total deadline (${this.totalDeadlineMs}ms)`)
    const deadline = setTimeout(() => {
      timedOut = true
      socket?.destroy(deadlineError())
    }, this.totalDeadlineMs)
    deadline.unref?.()

    const transport = nodemailer.createTransport({
      host: this.cfg.host,
      port: this.cfg.port,
      secure: this.cfg.secure,
      greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
      socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
      ...(this.cfg.user && this.cfg.pass ? { auth: { user: this.cfg.user, pass: this.cfg.pass } } : {}),
      getSocket: (_opts: unknown, cb: (err: Error | null, result?: { connection: Socket }) => void) => {
        if (timedOut) return cb(deadlineError())
        let settled = false
        const s = createConnection({ host: this.cfg.host, port: this.cfg.port })
        socket = s
        // R5:DNS+TCP 建连段超时自行实现——自备连接不经 nodemailer 的
        // dnsTimeout/connectionTimeout 流程,不能依赖它们。
        const connectTimer = setTimeout(() => {
          s.destroy(new Error(`SMTP connect phase (DNS/TCP) timed out (${SMTP_CONNECT_TIMEOUT_MS}ms)`))
        }, SMTP_CONNECT_TIMEOUT_MS)
        connectTimer.unref?.()
        s.once('connect', () => {
          clearTimeout(connectTimer)
          if (settled) return
          settled = true
          cb(null, { connection: s })
        })
        s.once('error', err => {
          clearTimeout(connectTimer)
          if (settled) return
          settled = true
          cb(err)
        })
      },
    })

    try {
      await transport.sendMail({
        from: this.cfg.from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      })
      // 极端时序保险:destroy 之后仍成功返回按超时处理(结果不可信)。
      if (timedOut) throw deadlineError()
    } catch (err) {
      throw timedOut ? deadlineError() : err
    } finally {
      clearTimeout(deadline)
      transport.close()
    }
  }
}
