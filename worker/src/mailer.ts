// Mailer over Resend's HTTP API. The only code that knows Resend's URL.

import type { Email } from "./automation/email";
import type { Mailer } from "./automation/reviewJob";

export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly to: string[],
    private readonly fetchFn: typeof fetch,
  ) {}

  async send(email: Email): Promise<void> {
    const res = await this.fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: this.from, to: this.to, subject: email.subject, html: email.html, text: email.text }),
    });
    if (!res.ok) throw new Error(`Resend failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
}
