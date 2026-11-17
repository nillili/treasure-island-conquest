import { describe, expect, it } from "vitest";
import sampleCsv from "../public/sample-quiz.csv?raw";
import josonCsv from "../../docs/10_퀴즈_조선의_과학_발명품_전시관_미로형식.csv?raw";
import { MAX_ITEMS, parseCsv, parseQuizFile, parseQuizValues } from "../src/quiz";

const HEAD = ["질문", "힌트", "정답", "예제1", "예제2", "예제3", "예제4"];

describe("CSV 읽기", () => {
  it("따옴표 안의 쉼표와 줄바꿈을 지킨다", () => {
    const rows = parseCsv('a,"b,c","d\ne",f\n1,2,3,4\n');
    expect(rows[0]).toEqual(["a", "b,c", "d\ne", "f"]);
    expect(rows[1]).toEqual(["1", "2", "3", "4"]);
    expect(rows).toHaveLength(2);
  });

  it("이중따옴표를 푼다", () => {
    expect(parseCsv('"큰""따옴표",b')[0]).toEqual(['큰"따옴표', "b"]);
  });

  it("BOM 을 떼어 낸다", () => {
    expect(parseCsv("﻿질문,정답")[0]![0]).toBe("질문");
  });

  it("줄바꿈 없이 끝나도 마지막 줄을 읽는다", () => {
    expect(parseCsv("a,b\nc,d")).toHaveLength(2);
  });
});

describe("문항 읽기", () => {
  it("숫자 정답 1 은 0번 보기다", () => {
    const r = parseQuizValues([HEAD, ["질문?", "", "1", "가", "나", "다", "라"]]);
    expect(r.bank).toEqual([{ q: "질문?", options: ["가", "나", "다", "라"], ans: 0 }]);
    expect(r.skipped).toBe(0);
  });

  it("뒤쪽 빈 칸은 잘라 낸다 (3지선다)", () => {
    const r = parseQuizValues([HEAD, ["질문?", "", "3", "가", "나", "다", ""]]);
    expect(r.bank[0]!.options).toEqual(["가", "나", "다"]);
    expect(r.bank[0]!.ans).toBe(2);
  });

  it("보기 중간이 비면 그 행을 건너뛰고 행 번호를 알린다", () => {
    const r = parseQuizValues([HEAD, ["질문?", "", "1", "가", "", "다", "라"]]);
    expect(r.bank).toHaveLength(0);
    expect(r.skipped).toBe(1);
    expect(r.problems[0]).toContain("2행");
    expect(r.problems[0]).toContain("중간이 비었");
  });

  it("보기보다 큰 번호를 정답으로 적으면 건너뛴다", () => {
    const r = parseQuizValues([HEAD, ["질문?", "", "4", "가", "나", "다", ""]]);
    expect(r.bank).toHaveLength(0);
    expect(r.problems[0]).toContain("2행");
    expect(r.problems[0]).toContain("4번");
  });

  it("보기가 2개 미만이면 건너뛴다", () => {
    const r = parseQuizValues([HEAD, ["질문?", "", "1", "가", "", "", ""]]);
    expect(r.bank).toHaveLength(0);
    expect(r.problems[0]).toContain("2개 미만");
  });

  it("질문이나 정답 칸이 비면 건너뛴다", () => {
    const r = parseQuizValues([
      HEAD,
      ["", "", "1", "가", "나", "", ""],
      ["질문?", "", "", "가", "나", "", ""],
    ]);
    expect(r.skipped).toBe(2);
    expect(r.problems[0]).toContain("질문 칸이 비었");
    expect(r.problems[1]).toContain("정답 칸이 비었");
  });

  it("완전히 빈 줄은 조용히 넘긴다", () => {
    const r = parseQuizValues([HEAD, ["", "", "", "", "", "", ""], ["질문?", "", "1", "가", "나", "", ""]]);
    expect(r.bank).toHaveLength(1);
    expect(r.skipped).toBe(0);
  });

  it("글자로 적은 정답도 받아 준다", () => {
    const r = parseQuizValues([HEAD, ["질문?", "", "나", "가", "나", "다", "라"]]);
    expect(r.bank[0]!.ans).toBe(1);
  });

  it("보기에 없는 글자를 정답으로 적으면 번호로 적으라고 알린다", () => {
    const r = parseQuizValues([HEAD, ["질문?", "", "마", "가", "나", "다", "라"]]);
    expect(r.bank).toHaveLength(0);
    expect(r.problems[0]).toContain("번호(1~4)");
  });

  it("80문항을 넘으면 나머지는 건너뛴다", () => {
    const rows = [HEAD, ...Array.from({ length: 100 }, (_, i) => [`Q${i}`, "", "1", "가", "나", "", ""])];
    const r = parseQuizValues(rows);
    expect(MAX_ITEMS).toBe(80);
    expect(r.bank).toHaveLength(80);
    expect(r.skipped).toBe(20);
    expect(r.problems.some((p) => p.includes("80개만"))).toBe(true);
  });

  it("안내는 20건까지만 모은다", () => {
    const rows = [HEAD, ...Array.from({ length: 40 }, () => ["질문?", "", "1", "가", "", "다", ""])];
    expect(parseQuizValues(rows).problems).toHaveLength(20);
  });
});

describe("새 형식 — 힌트 · 머리글", () => {
  it("힌트가 있으면 담고, 없으면 hint 를 넣지 않는다", () => {
    const r = parseQuizValues([
      HEAD,
      ["질문1?", "도움말", "2", "가", "나", "", ""],
      ["질문2?", "", "1", "가", "나", "", ""],
    ]);
    expect(r.bank[0]).toEqual({ q: "질문1?", hint: "도움말", options: ["가", "나"], ans: 1 });
    expect(r.bank[1]).toEqual({ q: "질문2?", options: ["가", "나"], ans: 0 });
  });

  it("머리글이 없으면 첫 줄부터 문항으로 읽는다", () => {
    const r = parseQuizValues([
      ["질문1?", "도움말", "1", "가", "나", "다", "라"],
      ["질문2?", "", "4", "가", "나", "다", "라"],
    ]);
    expect(r.bank).toHaveLength(2);
    expect(r.bank[0]!.q).toBe("질문1?");
  });

  it("옛 형식 머리글(질문,정답,…)이면 받지 않는다", () => {
    const r = parseQuizValues([["질문", "정답", "예제1", "예제2"], ["질문?", "1", "가", "나"]]);
    expect(r.bank).toHaveLength(0);
    expect(r.problems[0]).toContain("옛 형식");
  });

  it("머리글 없는 옛 형식 줄도 알아보고 알린다", () => {
    const r = parseQuizValues([["질문?", "1", "가", "나", "다", "라"]]);
    expect(r.bank).toHaveLength(0);
    expect(r.problems[0]).toContain("1행");
    expect(r.problems[0]).toContain("옛 형식");
  });

  it("보내 주신 조선 발명품 파일(머리글 없음) 58문항이 모두 힌트와 함께 읽힌다", () => {
    const r = parseQuizValues(parseCsv(josonCsv));
    expect(r.problems).toEqual([]);
    expect(r.bank).toHaveLength(58);
    expect(r.bank.every((it) => !!it.hint)).toBe(true);
    expect(r.bank[0]!.q).toBe("오늘 수업의 순서는 무엇인가요?");
    expect(r.bank[0]!.ans).toBe(1);
  });
});

describe("실제 샘플 파일", () => {
  it("sample-quiz.csv 50문항이 하나도 안 빠지고 읽힌다", () => {
    const r = parseQuizValues(parseCsv(sampleCsv));
    expect(r.bank).toHaveLength(50);
    expect(r.skipped).toBe(0);
    expect(r.problems).toEqual([]);
  });

  it("모두 4지선다이고 정답 번호가 범위 안이다", () => {
    const r = parseQuizValues(parseCsv(sampleCsv));
    for (const item of r.bank) {
      expect(item.options).toHaveLength(4);
      expect(item.ans).toBeGreaterThanOrEqual(0);
      expect(item.ans).toBeLessThan(4);
      expect(item.q.length).toBeGreaterThan(0);
    }
  });

  it("첫 문항이 그대로 들어온다", () => {
    const r = parseQuizValues(parseCsv(sampleCsv));
    expect(r.bank[0]).toEqual({
      q: "고조선을 세운 인물은 누구인가요?",
      hint: "우리 민족 최초의 나라를 세운 분으로, 곰이 사람이 된 이야기에 나와요.",
      options: ["단군왕검", "온조", "박혁거세", "주몽"],
      ans: 0,
    });
  });
});

describe("파일 판별", () => {
  it("CSV 파일을 읽는다", async () => {
    const file = new File([sampleCsv], "퀴즈.csv", { type: "text/csv" });
    const r = await parseQuizFile(file);
    expect(r.bank).toHaveLength(50);
  });
});
