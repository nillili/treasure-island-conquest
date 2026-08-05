/* 보물섬 점령전 — 목업용 보드 렌더러
   좌표·상태·레이아웃 규칙은 docs/PROJECT_SPEC.md 기준
   ※ 실제 구현이 아니라 화면 확인용 정적 데이터다. */

var ROWS = 12, COLS = 12;

/* ── 2-1 좌표 유틸 (문서와 동일) ───────────────────── */
function columnLabel_(c){
  var s='', n=c+1;
  while(n>0){ var m=(n-1)%26; s=String.fromCharCode(65+m)+s; n=Math.floor((n-1)/26); }
  return s;
}
function rc_(i,cols){ return {r:Math.floor(i/cols), c:i%cols}; }
function idx_(r,c,cols){ return r*cols+c; }
function cellLabel_(i,cols){ var p=rc_(i,cols); return columnLabel_(p.c)+(p.r+1); }

/* ── 게임 중반 스냅샷 (라운드 7, 홍팀 차례) ────────── */
// 홍팀 씨앗 D4(r3,c3) 주변 / 청팀 씨앗 I9(r8,c8) 주변
var OWN_H = [39,27,51,38,40,26,52,15,41,28,50,63];          // 12칸
var OWN_C = [104,92,116,103,105,91,117,80,106,93,115];      // 11칸

var SPECIAL = {
  T:[7,45,74,112,138,70,13,75],                   // 📦 보물 8 (75=D7: 학생 흐름용)
  S:[30,78,98,57,123,4,95],                       // ⛈ 폭풍 7
  A:[22,61,119,33,134,76,55],                     // ⚔ 공격 7
  Q:[9,18,44,53,66,84,88,101,110,127,141,35]      // ? 퀴즈 12
};
var ICON = { T:'\u{1F4E6}', S:'\u26C8\uFE0F', A:'\u{1F4A5}', Q:'?', N:'' };

// 말: [칸, 이름, 팀]
var PAWNS = [
  [39,'홍길동','H'],[27,'김철수','H'],[51,'박민수','H'],[38,'최지우','H'],[40,'강하늘','H'],
  [104,'이영희','C'],[92,'정수빈','C'],[116,'윤서연','C'],[103,'임재현','C'],[105,'오하은','C']
];
// 지금 공략 중인 칸 (관리자 화면에서 반짝임)
var LOCKED = [42,29,64];    // G4=42, F3=29, E6=64(내 옆칸 — 친구가 공략 중)
var ME = 63;                // 학생 화면의 '나' = 박민수 D6 (전선에 있어 빈 칸을 고를 수 있다)

function buildBoard(){
  var b = [];
  for(var i=0;i<ROWS*COLS;i++) b.push({t:'N', o:null});
  for(var k in SPECIAL) SPECIAL[k].forEach(function(i){ b[i].t=k; });
  OWN_H.forEach(function(i){ b[i].o='H'; });
  OWN_C.forEach(function(i){ b[i].o='C'; });
  return b;
}

/** 둘레 8칸 — 상하좌우 + 대각선 (2-6) */
function neighbors8_(pos){
  var p=rc_(pos,COLS), out=[];
  for(var dr=-1;dr<=1;dr++) for(var dc=-1;dc<=1;dc++){
    if(!dr && !dc) continue;
    var r=p.r+dr, c=p.c+dc;
    if(r<0 || r>=ROWS || c<0 || c>=COLS) continue;
    out.push(idx_(r,c,COLS));
  }
  return out;
}

/**
 * @param {string} el       대상 엘리먼트 id
 * @param {Object} opt      {admin:bool, showPick:bool, cellPx:number}
 *   admin=true  → 칸 종류 아이콘 전부 표시 (2-6 maskBoard_의 반대)
 *   admin=false → 미점령 칸은 '?'로 가림
 */
function renderBoard(el, opt){
  opt = opt || {};
  var board = buildBoard();
  var host = document.getElementById(el);
  var px = opt.cellPx || 42;
  host.style.setProperty('--cell', px + 'px');
  host.style.gridTemplateColumns = 'repeat(' + (COLS+1) + ', ' + px + 'px)';
  host.classList.add('board');

  var pawnAt = {};
  PAWNS.forEach(function(p){ (pawnAt[p[0]] = pawnAt[p[0]] || []).push(p); });

  var picks = {};
  if(opt.showPick){
    neighbors8_(ME).forEach(function(i){
      if(LOCKED.indexOf(i) >= 0) return;                  // 잠긴 칸은 고를 수 없다
      picks[i] = board[i].o === 'H' ? 'move' : (board[i].o ? 'enemy' : 'empty');
    });
  }

  var html = '<div class="hdr"></div>';
  for(var c=0;c<COLS;c++) html += '<div class="hdr">'+columnLabel_(c)+'</div>';

  for(var r=0;r<ROWS;r++){
    html += '<div class="hdr">'+(r+1)+'</div>';
    for(var c2=0;c2<COLS;c2++){
      var i = idx_(r,c2,COLS), cell = board[i], cls = ['cell'];
      if(cell.o) cls.push(cell.o);
      if(LOCKED.indexOf(i) >= 0) cls.push(opt.admin ? 'attacking' : 'locked');
      if(picks[i]) cls.push('can', picks[i] === 'empty' ? '' : picks[i]);
      if(!opt.admin && i === ME) cls.push('me');

      // 학생에게는 미점령 칸의 종류를 가린다 (2-6)
      var t = opt.admin ? cell.t : (cell.o ? cell.t : (cell.t === 'N' ? 'N' : 'Q'));
      var ico = opt.admin ? ICON[cell.t] : (cell.o ? ICON[cell.t] : '?');

      html += '<div class="'+cls.join(' ').trim()+'">'
            +   '<span class="lab">'+cellLabel_(i,COLS)+'</span>'
            +   '<span class="ico">'+ico+'</span>';
      if(pawnAt[i]){
        var g = pawnAt[i], t0 = g[0][2].toLowerCase();
        html += '<span class="pawn '+t0+'">'+(g.length>1 ? (g[0][2]==='H'?'홍':'청')+'×'+g.length : g[0][1][0])+'</span>';
      }
      html += '</div>';
    }
  }
  host.innerHTML = html;
}
