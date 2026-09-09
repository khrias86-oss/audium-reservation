/**
 * 진입점. 하나의 이미지가 두 가지 모드로 동작한다.
 *
 *   MODE=server  — 대시보드 HTTP 서버로 상주 (Cloud Run 서비스, VM, 로컬 PC)
 *   MODE=tick    — 틱 1회를 실행하고 종료 (Cloud Run 잡, cron, GitHub Actions)
 *
 * 이 분리가 배포처를 되돌릴 수 있게 만든다. 스케줄링을 플랫폼에 맡기든
 * 프로세스 안에서 돌리든 같은 코드가 쓰인다.
 */
import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { checkHeartbeat } from './core/heartbeat.js';
import { createMemoryStore } from './store/memory.js';
import type { Store } from './store/types.js';

const config = loadConfig();

// M3에서 Postgres 구현으로 교체한다. 그때까지는 프로세스 메모리에만 산다.
const store: Store = createMemoryStore();

async function runServer(): Promise<void> {
  const server = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === '/status') {
      void store.getHeartbeat().then((hb) => {
        const status = checkHeartbeat(hb, new Date());
        res.writeHead(status.stale ? 503 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          stale: status.stale,
          message: status.message,
          liveBooking: config.liveBooking,
          pollIntervalMinutes: config.pollIntervalMinutes,
        }));
      });
      return;
    }

    res.writeHead(404).end('not found');
  });

  server.listen(config.port, () => {
    console.log(`[server] :${config.port} · 실제예약=${config.liveBooking ? 'ON' : 'OFF(DRY_RUN)'}`);
  });
}

async function runOneTick(): Promise<void> {
  // M1(정찰)이 끝나야 어댑터가 존재한다. 그 전에는 추측한 셀렉터로 도는 것보다
  // 명확히 실패하는 편이 낫다.
  const { assertContractReady } = await import('./adapters/audeum/contract.js');
  assertContractReady();
  throw new Error('어댑터가 아직 구현되지 않았습니다 (M1 정찰 필요)');
}

const entry = config.mode === 'server' ? runServer : runOneTick;
entry().catch((error: unknown) => {
  console.error('[fatal]', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
