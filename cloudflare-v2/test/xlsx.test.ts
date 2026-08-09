import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import sampleCsv from "../../sample/퀴즈_샘플_v3.csv?raw";
import { parseCsv, parseQuizFile, parseQuizValues } from "../src/quiz";
import { readXlsx } from "../src/xlsx";

function bytesOf(base64: string): ArrayBuffer {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

const sample = () => bytesOf(env.FIXTURE_XLSX);
const multisheet = () => bytesOf(env.FIXTURE_MULTISHEET);

describe("엑셀 읽기 — 골든 기준", () => {
  it("표가 CSV 와 한 칸도 다르지 않다", async () => {
    const fromXlsx = await readXlsx(sample());
    const fromCsv = parseCsv(sampleCsv);
    expect(fromXlsx).toHaveLength(fromCsv.length);
    for (let r = 0; r < fromCsv.length; r++) {
      expect(fromXlsx[r]!.map((s) => s.trim())).toEqual(fromCsv[r]!.map((s) => s.trim()));
    }
  });

  it("문항으로 읽어도 CSV 와 완전히 같다", async () => {
    const fromXlsx = parseQuizValues(await readXlsx(sample()));
    const fromCsv = parseQuizValues(parseCsv(sampleCsv));
    expect(fromXlsx).toEqual(fromCsv);
    expect(fromXlsx.bank).toHaveLength(50);
    expect(fromXlsx.skipped).toBe(0);
  });

  it("rich text 로 쪼개진 머리글을 이어 붙인다", async () => {
    // '예제1' 은 한글(Noto)과 숫자(Arial)가 다른 조각으로 저장돼 있다.
    // <si> 안의 <t> 를 전부 이어 붙이지 않으면 빈 칸이 된다.
    const rows = await readXlsx(sample());
    expect(rows[0]).toEqual(["질문", "정답", "예제1", "예제2", "예제3", "예제4"]);
  });

  it("숫자 정답이 문자열 그대로 나온다", async () => {
    const rows = await readXlsx(sample());
    expect(rows[1]![1]).toBe("1");
    expect(rows[50]![1]).toBe("4");
  });
});

describe("시트 고르기", () => {
  it("숨긴 탭이 섞여 있어도 '퀴즈' 시트를 읽는다", async () => {
    // 정리 전 원본에는 퀴즈 · _상태 · _퀴즈스냅샷 세 시트가 있었다.
    const rows = await readXlsx(multisheet());
    expect(rows[0]).toEqual(["질문", "정답", "예제1", "예제2", "예제3", "예제4"]);
    expect(rows).toHaveLength(51);
  });

  it("정리 전 파일과 정리 후 파일이 같은 결과를 낸다", async () => {
    expect(await readXlsx(multisheet())).toEqual(await readXlsx(sample()));
  });
});

describe("업로드 경로", () => {
  it("엑셀 파일을 그대로 올려도 읽힌다", async () => {
    const file = new File([sample()], "보물섬점령전_DB.xlsx");
    const r = await parseQuizFile(file);
    expect(r.bank).toHaveLength(50);
    expect(r.skipped).toBe(0);
  });

  it("엑셀인 척하는 깨진 파일은 CSV 로 저장하라고 알려 준다", async () => {
    const broken = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8]);
    const file = new File([broken], "깨진.xlsx");
    await expect(parseQuizFile(file)).rejects.toThrow("CSV");
  });
});
