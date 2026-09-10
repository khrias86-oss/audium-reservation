# Cloud Run 배포 절차

> M1(정찰)과 M3~M6이 끝난 뒤에 수행한다. 지금은 참고용 골격이다.

## 0. 사전 준비

```bash
gcloud auth login
gcloud config set project <PROJECT_ID>
gcloud services enable run.googleapis.com cloudscheduler.googleapis.com artifactregistry.googleapis.com
```

리전은 **무료 한도가 적용되는 미국 리전**을 쓴다 (`us-central1`).
한국 리전에 배포하면 무료 한도를 받지 못한다.

## 1. 시크릿

개인정보와 API 키는 이미지에 넣지 않는다.

```bash
echo -n "<Neon 연결 문자열>" | gcloud secrets create DATABASE_URL --data-file=-
echo -n "<Resend API 키>"    | gcloud secrets create RESEND_API_KEY --data-file=-
```

## 2. 대시보드 (Cloud Run 서비스)

```bash
gcloud run deploy audeum-dashboard \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars MODE=server,DRY_RUN=true \
  --set-secrets DATABASE_URL=DATABASE_URL:latest \
  --memory 512Mi \
  --min-instances 0
```

`--min-instances 0`이 scale-to-zero다. 사용자가 열 때만 과금된다.

## 3. 워커 (Cloud Run 잡)

```bash
gcloud run jobs create audeum-tick \
  --source . \
  --region us-central1 \
  --set-env-vars MODE=tick,DRY_RUN=true \
  --set-secrets DATABASE_URL=DATABASE_URL:latest,RESEND_API_KEY=RESEND_API_KEY:latest \
  --memory 512Mi \
  --task-timeout 60s \
  --max-retries 0
```

- `--memory`: 경로 B(Playwright)라면 `2Gi`로 올리고 `Dockerfile`의 base 이미지도 바꾼다
- `--task-timeout 60s`: 틱은 30초 예산이다. 넘으면 다음 틱에 맡기는 편이 낫다
- `--max-retries 0`: 플랫폼 재시도를 끈다. 재시도 정책은 애플리케이션이 관리한다
  (§2.4-3, 최대 2회). 양쪽이 각자 재시도하면 중복 제출 위험이 생긴다

## 4. 스케줄

```bash
gcloud scheduler jobs create http audeum-poll \
  --location us-central1 \
  --schedule "*/10 * * * *" \
  --time-zone "Asia/Seoul" \
  --uri "https://<REGION>-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/<PROJECT_ID>/jobs/audeum-tick:run" \
  --http-method POST \
  --oauth-service-account-email <SA>@<PROJECT_ID>.iam.gserviceaccount.com
```

Cloud Scheduler 무료 한도는 잡 3개다. 이 1개만 쓴다.

## 5. 실제 예약 켜기 (최종 단계)

`/dryrun`으로 페이로드를 검증하고 사용자 승인을 받은 뒤에만:

```bash
gcloud run jobs update audeum-tick --region us-central1 --set-env-vars MODE=tick,DRY_RUN=false
```

**이 명령 전까지 시스템은 절대 실제 예약을 제출하지 않는다.**

## 6. 확인

```bash
curl https://<대시보드 URL>/healthz     # {"ok":true}
curl https://<대시보드 URL>/status      # 하트비트 상태 — stale=false여야 정상
gcloud run jobs executions list --job audeum-tick --region us-central1
```

24시간 뒤 하트비트가 끊김 없이 이어졌는지 확인한다 (M7 수락 기준).
