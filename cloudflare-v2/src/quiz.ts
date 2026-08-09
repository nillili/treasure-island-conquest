/**
 * 퀴즈 파일 읽기 — apps-script/Backend.gs:687 parseQuizValues_ 를 그대로 옮겼다.
 *
 * 표 한 줄 = 문항 하나.  A:질문 · B:정답 · C~F:예제1~예제4
 * 정답은 번호로 쓴다. 1 = 예제1 … 4 = 예제4.
 * (예전에는 정답 칸에 보기 '내용'을 적어도 받아 줬다. 그 방식은 보기 문구만 고치고
 *  정답 칸을 안 고치면 조용히 어긋난다. 번호는 그럴 일이 없다.
 *  옛 파일을 그대로 쓸 수 있게 글자 정답도 계속 받되, 문제가 있는 줄은 이유를 남긴다.)
 */

import { readXlsx } from "./xlsx";

export interface QuizItem {
  q: string;
  options: string[];
  ans: number; // 0-based
}

export interface ParseResult {
  bank: QuizItem[];
  skipped: number;
  problems: string[];
}

/** 한 퀴즈에 담는 문항 상한. 넘는 줄은 읽지 않고 건너뛴다. */
export const MAX_ITEMS = 80;

export function parseQuizValues(values: string[][]): ParseResult {
  const bank: QuizItem[] = [];
  const problems: string[] = [];
  let skipped = 0;

  for (let r = 1; r < values.length; r++) {
    const row = values[r] ?? [];
    const q = String(row[0] ?? "").trim();
    const raw = String(row[1] ?? "").trim();
    if (!q && !raw) continue; // 완전히 빈 줄은 조용히 넘긴다

    const line = r + 1; // 표에 보이는 행 번호
    if (!q || !raw) {
      skipped++;
      problems.push(`${line}행: ${q ? "정답" : "질문"} 칸이 비었습니다.`);
      continue;
    }

    // 빈 칸은 '뒤쪽만' 잘라 낸다. 가운데를 지우면 번호가 밀려 3번이 4번을 가리키게 된다.
    const opts = row.slice(2, 6).map((x) => String(x ?? "").trim());
    while (opts.length && opts[opts.length - 1] === "") opts.pop();
    if (opts.length < 2) {
      skipped++;
      problems.push(`${line}행: 보기가 2개 미만입니다.`);
      continue;
    }
    if (opts.indexOf("") >= 0) {
      skipped++;
      problems.push(`${line}행: 보기 중간이 비었습니다. 앞에서부터 채워 주세요.`);
      continue;
    }

    let ans = -1;
    if (/^[1-9][0-9]*$/.test(raw)) {
      const num = Number(raw);
      if (num >= 1 && num <= opts.length) {
        ans = num - 1;
      } else {
        skipped++;
        problems.push(`${line}행: 정답이 ${num}번인데 보기는 ${opts.length}개뿐입니다.`);
        continue;
      }
    } else {
      const needle = raw.toLocaleLowerCase();
      for (let i = 0; i < opts.length; i++) {
        if (opts[i]!.toLocaleLowerCase() === needle) {
          ans = i;
          break;
        }
      }
      if (ans < 0) {
        skipped++;
        problems.push(
          `${line}행: 정답 '${raw}' 이 보기 안에 없습니다. 정답 칸에 번호(1~${opts.length})를 적어 주세요.`,
        );
        continue;
      }
    }
    bank.push({ q, options: opts, ans });
  }

  if (bank.length > MAX_ITEMS) {
    const dropped = bank.length - MAX_ITEMS;
    problems.push(`문항이 ${bank.length}개입니다. 앞에서부터 ${MAX_ITEMS}개만 쓰고 ${dropped}개는 건너뜁니다.`);
    skipped += dropped;
    bank.length = MAX_ITEMS;
  }
  return { bank, skipped, problems: problems.slice(0, 20) };
}

/** CSV 한 덩어리 → 2차원 배열. 따옴표 안의 쉼표·줄바꿈·이중따옴표를 지킨다. */
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 엑셀이 붙이는 BOM
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch !== '"') {
        field += ch;
      } else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = false;
      }
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * 올라온 파일 한 개 → 문제은행.
 * ZIP 시그니처(PK)로 시작하면 .xlsx 다. CSV 는 그대로 읽는다.
 */
export async function parseQuizFile(file: File): Promise<ParseResult> {
  const buf = await file.arrayBuffer();
  const head = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  if (head[0] === 0x50 && head[1] === 0x4b) {
    try {
      return parseQuizValues(await readXlsx(buf));
    } catch (err) {
      // 못 읽는 엑셀은 조용히 넘기지 않고 빠져나갈 길을 알려 준다.
      const why = err instanceof Error ? err.message : "알 수 없는 이유";
      throw new Error(`${why} 엑셀에서 [다른 이름으로 저장 → CSV]로 저장한 뒤 올려 주세요.`);
    }
  }
  return parseQuizValues(parseCsv(new TextDecoder("utf-8").decode(buf)));
}
