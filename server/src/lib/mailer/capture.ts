import { Mailer, MailMessage } from './types.js'

// In-memory mailer used by the test suite. Captures every message
// without touching the network so tests can assert "the right email
// went out with the right token in the body".
export class CaptureMailer implements Mailer {
  public sent: MailMessage[] = []

  async send(msg: MailMessage): Promise<void> {
    this.sent.push(msg)
  }

  reset() {
    this.sent = []
  }

  lastTo(email: string): MailMessage | undefined {
    return [...this.sent].reverse().find(m => m.to === email)
  }
}
