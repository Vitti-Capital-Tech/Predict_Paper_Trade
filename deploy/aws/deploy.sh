#!/usr/bin/env bash
# Build the worker image, push it to ECR, and roll the Fargate service.
#
# Idempotent: safe to re-run. Creates the ECR repository and the log group on
# first use, then just pushes and forces a new deployment.
#
#   AWS_ACCOUNT_ID=123456789012 AWS_REGION=ap-south-1 ./deploy/aws/deploy.sh
set -euo pipefail

: "${AWS_ACCOUNT_ID:?set AWS_ACCOUNT_ID}"
AWS_REGION="${AWS_REGION:-ap-south-1}"
REPO="${REPO:-predict-paper-worker}"
CLUSTER="${CLUSTER:-predict}"
SERVICE="${SERVICE:-predict-paper-worker}"
REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
TAG="$(git rev-parse --short HEAD)"

echo "==> ECR repository"
aws ecr describe-repositories --repository-names "$REPO" --region "$AWS_REGION" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "$REPO" --region "$AWS_REGION" \
       --image-scanning-configuration scanOnPush=true >/dev/null

aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"

# The task definition pins ARM64 (Graviton is cheaper), so build for it
# explicitly — an image built on an x86 laptop will not start otherwise.
echo "==> build and push ${REPO}:${TAG}"
docker buildx build \
  --platform linux/arm64 \
  -t "${REGISTRY}/${REPO}:${TAG}" \
  -t "${REGISTRY}/${REPO}:latest" \
  --push .

echo "==> roll the service"
if aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
     --region "$AWS_REGION" --query 'services[0].status' --output text 2>/dev/null \
     | grep -q ACTIVE; then
  aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" \
    --force-new-deployment --region "$AWS_REGION" >/dev/null
  echo "    deployment triggered"
else
  echo "    service '$SERVICE' not found — create it once with the runbook, then re-run"
fi

echo "==> done: ${REGISTRY}/${REPO}:${TAG}"
