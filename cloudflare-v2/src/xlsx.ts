/**
 * .xlsx 읽기 — 라이브러리 없이.
 *
 * .xlsx 는 ZIP 안에 XML 이 들어 있는 형식이고, Workers 에는 DecompressionStream("deflate-raw")
 * 이 있어서 직접 풀 수 있다. 이 게임의 퀴즈 표는 글자와 작은 정수뿐이라 이 범위로 충분하다.
 *
 * 실제 파일에서 확인한 함정들(sample/보물섬점령전_DB.xlsx, LibreOffice 저장본):
 *  · 시트가 여러 개다. sheet1.xml 이 첫 시트라는 보장이 없으므로 workbook 과 rels 로 찾는다.
 *  · 머리글 "예제1" 이 rich text 로 쪼개져 있다(한글은 Noto, 숫자는 Arial).
 *    <si> 안의 <t> 를 전부 이어 붙이지 않으면 빈 칸으로 읽힌다.
 *  · 빈 셀은 XML 에서 통째로 빠져 있다. r="D5" 의 열 문자로 자리를 맞춰야 열이 안 밀린다.
 *
 * 해석할 수 없는 파일은 조용히 절반만 읽지 않고 거절한다.
 * 조용히 넘어가면 수업 중에 엉뚱한 문제가 나온다 — 가장 나쁜 실패다.
 */

const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_SIG = 0x06054b50;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

function readZipDirectory(view: DataView): Map<string, ZipEntry> {
  // EOCD 는 파일 끝에 있다. 주석이 붙어 있을 수 있어 뒤에서부터 찾는다(주석 최대 64KB).
  const limit = Math.min(view.byteLength, 65_557);
  let eocd = -1;
  for (let i = view.byteLength - 22; i >= view.byteLength - limit && i >= 0; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("엑셀 파일이 아니거나 파일이 깨졌습니다.");

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (offset === 0xffff_ffff) throw new Error("이 엑셀 파일은 너무 큽니다. 문항 수를 줄여 주세요.");

  const decoder = new TextDecoder("utf-8");
  const entries = new Map<string, ZipEntry>();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== CENTRAL_SIG) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(new Uint8Array(view.buffer, view.byteOffset + offset + 46, nameLen));
    entries.set(name, { name, method, compressedSize, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readEntry(view: DataView, entry: ZipEntry): Promise<string> {
  if (view.getUint32(entry.localOffset, true) !== LOCAL_SIG) {
    throw new Error("엑셀 파일이 깨졌습니다.");
  }
  const nameLen = view.getUint16(entry.localOffset + 26, true);
  const extraLen = view.getUint16(entry.localOffset + 28, true);
  const start = entry.localOffset + 30 + nameLen + extraLen;
  const raw = new Uint8Array(view.buffer, view.byteOffset + start, entry.compressedSize);

  if (entry.method === 0) return new TextDecoder("utf-8").decode(raw);
  if (entry.method !== 8) throw new Error("이 엑셀 파일의 압축 방식은 읽지 못합니다.");

  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Response(stream).text();
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXml(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

/** <si> 하나에서 글자를 뽑는다. rich text 로 쪼개진 <r><t> 조각을 전부 이어 붙인다. */
function textOf(si: string): string {
  const body = si.replace(/<rPh[\s\S]*?<\/rPh>/g, ""); // 일본어 후리가나는 버린다
  let out = "";
  for (const m of body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) out += decodeXml(m[1]!);
  return out;
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>|<si\s*\/>/g)) {
    out.push(m[1] === undefined ? "" : textOf(m[1]));
  }
  return out;
}

/** "A" → 0, "Z" → 25, "AA" → 26 */
function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseSheet(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowRef = /\br="(\d+)"/.exec(rm[1] ?? "");
    const rowIdx = rowRef ? Number(rowRef[1]) - 1 : rows.length;
    const cells: string[] = [];

    for (const cm of (rm[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1] ?? "";
      const inner = cm[2] ?? "";
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs);
      const col = ref ? columnIndex(ref[1]!) : cells.length;
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? "n";
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];

      let value = "";
      if (type === "s") value = v === undefined ? "" : (shared[Number(v)] ?? "");
      else if (type === "inlineStr") value = textOf(inner);
      else if (type === "b") value = v === "1" ? "TRUE" : "FALSE";
      else value = v === undefined ? "" : decodeXml(v);

      while (cells.length <= col) cells.push("");
      cells[col] = value;
    }
    while (rows.length < rowIdx) rows.push([]);
    rows[rowIdx] = cells;
  }
  return rows;
}

interface SheetRef {
  name: string;
  hidden: boolean;
  target: string;
}

function parseWorkbook(workbookXml: string, relsXml: string): SheetRef[] {
  const targets = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\b([^>]*)\/>/g)) {
    const attrs = m[1] ?? "";
    const id = /\bId="([^"]+)"/.exec(attrs)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(attrs)?.[1];
    if (id && target) targets.set(id, target.replace(/^\/?xl\//, "").replace(/^\//, ""));
  }

  const sheets: SheetRef[] = [];
  for (const m of workbookXml.matchAll(/<sheet\b([^>]*)\/>/g)) {
    const attrs = m[1] ?? "";
    const name = decodeXml(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? "");
    const rid = /\br:id="([^"]+)"/.exec(attrs)?.[1];
    const state = /\bstate="([^"]+)"/.exec(attrs)?.[1] ?? "visible";
    const target = rid ? targets.get(rid) : undefined;
    if (target) sheets.push({ name, hidden: state !== "visible", target: `xl/${target}` });
  }
  return sheets;
}

/** 읽을 시트 하나를 고른다. '퀴즈' 라는 이름이 있으면 그것, 없으면 맨 앞의 보이는 시트. */
function pickSheet(sheets: SheetRef[]): SheetRef {
  const visible = sheets.filter((s) => !s.hidden);
  const named = visible.find((s) => s.name.trim() === "퀴즈");
  const chosen = named ?? visible[0] ?? sheets[0];
  if (!chosen) throw new Error("엑셀에 시트가 없습니다.");
  return chosen;
}

/** .xlsx 한 개 → 2차원 문자열 배열. 실패하면 이유를 담아 던진다. */
export async function readXlsx(buffer: ArrayBuffer): Promise<string[][]> {
  const view = new DataView(buffer);
  const entries = readZipDirectory(view);

  const workbookEntry = entries.get("xl/workbook.xml");
  const relsEntry = entries.get("xl/_rels/workbook.xml.rels");
  if (!workbookEntry || !relsEntry) throw new Error("엑셀 파일 구조를 읽지 못했습니다.");

  const sheets = parseWorkbook(await readEntry(view, workbookEntry), await readEntry(view, relsEntry));
  const sheet = pickSheet(sheets);

  const sheetEntry = entries.get(sheet.target);
  if (!sheetEntry) throw new Error(`'${sheet.name}' 시트를 읽지 못했습니다.`);

  const sharedEntry = entries.get("xl/sharedStrings.xml");
  const shared = sharedEntry ? parseSharedStrings(await readEntry(view, sharedEntry)) : [];

  return parseSheet(await readEntry(view, sheetEntry), shared);
}
