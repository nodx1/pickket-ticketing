#!/usr/bin/env bash
# SES Production Setup for pickket.kr
set -euo pipefail

REGION="ap-northeast-2"
DOMAIN="pickket.kr"

echo "=== SES Domain Verification ==="
aws ses verify-domain-identity --domain "$DOMAIN" --region "$REGION"

echo ""
echo "=== DKIM Setup ==="
DKIM_TOKENS=$(aws ses verify-domain-dkim --domain "$DOMAIN" --region "$REGION" --query 'DkimTokens' --output text)

echo "Add the following CNAME records to Cloudflare DNS:"
echo ""
for token in $DKIM_TOKENS; do
  echo "  Name:  ${token}._domainkey.${DOMAIN}"
  echo "  Value: ${token}.dkim.amazonses.com"
  echo ""
done

echo "=== SPF Record ==="
echo "Add TXT record to Cloudflare DNS:"
echo "  Name:  ${DOMAIN}"
echo "  Value: v=spf1 include:amazonses.com ~all"
echo ""

echo "=== DMARC Record ==="
echo "Add TXT record to Cloudflare DNS:"
echo "  Name:  _dmarc.${DOMAIN}"
echo "  Value: v=DMARC1; p=quarantine; rua=mailto:dmarc@${DOMAIN}"
echo ""

echo "=== Verification Status ==="
aws ses get-identity-verification-attributes \
  --identities "$DOMAIN" \
  --region "$REGION"

echo ""
echo "=== IMPORTANT ==="
echo "1. Add DNS records above to Cloudflare"
echo "2. Wait for verification (usually 1-72 hours)"
echo "3. Request production access (sandbox removal):"
echo "   aws ses put-account-details --region $REGION --production-access-enabled"
echo "   (Requires support case for high volume sending)"
