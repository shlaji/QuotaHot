export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0 || at === email.length - 1) return email;
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const maskedDomain =
    dot > 0 && dot < domain.length - 1 ? `${domain[0]}***${domain.slice(dot)}` : `${domain[0]}***`;
  return `${email[0]}***@${maskedDomain}`;
}
