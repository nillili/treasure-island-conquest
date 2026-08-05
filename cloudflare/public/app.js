"use strict";
const APP={role:null,playerId:null,token:null,state:null,rev:-1,myQuizzes:{},mode:"waiting",pollTimer:null,currentCell:null,pickPromise:null,peek:null,loginRole:null,quizCount:0};
// Backend.gs 의 BACKEND_VERSION 과 같아야 한다. 다르면 [시스템 점검]이 배포 어긋남을 잡아낸다.
const APP_VERSION=18;
const ICON={N:"",Q:"",T:"📦",S:"⛈️",A:"💥"};
const $=id=>document.getElementById(id);
const escapeHtml=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);

// 20초 안에 답이 없으면 스스로 끊는다. 응답이 영영 안 오면 버튼이 disabled 인 채로 굳어
// 교사가 할 수 있는 일이 없어진다 — 2026-08-05 시연에서 그렇게 됐다.
async function call(action,payload={}){const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),20000);let response;try{response=await fetch(`/api/${encodeURIComponent(action)}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload),signal:ctrl.signal})}catch(error){throw new Error(error?.name==="AbortError"?"서버가 20초 안에 답하지 않았습니다.":"서버에 연결하지 못했습니다.")}finally{clearTimeout(timer)}const result=await response.json().catch(()=>null);if(!response.ok||result?.ok===false)throw new Error(result?.error||"요청에 실패했습니다.");return result}
// 서버가 잠깐 밀린 것뿐이면 사람이 다시 누르기 전에 스스로 재시도한다.
function isTransient(message){return ["연결할 수 없습니다","연결하지 못했습니다","혼잡","불안정","20초 안에"].some(k=>String(message).includes(k))}
async function callWithRetry(action,payload,tries=2){let last;for(let i=0;i<=tries;i++){try{return await call(action,payload)}catch(error){last=error;if(!isTransient(error.message))throw error;if(i<tries)await new Promise(r=>setTimeout(r,700*(i+1)))}}throw last}
function toast(message){const el=$("toast");el.textContent=message;el.classList.add("show");clearTimeout(el.timer);el.timer=setTimeout(()=>el.classList.remove("show"),3000)}
function closeModal(id){$(id).classList.add("hidden")}
function showScreen(id){$("entry").classList.add("hidden");$("student-screen").classList.add("hidden");$("admin-screen").classList.add("hidden");$(id).classList.remove("hidden")}
function openLogin(role){APP.loginRole=role;$("login-title").textContent=role==="student"?"학생 이름":"관리자 비밀번호";$("login-input").type=role==="student"?"text":"password";$("login-input").value="";$("login-modal").classList.remove("hidden");$("login-input").focus()}

async function loginStudent(name){try{const saved=localStorage.getItem("treasure-player-id")||"";const r=await call("joinAsStudent",{name,playerId:saved});APP.role="student";APP.playerId=r.playerId;APP.myQuizzes=r.allQuizzes||{};APP.gameId=null;localStorage.setItem("treasure-player-id",r.playerId);localStorage.setItem("treasure-player-name",name);showScreen("student-screen");forcePoll(!Object.keys(APP.myQuizzes).length)}catch(error){toast(error.message)}}
// 서버에서 내 말이 사라졌을 때 저장해 둔 이름으로 조용히 다시 들어간다.
// 30명 앞에서 "다시 입장해 주세요"가 뜨고 이름을 다시 치게 하면 수업이 멈춘다.
// 새 게임이 열리면 이 게임의 칸↔문제 배정표를 새로 받아 온다.
// joinAsStudent 는 이미 들어와 있는 학생이면 잠금 없이 배정표만 돌려주므로 가볍다.
async function refreshQuizBank(){
  try{const r=await call("joinAsStudent",{playerId:APP.playerId,name:localStorage.getItem("treasure-player-name")||""});
    APP.myQuizzes=r.allQuizzes||{};APP.playerId=r.playerId;localStorage.setItem("treasure-player-id",r.playerId)}
  catch(error){APP.myQuizzes={}}
}
async function rejoinStudent(){const name=localStorage.getItem("treasure-player-name")||"";if(!name)return false;try{const r=await call("joinAsStudent",{name});APP.playerId=r.playerId;APP.rev=-1;APP.myQuizzes=r.allQuizzes||{};APP.mode="waiting";localStorage.setItem("treasure-player-id",r.playerId);toast("연결이 끊겨 자동으로 다시 들어왔어요.");schedulePoll(true);return true}catch{return false}}
async function loginAdmin(pw){try{const r=await call("loginAsAdmin",{pw});APP.role="admin";APP.token=r.token;showScreen("admin-screen");forcePoll(false)}catch(error){toast(error.message)}}
function leaveApp(){clearTimeout(APP.pollTimer);Object.assign(APP,{role:null,playerId:null,token:null,state:null,rev:-1,myQuizzes:{},mode:"waiting"});$("student-screen").classList.add("hidden");$("admin-screen").classList.add("hidden");$("entry").classList.remove("hidden")}

function forcePoll(need){clearTimeout(APP.pollTimer);void pollState(Boolean(need))}
async function pollState(need){
  if(!APP.role)return;if(document.hidden){APP.pollTimer=setTimeout(()=>pollState(need),2000);return}
  try{const arg={rev:APP.rev,needQuizzes:Boolean(need)};if(APP.role==="student")arg.playerId=APP.playerId;else arg.token=APP.token;const r=await call("getState",arg);if(APP.role==="student"&&r.gameId){if(APP.gameId&&r.gameId!==APP.gameId){APP.myQuizzes={};APP.mode="waiting";hideQuiz();void refreshQuizBank()}APP.gameId=r.gameId}if(r.myQuizzes&&!Object.keys(APP.myQuizzes).length)APP.myQuizzes=r.myQuizzes;if(!r.nochange){const changed=APP.state&&(APP.state.turnTeam!==r.turnTeam||APP.state.round!==r.round);APP.state=r;APP.rev=r.rev;if(changed&&APP.mode!=="solving")APP.mode="waiting"}else{APP.rev=r.rev;if(APP.state){APP.state.turnEndsAt=r.endsAt;if(r.presence)APP.state.presence=r.presence;if(r.iAmSkipping!==undefined)APP.state.iAmSkipping=r.iAmSkipping}}if(APP.role==="student")renderStudent();else renderAdmin();const wants=APP.role==="student"&&!Object.keys(APP.myQuizzes).length&&APP.mode!=="solving";APP.failStreak=0;schedulePoll(wants)}catch(error){
    const msg=error.message||"";
    // 선생님이 일부러 초기화한 것이면 자동 복구하지 않고 입장 화면으로 돌려보낸다.
    if(APP.role==="student"&&msg.includes("초기화했어요")){localStorage.removeItem("treasure-player-id");localStorage.removeItem("treasure-player-name");leaveApp();toast("선생님이 게임을 초기화했어요. 이름을 다시 입력해 주세요.");return}
    if(APP.role==="student"&&msg.includes("다시 입장")){if(await rejoinStudent())return;localStorage.removeItem("treasure-player-id");leaveApp();toast("다시 입장해 주세요.");return}
    // 서버가 밀리거나(혼잡·불안정) 프록시가 끊긴 것은 곧 풀린다. 조용히 계속 두드린다.
    const transient=msg.includes("연결할 수 없습니다")||msg.includes("혼잡")||msg.includes("불안정")||msg.includes("failed");
    APP.failStreak=(APP.failStreak||0)+1;
    if(!transient||APP.failStreak===3)toast(transient?"서버가 잠시 밀리고 있어요. 다시 연결하는 중…":msg);
    schedulePoll(false)}
}
function schedulePoll(need){clearTimeout(APP.pollTimer);if(!APP.role)return;const ms=APP.role==="admin"?2000:(APP.mode==="solving"?0:(APP.state?.turnTeam===myTeam()?3000:6000));if(ms)APP.pollTimer=setTimeout(()=>pollState(need),ms)}
function myTeam(){return APP.state?.myPlayer?.team||null}
function canPlay(){return Boolean(APP.state&&APP.state.status==="running"&&APP.state.turnTeam===myTeam()&&!APP.state.iAmSkipping&&!APP.state.myPlayer?.playedThisTurn&&Date.now()<APP.state.turnEndsAt)}
function formatTime(ms){const s=Math.ceil(ms/1000);return `${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`}
function updateTimers(){if(!APP.state)return;const left=Math.max(0,(APP.state.turnEndsAt||0)-Date.now()),text=formatTime(left);$("s-timer").textContent=text;$("a-timer").textContent=text;if(APP.role==="student"&&left===0&&APP.mode==="solving"){APP.mode="waiting";hideQuiz();toast("시간이 끝났어요. 상대 팀 차례로 넘어갑니다.");forcePoll(false)}}

function colLabel(c){let s="",n=c+1;while(n>0){const m=(n-1)%26;s=String.fromCharCode(65+m)+s;n=Math.floor((n-1)/26)}return s}
function cellLabel(i,cols){return colLabel(i%cols)+(Math.floor(i/cols)+1)}
// 둘레 8칸(대각선 포함). 서버 neighbors8_ 과 같은 규칙이어야 반짝이는 칸과 실제 선택 가능 칸이 맞는다.
function neighbors(i,rows,cols){const r=Math.floor(i/cols),c=i%cols,out=[];for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){if(!dr&&!dc)continue;const y=r+dr,x=c+dc;if(y<0||y>=rows||x<0||x>=cols)continue;out.push(y*cols+x)}return out}
function renderBoard(hostId,admin){const st=APP.state;if(!st?.board)return;const host=$(hostId),px=Math.max(23,Math.min(admin?45:42,Math.floor((innerWidth-(admin?330:300))/(st.cols+1))));host.className="board";host.style.setProperty("--cell",`${px}px`);host.style.gridTemplateColumns=`repeat(${st.cols+1},${px}px)`;const pawns={};Object.entries(st.players||{}).forEach(([id,p])=>{if(p.pos!==null)(pawns[p.pos]??=[]).push({id,p})});const candidates={};if(!admin&&st.myPlayer&&canPlay())neighbors(st.myPlayer.pos,st.rows,st.cols).forEach(i=>{if(st.cellLocks?.[i])return;candidates[i]=st.board[i].o===st.myPlayer.team?"move":(st.board[i].o?"enemy":"can")});let html='<div class="axis"></div>';for(let c=0;c<st.cols;c++)html+=`<div class="axis">${colLabel(c)}</div>`;for(let r=0;r<st.rows;r++){html+=`<div class="axis">${r+1}</div>`;for(let c=0;c<st.cols;c++){const i=r*st.cols+c,cell=st.board[i],classes=["cell"];if(cell.o)classes.push(cell.o);if(st.cellLocks?.[i])classes.push(admin?"attacking":"locked");if(candidates[i])classes.push("can",candidates[i]);if(!admin&&st.myPlayer?.pos===i)classes.push("me");const icon=cell.o?(ICON[cell.t]||""):"?",owner=cell.o?(cell.o==="H"?"홍팀":"청팀"):"미점령";html+=`<button class="${classes.join(" ")}" data-cell="${i}" aria-label="${cellLabel(i,st.cols)} ${owner}"><span class="coord">${cellLabel(i,st.cols)}</span><span>${icon}</span>`;if(pawns[i]){const group=pawns[i],team=group[0].p.team;html+=`<span class="pawn">${group.length>1?(team==="H"?"홍":"청")+"×"+group.length:escapeHtml(group[0].p.name.charAt(0))}</span>`}html+="</button>"}}host.innerHTML=html}

function renderStudent(){const st=APP.state;if(!st?.myPlayer)return;const p=st.myPlayer;$("student-team").className=`tag ${p.team}`;$("student-team").textContent=p.team==="H"?"홍팀":"청팀";$("student-name").textContent=p.name;$("student-stats").textContent=`내 위치 ${cellLabel(p.pos,st.cols)} · 정답 ${p.correct}/${p.solved}`;$("s-score-h").textContent=st.scores.H.total;$("s-score-c").textContent=st.scores.C.total;renderBoard("student-board",false);if(APP.mode==="solving"||APP.mode==="result")return;const msg=$("student-message");if(st.status==="ended")msg.innerHTML="<b>게임이 종료되었습니다.</b>";else if(st.iAmSkipping)msg.innerHTML="<b>⛈️ 폭풍에 갇혔어요! 이번 턴은 쉽니다.</b>";else if(p.playedThisTurn)msg.innerHTML="<b>이번 턴의 문제를 풀었습니다.</b><br><small>상대 팀 턴이 끝날 때까지 기다려 주세요.</small>";else if(!canPlay())msg.innerHTML="<b>선생님이 우리 팀 턴을 시작할 때까지 기다려 주세요.</b>";else{APP.mode="select";msg.innerHTML="<b>🎯 어디를 공략할까?</b><br><small>내 말의 위·아래·왼쪽·오른쪽 칸을 고르세요.</small>"}}
// 문제 카드를 그린다. 출처는 언제나 하나여야 한다 — 채점하는 쪽(서버)이 준 문제.
function renderQuiz(cell,item){
  $("quiz-cell").textContent=cellLabel(cell,APP.state.cols);
  $("quiz-question").textContent=item.q;
  $("quiz-options").innerHTML=item.options.map((x,i)=>`<button class="option" data-choice="${i}"><b>${i+1}</b>${escapeHtml(x)}</button>`).join("");
}
function selectCell(cell){
  if(!canPlay()||APP.mode==="solving")return;
  if(APP.state.board[cell].o===myTeam()){void call("pickCell",{playerId:APP.playerId,cell}).then(()=>forcePoll(false)).catch(error=>toast(error.message));return}
  const item=APP.myQuizzes[cell];
  if(!item){toast("문제를 준비하는 중입니다.");forcePoll(true);return}
  APP.currentCell=cell;APP.mode="solving";
  $("student-message").classList.add("hidden");$("result-card").classList.add("hidden");$("quiz-card").classList.remove("hidden");
  renderQuiz(cell,item);                       // 미리 받아 둔 사본으로 먼저 띄운다(빠르게 보이도록)
  APP.pickPromise=call("pickCell",{playerId:APP.playerId,cell})
    .then(r=>{
      // 서버가 채점에 쓸 문제를 함께 보내 준다. 사본과 다르면 서버 것으로 다시 그린다.
      // 학생이 고르는 보기와 채점 기준이 절대 어긋나지 않게 하는 마지막 안전장치다.
      if(r&&r.quiz&&APP.mode==="solving"&&APP.currentCell===cell){
        const changed=r.quiz.q!==item.q||r.quiz.options.join("|")!==item.options.join("|");
        if(changed){renderQuiz(cell,r.quiz);APP.myQuizzes[cell]=r.quiz}
      }
      return r})
    .catch(error=>{APP.mode="select";hideQuiz();toast(error.message);throw error})
}
async function submitChoice(choice){try{await APP.pickPromise;const r=await call("submitAnswer",{playerId:APP.playerId,cell:APP.currentCell,choice});APP.mode="result";hideQuiz();$("result-card").classList.remove("hidden");$("result-big").className=`big ${r.correct?"ok":"no"}`;$("result-big").textContent=r.correct?"정답!":"아쉬워요";$("result-message").textContent=r.correct&&r.bonusSkipped?"정답입니다. 이 칸의 보너스는 이미 받았어요.":`정답은 ${r.answerText}입니다.`;$("result-gain").textContent=r.correct?`+${r.gain}점`:"점령 실패";setTimeout(()=>{APP.mode="waiting";$("result-card").classList.add("hidden");$("student-message").classList.remove("hidden");forcePoll(false)},3000)}catch(error){toast(error.message)}}
function hideQuiz(){$("quiz-card").classList.add("hidden")}
async function cancelQuiz(){try{await call("cancelPick",{playerId:APP.playerId})}catch{}APP.mode="waiting";hideQuiz();$("student-message").classList.remove("hidden");forcePoll(false)}

function renderAdmin(){const st=APP.state;if(!st)return;renderBoard("admin-board",true);$("a-score-h").textContent=st.scores.H.total;$("a-score-c").textContent=st.scores.C.total;$("a-sub-h").textContent=`영토 ${st.scores.H.territory} + 보너스 ${st.scores.H.bonus}`;$("a-sub-c").textContent=`영토 ${st.scores.C.territory} + 보너스 ${st.scores.C.bonus}`;$("a-round").textContent=`${st.round} / ${st.roundLimit}`;$("a-turn").textContent=st.status==="ended"?"종료":(st.turnTeam?(st.turnTeam==="H"?"홍팀":"청팀"):"대기");applyTurnButton(st);const online=new Set(st.presence||[]);$("online-count").textContent=`접속 ${online.size}명`;$("roster").innerHTML=Object.entries(st.players||{}).map(([id,p])=>{const solving=Object.values(st.cellLocks||{}).some(lock=>lock.by===id);return `<span class="person ${online.has(id)?"":"off"} ${solving?"solving":""}">${p.team==="H"?"🔴":"🟢"} ${escapeHtml(p.name)}${solving?" ●":""}<button class="kick" data-kick="${id}" title="${escapeHtml(p.name)} 내보내기">×</button></span>`}).join("")}
// ── [시작] 버튼 ──────────────────────────────────────────────────────────────
// 이 버튼은 어떤 경우에도 비활성화되지 않는다. 눌리지 않는 버튼 앞에서 교사가 할 수 있는 일이
// 없기 때문이다(2026-08-05 시연: 게임이 ended 라는 이유로 버튼이 죽어 한 판도 못 했다).
// 대신 지금 누르면 무슨 일이 일어나는지를 라벨과 안내문으로 항상 알려 준다.
function adminTurnMode(st){if(!st||!st.board||!st.board.length)return"new";if(st.status==="ended")return"new";if(!st.turnTeam)return"start";return"next"}
const TURN_LABEL={new:"🆕 새 게임 만들기",start:"▶ 시작",next:"다음 턴"};
const TURN_HINT={new:"지난 게임이 끝난 상태입니다. 누르면 새 판을 깔고 학생 말을 다시 놓습니다. 학생은 다시 입장하지 않아도 됩니다.",start:"학생이 다 들어왔으면 누르세요. 홍팀부터 첫 턴이 열립니다.",next:""};
function setTurnHint(text,bad){const el=$("admin-state-hint");if(!el)return;el.textContent=text||"";el.className=`board-help${bad?" hot":""}`}
function applyTurnButton(st){const button=$("turn-button");if(!button)return;const mode=adminTurnMode(st);button.disabled=false;button.textContent=TURN_LABEL[mode];if(!button.dataset.busy)setTurnHint(TURN_HINT[mode])}

async function nextTurn(){
  const button=$("turn-button");
  if(adminTurnMode(APP.state)==="new")return void newGame();
  button.disabled=true;button.dataset.busy="1";setTurnHint("서버에 요청하는 중…");
  try{
    const r=await callWithRetry("adminNextTurn",{token:APP.token});
    if(APP.state&&r.turnTeam){APP.state.turnTeam=r.turnTeam;APP.state.round=r.round;APP.state.turnEndsAt=r.turnEndsAt;$("a-round").textContent=`${r.round} / ${APP.state.roundLimit}`;$("a-turn").textContent=r.turnTeam==="H"?"홍팀":"청팀";$("a-timer").textContent=formatTime(Math.max(0,r.turnEndsAt-Date.now()))}
    setTurnHint("");toast(r.turnTeam?`${r.turnTeam==="H"?"홍팀":"청팀"} 차례로 전환했습니다.`:"게임이 종료되었습니다.");forcePoll(false)
  }catch(error){explainTurnFailure(error)}
  finally{delete button.dataset.busy;button.disabled=false;applyTurnButton(APP.state)}   // 무슨 일이 있어도 되살린다
}

/** 실패했을 때 "무엇이 잘못됐고 지금 무엇을 누르면 되는지"까지 말해 준다. */
function explainTurnFailure(error){
  const msg=error.message||"";
  if(msg.includes("종료된 게임")||msg.includes("새 게임을 먼저")){
    APP.rev=-1;forcePoll(false);
    setTurnHint("이 게임은 이미 끝나 있었습니다. 버튼이 [🆕 새 게임 만들기]로 바뀝니다 — 한 번 더 눌러 주세요.",true);
    return}
  if(msg.includes("관리자 인증")){
    setTurnHint("관리자 로그인이 풀렸습니다. [나가기]를 누르고 비밀번호로 다시 들어와 주세요.",true);toast(msg);return}
  if(isTransient(msg)){
    setTurnHint("서버가 잠시 밀리고 있습니다(자동으로 3번 다시 시도했습니다). 몇 초 뒤 한 번 더 눌러 주세요. 계속되면 [🩺 시스템 점검]을 눌러 주세요.",true);
    toast("서버 응답이 늦습니다. 다시 눌러 주세요.");return}
  setTurnHint(`시작하지 못했습니다 — ${msg} · [🩺 시스템 점검]으로 원인을 확인해 주세요.`,true);toast(msg);
}
// 새 게임·종료는 서버 호출 '한 번'이어야 한다.
// 예전에는 여기서 학생을 한 명씩 adminKick 한 뒤 새 게임을 만들었는데,
// 15명이면 강퇴만 20초가 넘게 걸리고(2026-08-05 로그: 13:30:12~34) 그동안 학생이 전부 튕겼다.
// 서버의 adminNewGame 이 이미 명단을 유지한 채 위치·점수만 초기화한다.
async function newGame(){
  // 이미 끝난 게임에서는 잃을 것이 없으므로 확인을 묻지 않는다. 한 번의 클릭으로 되살아나야 한다.
  const ended=adminTurnMode(APP.state)==="new";
  if(!ended&&!confirm("새 게임을 시작합니다. 점수와 점령한 칸이 초기화되고 학생들의 말이 새로 배치됩니다.\n학생들은 다시 입장하지 않아도 됩니다. 계속할까요?"))return;
  const button=$("new-game-button"),turn=$("turn-button");
  button.disabled=true;turn.dataset.busy="1";setTurnHint("새 판을 만드는 중… (몇 초 걸립니다)");
  try{
    const r=await callWithRetry("adminNewGame",{token:APP.token});
    if(r.warning){$("admin-warning").textContent=r.warning;$("admin-warning").classList.remove("hidden")}else $("admin-warning").classList.add("hidden");
    APP.rev=-1;delete turn.dataset.busy;setTurnHint(TURN_HINT.start);
    toast(`새 게임을 만들었습니다. 학생 ${r.playerCount}명이 그대로 참여합니다.`);forcePoll(false)
  }catch(error){
    delete turn.dataset.busy;
    const msg=error.message||"";
    if(msg.includes("문항"))setTurnHint(`${msg} · [⚙ 환경설정]에서 퀴즈 탭 이름을 확인해 주세요.`,true);
    else if(msg.includes("관리자 인증"))setTurnHint("관리자 로그인이 풀렸습니다. [나가기] 후 다시 들어와 주세요.",true);
    else if(isTransient(msg))setTurnHint("서버가 밀려서 새 판을 못 만들었습니다. 몇 초 뒤 다시 눌러 주세요.",true);
    else setTurnHint(`새 게임 실패 — ${msg} · [🩺 시스템 점검]을 눌러 주세요.`,true);
    toast(`새 게임 실패: ${msg}`);forcePoll(false)
  }finally{button.disabled=false;turn.disabled=false}
}
// 다음 반이 들어오기 전에 쓰는 버튼. 학생 명단까지 통째로 비우고 새 판을 깐다.
async function kickStudent(id){
  const p=APP.state?.players?.[id];if(!p)return;
  if(!confirm(`${p.name} 학생을 내보낼까요?\n\n한 사람이 두 번 들어왔을 때 정리하는 기능입니다.\n내보낸 학생은 이름을 다시 입력하면 들어올 수 있습니다.`))return;
  try{await callWithRetry("adminKick",{token:APP.token,playerId:id});toast(`${p.name} 학생을 내보냈습니다.`);APP.rev=-1;forcePoll(false)}
  catch(error){toast(`내보내기 실패: ${error.message}`)}
}
async function resetAll(){
  const n=Object.keys(APP.state?.players||{}).length;
  if(!confirm(`전체 초기화합니다.\n\n· 학생 ${n}명이 모두 나가고 입장 화면으로 돌아갑니다\n· 점수와 점령한 칸이 사라지고 새 판이 깔립니다\n\n다음 반 수업을 시작할 때 쓰는 버튼입니다.\n계속할까요?`))return;
  const button=$("reset-all-button"),turn=$("turn-button");
  button.disabled=true;turn.dataset.busy="1";setTurnHint("초기화 중… (몇 초 걸립니다)");
  try{
    const r=await callWithRetry("adminNewGame",{token:APP.token,clearPlayers:true});
    APP.rev=-1;delete turn.dataset.busy;setTurnHint("초기화했습니다. 학생들이 입장하면 [▶ 시작]을 눌러 주세요.");
    $("admin-warning").classList.add("hidden");
    toast(`초기화 완료 · 학생 ${r.playerCount}명 · 새 판 ${r.cellCount}칸`);forcePoll(false)
  }catch(error){
    delete turn.dataset.busy;setTurnHint(`초기화 실패 — ${error.message} · [🩺 시스템 점검]을 눌러 주세요.`,true);
    toast(`초기화 실패: ${error.message}`);forcePoll(false)
  }finally{button.disabled=false;turn.disabled=false}
}
async function endGame(){if(!confirm("게임을 종료하고 승패를 확정합니다.\n학생 명단은 그대로 남고, [🆕 새 게임 만들기]를 누르면 바로 다음 판을 할 수 있습니다. 종료할까요?"))return;const button=$("end-game-button");button.disabled=true;try{const r=await callWithRetry("adminEndGame",{token:APP.token});toast(`게임 종료: ${r.winner} · 학생 ${r.players ?? 0}명은 그대로 대기합니다.`);APP.rev=-1;forcePoll(false)}catch(error){toast(`게임 종료 실패: ${error.message}`);forcePoll(false)}finally{button.disabled=false;$("turn-button").disabled=false}}
async function openSettings(){try{const r=await call("adminGetConfig",{token:APP.token}),c=r.config;APP.quizCount=c.quizCount||0;$("cfg-ss").value=c.ssId;$("cfg-sheet").value=c.quizSheet;$("cfg-time").value=c.turnSeconds;$("cfg-rows").value=c.rows;$("cfg-cols").value=c.cols;$("cfg-round").value=c.roundLimit;$("cfg-t").value=c.cnt.T;$("cfg-s").value=c.cnt.S;$("cfg-a").value=c.cnt.A;$("cfg-pw").value="";updateSizeHint();$("settings-modal").classList.remove("hidden")}catch(error){toast(error.message)}}
function updateSizeHint(){const r=Number($("cfg-rows").value)||0,c=Number($("cfg-cols").value)||0,n=APP.quizCount;$("size-hint").textContent=`총 ${r*c}칸 · 문항 ${n}개${n?` · 문제당 최대 ${Math.ceil(r*c/n)}회`:""} · 좌표 A1 ~ ${c?colLabel(c-1):"?"}${r}`}
async function saveSettings(){const config={ssId:$("cfg-ss").value,quizSheet:$("cfg-sheet").value,turnSeconds:Number($("cfg-time").value),rows:Number($("cfg-rows").value),cols:Number($("cfg-cols").value),roundLimit:Number($("cfg-round").value),cnt:{T:Number($("cfg-t").value),S:Number($("cfg-s").value),A:Number($("cfg-a").value)},adminPw:$("cfg-pw").value};try{const r=await call("adminSaveConfig",{token:APP.token,config});APP.quizCount=r.quizCount;closeModal("settings-modal");toast(r.message)}catch(error){toast(error.message)}}
async function openPeek(cell){try{APP.peek=await call("adminPeekCell",{token:APP.token,cell});$("peek-confirm-title").textContent=`${APP.peek.cellLabel} 칸의 문제를 볼까요?`;$("peek-warning").textContent=APP.peek.tried===0?"아직 아무도 도전하지 않은 문제입니다. 화면의 모두에게 공개됩니다.":"화면의 모두에게 문제가 공개됩니다.";$("peek-warning").className=`warning ${APP.peek.tried===0?"hot":""}`;if(APP.peek.ended)showPeek();else $("peek-confirm").classList.remove("hidden")}catch(error){toast(error.message)}}
function showPeek(){closeModal("peek-confirm");const p=APP.peek,q=p.quiz;$("peek-title").textContent=`${p.cellLabel} · ${{N:"일반",Q:"일반",T:"보물",S:"폭풍",A:"공격"}[p.type]}`;$("peek-question").textContent=q.q;$("peek-options").innerHTML=q.options.map((x,i)=>`<div class="option" data-peek="${i}"><b>${i+1}</b>${escapeHtml(x)}</div>`).join("");$("peek-answer-button").classList.remove("hidden");$("peek-modal").classList.remove("hidden")}
// ── 시스템 점검 ──────────────────────────────────────────────────────────────
// 수업 중에 "왜 안 되는지"를 교사가 혼자 확인하고 혼자 고칠 수 있어야 한다.
const DIAG_ICON={ok:"✅",warn:"⚠️",error:"⛔"};
async function runDiagnose(){$("diag-modal").classList.remove("hidden");const summary=$("diag-summary"),list=$("diag-list");summary.textContent="점검 중…";summary.className="warning";list.innerHTML="";try{const r=await call("adminDiagnose",{token:APP.token,appVersion:APP_VERSION});summary.textContent=r.summary;summary.className=`warning ${r.errorCount?"hot":""}`;list.innerHTML=r.checks.map(c=>`<div class="diag ${c.level}"><b>${DIAG_ICON[c.level]||""} ${escapeHtml(c.name)}</b><span>${escapeHtml(c.detail)}</span>${c.fix?`<button class="button muted" data-fix="${escapeHtml(c.fix)}">${escapeHtml(c.fixLabel||"고치기")}</button>`:""}</div>`).join("")}catch(error){summary.textContent=`점검을 하지 못했습니다: ${error.message}`;summary.className="warning hot";list.innerHTML=`<div class="diag error"><b>⛔ 서버 응답 없음</b><span>화면은 살아 있는데 서버가 답하지 않습니다. 잠시 뒤 [다시 점검]을 눌러 보고, 계속 같으면 Apps Script 배포 상태를 확인해 주세요.</span></div>`}}
async function runRepair(what,button){if(button)button.disabled=true;try{const r=await call("adminRepair",{token:APP.token,what});toast(r.message);APP.rev=-1;forcePoll(false);await runDiagnose()}catch(error){toast(`고치지 못했습니다: ${error.message}`);if(button)button.disabled=false}}
function revealPeek(){const el=document.querySelector(`[data-peek="${APP.peek.quiz.ansIdx}"]`);if(el){el.style.borderColor="#2fbf71";el.style.background="#e7f7ed"}$("peek-answer-button").classList.add("hidden")}

document.addEventListener("click",event=>{const login=event.target.closest("[data-login]");if(login)return openLogin(login.dataset.login);const close=event.target.closest("[data-close]");if(close)return closeModal(close.dataset.close);if(event.target.closest("[data-leave]"))return leaveApp();const cell=event.target.closest("[data-cell]");if(cell){const n=Number(cell.dataset.cell);return APP.role==="admin"?void openPeek(n):selectCell(n)}const choice=event.target.closest("[data-choice]");if(choice)return void submitChoice(Number(choice.dataset.choice));const fix=event.target.closest("[data-fix]");if(fix)return void runRepair(fix.dataset.fix,fix);const kick=event.target.closest("[data-kick]");if(kick)return void kickStudent(kick.dataset.kick)});
$("login-form").addEventListener("submit",event=>{event.preventDefault();const value=$("login-input").value.trim();closeModal("login-modal");if(APP.loginRole==="student")void loginStudent(value);else void loginAdmin(value)});
$("quiz-cancel").addEventListener("click",()=>void cancelQuiz());$("turn-button").addEventListener("click",()=>void nextTurn());$("new-game-button").addEventListener("click",()=>void newGame());$("end-game-button").addEventListener("click",()=>void endGame());$("reset-all-button").addEventListener("click",()=>void resetAll());$("diagnose-button").addEventListener("click",()=>void runDiagnose());$("diag-again").addEventListener("click",()=>void runDiagnose());$("settings-open").addEventListener("click",()=>void openSettings());$("settings-form").addEventListener("submit",event=>{event.preventDefault();void saveSettings()});["cfg-rows","cfg-cols"].forEach(id=>$(id).addEventListener("input",updateSizeHint));$("peek-show").addEventListener("click",showPeek);$("peek-answer-button").addEventListener("click",revealPeek);document.addEventListener("visibilitychange",()=>{if(!document.hidden&&APP.role)forcePoll(APP.role==="student")});setInterval(updateTimers,250);
