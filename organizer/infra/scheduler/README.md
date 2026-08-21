# Authoritative scheduler

Organizer recovery jobs use Kubernetes `CronJob` as the single scheduler. The
authoritative inventory is [`infra/cron/kustomization.yaml`](../cron/kustomization.yaml).
CapRover curl snippets in individual manifests are migration notes only and
must not be enabled alongside these CronJobs.

## Validate

```bash
npm run scheduler:validate
```

## Staging plan/apply

The default is a server-side dry run and requires a valid kube context:

```bash
SCHEDULER_ENVIRONMENT=staging SCHEDULER_DRY_RUN=1 ./scripts/scheduler-apply.sh
SCHEDULER_ENVIRONMENT=staging SCHEDULER_DRY_RUN=0 ./scripts/scheduler-apply.sh
```

The staging overlay reads `CRON_SECRET` from `pickket-go-stg-secrets`; the
production overlay reads `pickket-go-secrets`. No secret is stored in this
repo. Production requires the explicit `ALLOW_PRODUCTION_SCHEDULER=1` guard.

Each job uses `concurrencyPolicy: Forbid`, a bounded retry policy, and the
application's DB claim/lease protection. Verify the latest execution with:

```bash
kubectl -n pickket-go get cronjobs,jobs --sort-by=.metadata.creationTimestamp
npm run cron:telemetry
```
