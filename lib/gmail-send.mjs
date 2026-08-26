// Gmail API 발송 (서비스계정 + 도메인 전체 위임). Railway가 SMTP를 막아서 HTTP(443)로 발송.
//   GOOGLE_SERVICE_ACCOUNT_JSON : 서비스계정 키 JSON (드라이브 백업과 동일 계정 재사용)
//   GMAIL_SENDER                : 발신 주소(Workspace 실제 사용자). SA가 이 사용자로 위임 발송.
// 관리자 콘솔에서 SA client_id에 scope https://www.googleapis.com/auth/gmail.send 위임 필요.
import { JWT } from 'google-auth-library';
import nodemailer from 'nodemailer';

const SA = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
const SENDER = process.env.GMAIL_SENDER || '';

export const gmailApiEnabled = () => !!(SA && SENDER);
export const gmailSender = () => SENDER;

let _jwt = null;
async function client() {
  if (_jwt) return _jwt;
  const key = JSON.parse(SA);
  _jwt = new JWT({
    email: key.client_email, key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/gmail.send'], subject: SENDER,  // subject=위임 대상 사용자
  });
  await _jwt.authorize();
  return _jwt;
}

// MIME 생성은 nodemailer(streamTransport)로 재사용 — UTF-8 제목·multipart/related(인라인 이미지) 처리.
const mimeTp = nodemailer.createTransport({ streamTransport: true, newline: 'unix', buffer: true });

export async function gmailSend({ from, to, bcc, subject, html, attachments }) {
  const built = await mimeTp.sendMail({ from, to, bcc, subject, html, attachments: attachments || [] });
  const raw = Buffer.from(built.message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const jwt = await client();
  const token = (await jwt.getAccessToken()).token;
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) throw new Error(`Gmail API ${res.status}: ${await res.text()}`);
  return (await res.json()).id;
}
