# CapRover celery 서비스 오버라이드 (X99 홈서버)

`pickket-celery-beat` / `pickket-celery-worker` 앱의 **헬스체크·배포순서 영구 설정**.
CapRover 앱설정(`serviceUpdateOverride`)에 저장되므로 `caprover deploy` 재배포에도 유지된다.

## 배경 — 무엇이 문제였나

celery 앱은 별도 Dockerfile 없이 **backend 이미지를 공유**하고, 실행 커맨드만
`serviceUpdateOverride.ContainerSpec.Command` 로 celery 로 덮어쓴다. 그런데 backend
[`Dockerfile`](../../../backend/Dockerfile) 에는 **API용 HTTP 헬스체크**가 있다:

```dockerfile
HEALTHCHECK ... CMD curl -f http://localhost:8000/health/live || exit 1
```

beat/worker 는 HTTP 서버가 없다 → 이 헬스체크가 **항상 실패** → swarm 이 unhealthy
로 보고 컨테이너를 죽이고 재생성(~2.5분 주기 flapping) → beat 다중 인스턴스가 겹쳐
**스케줄 중복 발행**(process-ticket-queues·check-payment-expiry·auto-match-resale 등).

> ⚠️ backend `Dockerfile` 의 HEALTHCHECK 는 **API(`pickket-backend`)가 필요**로 하므로
> 삭제하면 안 된다. 공유 이미지이므로 **celery 쪽만 앱별로 덮어쓰는 것**이 올바른 수정.

런타임 핫픽스(`docker service update --no-healthcheck`)는 재배포하면 원복된다 —
CapRover 는 배포 때 앱설정(`serviceUpdateOverride`)으로 서비스 스펙을 재구성하기 때문.
그래서 그 앱설정 자체에 헬스체크 교정을 박아야 영구적이다.

## 이 디렉토리의 파일

| 파일 | 내용 |
|------|------|
| `serviceUpdateOverride.beat.json`   | beat: 헬스체크 **비활성**(`Test: ["NONE"]`) + `UpdateConfig.Order=stop-first` |
| `serviceUpdateOverride.worker.json` | worker: 헬스체크를 **celery inspect ping** 으로 교체 + `stop-first` |
| `apply-overrides.sh`                | CapRover API 로 두 앱에 멱등 적용(beat→worker) |

- **beat 헬스체크 = 없음**: 싱글톤 스케줄러라 HTTP·ping 대신 비활성(AWS ECS task-def 도 `healthCheck: null` 로 동일). 향후 강화 시 스케줄파일 `/tmp/celerybeat-schedule` mtime 신선도 체크 가능.
- **worker 헬스체크 = `celery inspect ping`**: broker 연결·워커 응답성까지 검증. AWS ECS
  [`celery-worker.json`](../../aws/task-definitions/celery-worker.json) 과 동일한 명령.
- **stop-first**: beat 는 싱글톤이라 배포 시 start-first 겹침이 stuck-update·중복발행의
  원인이었다. 구 태스크를 먼저 내리고 새 태스크를 띄운다.

## 적용

```bash
CAPROVER_URL=http://192.168.0.9:3000 \
CAPROVER_PASSWORD='<대시보드 비번>' \
  bash platform/infra/caprover/celery/apply-overrides.sh
```

또는 **대시보드 수동**(집 안 LAN): 각 앱 → *Service Update Override* 필드에 해당 JSON을
붙여넣고 *Save & Update*. (LAN 전용: http://192.168.0.9:3000)

### 검증

```bash
# beat: 헬스체크가 비활성(NONE), 태스크 1개로 수렴, 재시작 멈춤
docker service inspect srv-captain--pickket-celery-beat \
  --format '{{json .Spec.TaskTemplate.ContainerSpec.Healthcheck}}'   # => {"Test":["NONE"]}
docker service ps srv-captain--pickket-celery-beat --no-trunc | head

# worker: ping 헬스체크, healthy 유지
docker service inspect srv-captain--pickket-celery-worker \
  --format '{{json .Spec.TaskTemplate.ContainerSpec.Healthcheck}}'
```

## 다른 배포 타깃 (참고 — 이미 정상)

- **AWS ECS**: task-def 가 이미 올바름 — beat `healthCheck: null`, worker `inspect ping`.
  (`platform/infra/aws/task-definitions/{,stg/,prod/}celery-*.json`)
- **docker-compose**: celery 서비스에 헬스체크 없음.

즉 이 회귀는 **CapRover 경로 전용**이었고, 이 디렉토리가 그 앱설정을 버전관리로 보존한다.
