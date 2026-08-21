#!/usr/bin/env bash
# S3 Static Failover Page Setup
set -euo pipefail

REGION="ap-northeast-2"
BUCKET="pickket-failover-page"

echo "=== Creating S3 Failover Bucket ==="
aws s3 mb "s3://${BUCKET}" --region "$REGION" 2>/dev/null || true

echo "Enabling static website hosting..."
aws s3 website "s3://${BUCKET}" \
  --index-document index.html \
  --error-document index.html

echo "Setting bucket policy for public read..."
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{
    \"Sid\": \"PublicRead\",
    \"Effect\": \"Allow\",
    \"Principal\": \"*\",
    \"Action\": \"s3:GetObject\",
    \"Resource\": \"arn:aws:s3:::${BUCKET}/*\"
  }]
}"

echo "Uploading failover page..."
cat > /tmp/failover-index.html << 'HTMLEOF'
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pickket - 서비스 점검 중</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Pretendard', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      background: #0f0f23;
      color: #fff;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
    }
    .container { max-width: 480px; padding: 2rem; }
    .logo { font-size: 2.5rem; font-weight: 800; color: #a78bfa; margin-bottom: 2rem; }
    h1 { font-size: 1.5rem; margin-bottom: 1rem; }
    p { color: rgba(255,255,255,0.7); line-height: 1.6; margin-bottom: 1rem; }
    .retry-btn {
      display: inline-block; margin-top: 1rem; padding: 12px 32px;
      background: #818cf8; color: #fff; border-radius: 8px;
      text-decoration: none; font-weight: 600; font-size: 1rem;
    }
    .retry-btn:hover { background: #a78bfa; }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">PICKKET</div>
    <h1>서비스 점검 중입니다</h1>
    <p>더 나은 서비스를 위해 잠시 점검 중입니다.<br>곧 다시 만나요!</p>
    <p style="font-size: 0.85rem;">문의: support@pickket.kr</p>
    <a href="/" class="retry-btn">다시 시도</a>
  </div>
</body>
</html>
HTMLEOF

aws s3 cp /tmp/failover-index.html "s3://${BUCKET}/index.html" \
  --content-type "text/html; charset=utf-8" \
  --cache-control "max-age=60"

echo ""
echo "=== Failover page deployed ==="
echo "URL: http://${BUCKET}.s3-website.${REGION}.amazonaws.com"
echo ""
echo "Configure ALB fixed-response rule for 502/503 to redirect here,"
echo "or use CloudFront origin failover with this S3 bucket as secondary origin."
