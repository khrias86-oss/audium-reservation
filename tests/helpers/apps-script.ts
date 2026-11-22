import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

/**
 * `mailer/Code.gs`를 Node에서 돌리기 위한 가짜 Google 서비스.
 *
 * Apps Script는 로컬에서 실행할 수 없지만 코드 자체는 평범한 자바스크립트다.
 * 시트·메일·푸시·속성 저장소만 흉내 내면 실제 파일을 그대로 시험할 수 있다 —
 * 서버 쪽 규칙(10분 재확인, 만료, 열쇠 검사)이 테스트 없이 배포되지 않게.
 */
export interface Mail { to: string; subject: string; body: string; name?: string }
export interface Push { url: string; payload: { topic: string; title: string; message: string; click: string; priority: number } }

export interface AppsScriptWorld {
  readonly ctx: Record<string, any>;
  readonly mails: Mail[];
  readonly pushes: Push[];
  readonly props: Map<string, string>;
  /** 시트의 현재 값 (머리글 포함) */
  sheetValues(): string[][];
  quota: number;
  pushStatus: number;
  /** doPost를 부르고 JSON 응답을 돌려준다 */
  post(body: unknown, now?: number): any;
  /** doGet을 부른다 */
  get(params: Record<string, string>): { content: string; title?: string };
}

export const SERVICE_URL = 'https://script.google.com/macros/s/TEST/exec';

export function loadAppsScript(): AppsScriptWorld {
  const source = readFileSync(new URL('../../mailer/Code.gs', import.meta.url), 'utf8');
  const mails: Mail[] = [];
  const pushes: Push[] = [];
  const props = new Map<string, string>();
  let values: string[][] = [];

  const range = (rows: number) => ({
    setNumberFormat() { return this; },
    setValues(v: string[][]) {
      if (v.length !== rows) throw new Error('행 수가 맞지 않습니다');
      values = v.map((r) => [...r]);
      return this;
    },
  });
  const sheet = {
    getDataRange: () => ({ getValues: () => values.map((r) => [...r]) }),
    clearContents: () => { values = []; },
    getRange: (_r: number, _c: number, rows: number) => range(rows),
    setName() { return this; },
  };
  const spreadsheet = {
    getId: () => 'SHEET',
    getUrl: () => 'https://docs.google.com/spreadsheets/d/SHEET',
    getSheetByName: () => sheet,
    insertSheet: () => sheet,
    getSheets: () => [sheet],
  };

  const world = {
    mails, pushes, props, quota: 100, pushStatus: 200,
    sheetValues: () => values.map((r) => [...r]),
  } as unknown as AppsScriptWorld;

  const ctx: Record<string, any> = {
    console,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k: string) => props.get(k) ?? null,
        setProperty: (k: string, v: string) => { props.set(k, v); },
      }),
    },
    SpreadsheetApp: { openById: () => spreadsheet, create: () => spreadsheet },
    MailApp: {
      getRemainingDailyQuota: () => world.quota,
      sendEmail: (m: Mail) => {
        if (world.quota <= 0) throw new Error('Service invoked too many times for one day: email.');
        world.quota--;
        mails.push(m);
      },
    },
    UrlFetchApp: {
      fetch: (url: string, opt: { payload: string }) => {
        pushes.push({ url, payload: JSON.parse(opt.payload) });
        return { getResponseCode: () => world.pushStatus };
      },
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (content: string) => ({ content, setMimeType() { return this; } }),
    },
    HtmlService: {
      createHtmlOutput: (content: string) => ({ content, title: '', setTitle(t: string) { this.title = t; return this; } }),
    },
    ScriptApp: { getService: () => ({ getUrl: () => SERVICE_URL }) },
    Utilities: { getUuid: () => randomUUID() },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
    Logger: { log() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx, { filename: 'Code.gs' });

  Object.assign(world, {
    ctx,
    post(body: unknown, now?: number) {
      // 시각을 정해서 부를 때는 doPost 대신 그 안쪽(handle)을 부른다 — 같은 경로다.
      if (now === undefined) return JSON.parse(ctx['doPost']({ postData: { contents: JSON.stringify(body) } }).content);
      return JSON.parse(JSON.stringify(ctx['handle'](JSON.parse(JSON.stringify(body)), now)));
    },
    get(params: Record<string, string>) {
      return ctx['doGet']({ parameter: params });
    },
  });
  return world;
}
