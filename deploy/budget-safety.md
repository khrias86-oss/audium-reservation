# 예산 안전장치 (Budget Safety)

> 카드가 이미 등록된 GCP 프로젝트에 배포하기 **전에** 반드시 먼저 설정한다.
> `deploy/README.md`의 무료 한도 계산상 예상 비용은 $0이지만, "예상"과
> "보장"은 다르다. 아래는 실패했을 때도 소액에서 멈추게 하는 3중 방어선이다.

## 왜 3중인가

무료 한도 계산은 **정상 동작**을 가정한다. 코드에 버그가 있어 재시도가
무한 루프를 돌거나, 워커가 비정상적으로 자주 트리거되거나, 실수로
`--min-instances`를 올려버리면 계산이 깨진다. 하나의 방어선에만 의존하지
않는다.

## 1층 방어선 — 리소스 자체를 작게 만든다 (배포 시점)

과금은 "한도를 넘는 사용량"에서 나온다. 애초에 넘을 수 없게 만드는 게
가장 확실하다.

```bash
gcloud run deploy audeum-dashboard \
  --max-instances 2 \       # scale-to-zero 기본이지만 폭주 시 상한을 건다
  --concurrency 10 \
  --cpu 1 --memory 512Mi

gcloud run jobs create audeum-tick \
  --max-retries 0 \         # 재시도는 애플리케이션이 관리한다 (§2.4-3, 최대 2회)
  --task-timeout 60s \      # 틱 예산은 30초 (§2.1). 60초 넘으면 뭔가 잘못된 것
  --parallelism 1 \         # 동시 실행 1개 — 중복 틱 자체를 차단
  --cpu 1 --memory 512Mi
```

Cloud Scheduler는 **잡 1개만** 만든다 (무료 한도 3개 중 1개 사용).
스케줄이 실수로 중복 생성되면 그만큼 과금이 커진다 — 배포 스크립트가
아니라 `gcloud scheduler jobs list`로 항상 개수를 확인한다.

## 2층 방어선 — 예산 알림 (사용량 급증을 즉시 안다)

```bash
# 결제 계정 ID 확인
gcloud billing accounts list

# 월 $5 예산에 50%/90%/100% 알림 — 무료 한도만 쓴다면 절대 도달하지 않아야 정상
gcloud billing budgets create \
  --billing-account=<BILLING_ACCOUNT_ID> \
  --display-name="audeum-reservation 안전선" \
  --budget-amount=5USD \
  --threshold-rule=percent=0.5 \
  --threshold-rule=percent=0.9 \
  --threshold-rule=percent=1.0
```

**$5는 임의의 소액 상한이지 예상 사용량이 아니다.** 이 알림이 한 번이라도
오면 무료 한도 계산이 어딘가 틀렸다는 뜻이므로, 원인을 찾을 때까지
아래 "즉시 중단" 절차를 먼저 실행한다.

기본은 이메일 알림만 온다. 자동으로 무언가를 멈추게 하려면 3층이 필요하다.

## 3층 방어선 — 자동 서킷브레이커 (선택, 권장)

예산 알림은 사람이 봐야 의미가 있다. 못 보고 넘어갈 가능성이 걱정되면,
예산 초과 시 **자동으로 워커를 멈추는** 회로를 추가한다. Cloud Billing
budget → Pub/Sub → Cloud Function이 표준 패턴이다.

```bash
# 예산 알림이 Pub/Sub 토픽으로도 발행되게 한다
gcloud billing budgets create \
  --billing-account=<BILLING_ACCOUNT_ID> \
  --display-name="audeum-reservation 안전선" \
  --budget-amount=5USD \
  --threshold-rule=percent=1.0 \
  --all-updates-rule-pubsub-topic=projects/<PROJECT_ID>/topics/budget-alerts

# 알림 수신 시 Cloud Scheduler 잡을 비활성화하는 함수
gcloud functions deploy budget-circuit-breaker \
  --runtime nodejs22 \
  --trigger-topic budget-alerts \
  --entry-point onBudgetAlert \
  --source ./deploy/budget-circuit-breaker
```

함수 로직: 알림의 `costAmount >= budgetAmount`이면
`gcloud scheduler jobs pause audeum-poll`을 호출한다. 이러면 워커가
멈추고, 대시보드(scale-to-zero라 원래도 저비용)만 남는다. 예산의
1.0(100%) 임계값에서만 작동하게 해 오탐으로 자주 멈추지 않게 한다.

**이건 필요할 때 구현한다** — M7(배포) 직전에, 위 gcloud 명령을 그대로
실행하면 된다. 지금 코드베이스에 넣지 않는 이유는 아직 GCP 프로젝트가
없어 `<PROJECT_ID>`를 채울 수 없기 때문이다.

## 배포 전 체크리스트

- [ ] 1층: `--max-instances`, `--concurrency`, `--max-retries 0`,
      `--parallelism 1`을 배포 명령에 명시했다
- [ ] 2층: 예산 알림을 만들었고 본인 이메일로 수신 확인했다
- [ ] Cloud Scheduler 잡이 **정확히 1개**인지 확인했다
      (`gcloud scheduler jobs list`)
- [ ] (선택) 3층 자동 서킷브레이커를 붙였다
- [ ] `deploy/README.md`의 무료 한도 예산표와 실제 리전(`us-central1`)이
      일치하는지 확인했다 — 다른 리전은 무료 한도가 적용되지 않는다

## 알림을 받았을 때 (runbook 연동)

예산 알림이 오면 `docs/runbook.md`의 "CIRCUIT_OPEN" 절차가 아니라
**과금 이상**이므로 별도로 처리한다:

1. `gcloud scheduler jobs pause audeum-poll` — 즉시 폴링을 멈춘다
2. `gcloud run jobs executions list --job audeum-tick` — 최근 실행 빈도 확인.
   비정상적으로 잦다면 스케줄이 중복 생성됐거나 코드가 재시도 루프에 빠진 것
3. Cloud Billing 콘솔의 "리포트"에서 어떤 서비스가 비용을 냈는지 확인
   (거의 항상 Cloud Run vCPU/메모리 초과 아니면 Cloud Scheduler 잡 개수 초과)
4. 원인을 고치고, `pnpm verify`로 재검증한 뒤에만 `jobs resume`으로 재개
