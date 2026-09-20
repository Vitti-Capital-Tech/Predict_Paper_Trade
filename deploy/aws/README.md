# Hosting the worker on AWS (ECS Fargate)

The dashboard is static and lives on Vercel. The database is Supabase. Neither
runs the worker — a long-lived Python process that polls Delta every couple of
seconds, fills queued orders against the real order book, and settles positions
at expiry. It serves no HTTP and needs nothing but a host that keeps it alive.

Fargate suits that: no server to patch, the task restarts if it exits, and logs
land in CloudWatch. Roughly **$9/month** at 0.25 vCPU / 0.5 GB running
continuously on ARM.

Files here:

| File | What it is |
|---|---|
| `task-definition.json` | The ECS task. Replace `ACCOUNT_ID` and `REGION`. |
| `deploy.sh` | Build → push to ECR → force a new deployment. Re-runnable. |

---

## One-time setup

Set these for the whole session:

```bash
export AWS_ACCOUNT_ID=123456789012
export AWS_REGION=ap-south-1
```

### 1. Store the secrets

`SUPABASE_SERVICE_KEY` bypasses RLS — it must never sit in the task definition,
in git, or in an environment variable you can read from the console. Put both in
Parameter Store as SecureStrings; the task definition references them by ARN and
ECS injects them at start.

```bash
aws ssm put-parameter --name /predict/SUPABASE_URL --type SecureString \
  --value "https://xxxx.supabase.co" --region "$AWS_REGION"

aws ssm put-parameter --name /predict/SUPABASE_SERVICE_KEY --type SecureString \
  --value "eyJhbGci..." --region "$AWS_REGION"
```

### 2. Execution role

Fargate needs a role to pull the image, write logs, and read those two
parameters — and *only* those two.

```bash
aws iam create-role --role-name predictWorkerExecutionRole \
  --assume-role-policy-document '{
    "Version":"2012-10-17",
    "Statement":[{"Effect":"Allow",
      "Principal":{"Service":"ecs-tasks.amazonaws.com"},
      "Action":"sts:AssumeRole"}]}'

aws iam attach-role-policy --role-name predictWorkerExecutionRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy

aws iam put-role-policy --role-name predictWorkerExecutionRole \
  --policy-name ReadPredictParameters \
  --policy-document "{
    \"Version\":\"2012-10-17\",
    \"Statement\":[{\"Effect\":\"Allow\",
      \"Action\":[\"ssm:GetParameters\"],
      \"Resource\":\"arn:aws:ssm:${AWS_REGION}:${AWS_ACCOUNT_ID}:parameter/predict/*\"}]}"
```

### 3. Cluster

```bash
aws ecs create-cluster --cluster-name predict --region "$AWS_REGION"
```

### 4. First image

```bash
./deploy/aws/deploy.sh
```

It will say the service does not exist yet — expected on the first run.

### 5. Register the task and create the service

Substitute your ids into the task definition, then register it:

```bash
sed -e "s/ACCOUNT_ID/${AWS_ACCOUNT_ID}/g" -e "s/REGION/${AWS_REGION}/g" \
  deploy/aws/task-definition.json > /tmp/td.json

aws ecs register-task-definition --cli-input-json file:///tmp/td.json \
  --region "$AWS_REGION"
```

The task needs outbound internet to reach Delta and Supabase. In a **public**
subnet that means `assignPublicIp=ENABLED`; in a private subnet it means a NAT
gateway (which costs more than the worker does, so prefer a public subnet — the
task accepts no inbound traffic and opens no port).

```bash
SUBNET=subnet-xxxxxxxx      # a public subnet
SG=sg-xxxxxxxx              # a security group with NO inbound rules

aws ecs create-service \
  --cluster predict \
  --service-name predict-paper-worker \
  --task-definition predict-paper-worker \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET],securityGroups=[$SG],assignPublicIp=ENABLED}" \
  --region "$AWS_REGION"
```

**Keep `desired-count` at 1.** Two workers would both fill the same queued
orders and both settle the same positions, double-crediting every account.

---

## Everyday use

Deploy a change:

```bash
./deploy/aws/deploy.sh
```

Watch it:

```bash
aws logs tail /ecs/predict-paper-worker --follow --region "$AWS_REGION"
```

A healthy log shows a `ROUND` line per new round and `SKIP ... ATR gate` while
the filter is holding entries back. `MANUAL filled` means a panel order was
executed.

Stop paying without deleting anything:

```bash
aws ecs update-service --cluster predict --service predict-paper-worker \
  --desired-count 0 --region "$AWS_REGION"
```

---

## What a restart does

Every deployment stops the old task and starts a new one, and open positions
live in the worker's memory. On startup the worker now adopts any position left
`open` by a run whose heartbeat has gone silent (`recover_open_positions` in
`config.yaml`), and closes it against the row it came from rather than forking a
new one — so a redeploy no longer strands trades.

Two consequences worth knowing:

- Adoption waits for `adopt_stale_after_sec` (120s) of silence, so a position
  opened seconds before a redeploy is picked up about two minutes later, not
  instantly. Settlement still happens; it is just not immediate.
- That window is what stops two workers fighting over the same position. Do not
  lower it below the poll interval, and do not run a second task.

The local JSONL ledger under `data/` is ephemeral on Fargate, which is fine —
Supabase is the book of record and the JSONL is only a fallback.
