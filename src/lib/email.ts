/**
 * Invio email transazionali via Brevo (https://brevo.com).
 * Richiede in .env:
 *   BREVO_API_KEY   — chiave API (Settings → SMTP & API → API Keys)
 *   SENDER_EMAIL    — mittente verificato su Brevo (Settings → Senders)
 *   SENDER_NAME     — nome visualizzato (default: WattLab)
 *   APP_URL         — URL pubblico dell'app, es. https://wattlab.duckdns.org
 *
 * Email gestite:
 *   • Benvenuto (+ conferma email)   → alla registrazione
 *   • Conferma email                 → reinvio verifica
 *   • Reimposta password             → password dimenticata
 *   • Password modificata (sicurezza)→ dopo reset o cambio password
 *   • Account eliminato              → alla cancellazione account
 */

const BREVO_API = 'https://api.brevo.com/v3/smtp/email';

interface SendEmailOpts {
  to: string;
  subject: string;
  html: string;
}

import { config } from './config.js';

export async function sendEmail({ to, subject, html }: SendEmailOpts): Promise<boolean> {
  const apiKey = config.email.brevoApiKey;
  const senderEmail = config.email.senderEmail;
  if (!apiKey || !senderEmail) {
    console.warn('[email] BREVO non configurato — email NON inviata a', to);
    return false;
  }
  try {
    const res = await fetch(BREVO_API, {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        sender: { email: senderEmail, name: config.email.senderName },
        to: [{ email: to }],
        subject,
        htmlContent: html,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[email] Brevo error', res.status, body.slice(0, 300));
      return false;
    }
    return true;
  } catch (e) {
    console.error('[email] network error', e);
    return false;
  }
}

// ─── Layout condiviso (dark, coerente con l'app) ─────────────────────
function layout(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="it"><body style="margin:0;padding:0;background:#0a0d14;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:480px;margin:0 auto;padding:40px 24px">
    <div style="text-align:center;margin-bottom:28px">
      <span style="font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.5px">WATTLAB</span>
    </div>
    <div style="background:#15151d;border-radius:16px;padding:32px 28px;border:1px solid rgba(255,255,255,0.08)">
      <h1 style="margin:0 0 12px;font-size:19px;color:#ffffff">${title}</h1>
      ${bodyHtml}
    </div>
    <p style="text-align:center;margin-top:20px;font-size:11px;color:#606068">WattLab · Training analytics</p>
  </div>
</body></html>`;
}

function button(url: string, label: string): string {
  return `<div style="text-align:center;margin:24px 0">
    <a href="${url}" style="display:inline-block;background:#4f8ef7;color:#ffffff;text-decoration:none;padding:13px 32px;border-radius:50px;font-size:14px;font-weight:700">${label}</a>
  </div>`;
}

const p = (txt: string) =>
  `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#a0a0a8">${txt}</p>`;
const note = (txt: string) =>
  `<p style="margin:8px 0 0;font-size:12px;line-height:1.6;color:#606068">${txt}</p>`;

// ─── Template ────────────────────────────────────────────────────────

/** Benvenuto alla registrazione. Se c'è verifyUrl, include il pulsante di conferma. */
export function welcomeEmailHtml(verifyUrl?: string | null): string {
  return layout('Benvenuto in WattLab 👋',
    p('Il tuo account è stato creato. WattLab analizza i tuoi allenamenti: potenza, frequenza, W′ balance, recovery e molto altro.') +
    (verifyUrl
      ? p('Per attivarlo del tutto, conferma il tuo indirizzo email — il link è valido <strong style="color:#ffffff">24 ore</strong>.') +
        button(verifyUrl, 'Conferma email') +
        note('Se non hai creato tu questo account, ignora pure questa email.')
      : p('Buoni allenamenti! 🚴') +
        note('Se non hai creato tu questo account, ignora pure questa email.'))
  );
}

/** Conferma email (reinvio). */
export function verifyEmailHtml(verifyUrl: string): string {
  return layout('Conferma la tua email',
    p('Conferma il tuo indirizzo email per attivare l\'account. Il link è valido <strong style="color:#ffffff">24 ore</strong>.') +
    button(verifyUrl, 'Conferma email') +
    note('Se non hai creato tu un account WattLab, ignora questa email.')
  );
}

/** Reimposta password (password dimenticata). */
export function passwordResetEmailHtml(resetUrl: string): string {
  return layout('Reimposta la password',
    p('Hai richiesto di reimpostare la password del tuo account WattLab. Clicca il pulsante qui sotto — il link è valido <strong style="color:#ffffff">30 minuti</strong>.') +
    button(resetUrl, 'Reimposta password') +
    note('Se non hai richiesto tu il reset, ignora questa email: la tua password resta invariata. Per sicurezza non condividere mai questo link.')
  );
}

/** Notifica di sicurezza: la password è stata cambiata. */
export function passwordChangedEmailHtml(appUrl?: string): string {
  const when = new Date().toLocaleString('it-IT', { dateStyle: 'long', timeStyle: 'short' });
  const link = (appUrl || '').replace(/\/$/, '');
  return layout('Password modificata',
    p(`La password del tuo account WattLab è stata <strong style="color:#ffffff">modificata</strong> il ${when}.`) +
    p('Se sei stato tu, è tutto a posto e puoi ignorare questa email.') +
    note(`Se <strong style="color:#ff8888">NON</strong> sei stato tu, qualcuno potrebbe avere accesso al tuo account: reimposta subito la password dall\'app${link ? ` (<a href="${link}" style="color:#4f8ef7">apri WattLab</a> → "Password dimenticata")` : ''} e controlla le sessioni attive.`)
  );
}

/** Conferma cancellazione account. */
export function accountDeletedEmailHtml(): string {
  return layout('Account eliminato',
    p('Il tuo account WattLab è stato eliminato e le sessioni sono state chiuse. I dati associati verranno rimossi.') +
    note('Se non hai richiesto tu questa operazione, contattaci il prima possibile rispondendo a questa email.')
  );
}
