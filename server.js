"use strict";
const express=require("express"),http=require("http"),crypto=require("crypto");
const {Server}=require("socket.io");
const app=express(),server=http.createServer(app),io=new Server(server,{pingTimeout:20000,pingInterval:10000});
const PORT=process.env.PORT||3000,ADMIN_PASSWORD="8959";
const SEAT_COUNT=10,BUY_IN=300000,WIN_TARGET=5000000,ELIMINATION=5000,BET_MS=12000;
const SUITS=["♠","♥","♦","♣"],RANKS=["A","2","3","4","5","6","7","8","9","10","J","Q","K"],MULTIS=[2,3,5,8];
const seededRoad=()=>Array.from({length:20},(_,i)=>{const dValue=crypto.randomInt(1,14),tValue=crypto.randomInt(1,14),dSuit=SUITS[crypto.randomInt(0,4)],tSuit=SUITS[crypto.randomInt(0,4)],result=dValue>tValue?"dragon":dValue<tValue?"tiger":dSuit===tSuit?"suited":"tie";return{round:i+1,result,lightning:crypto.randomInt(0,5)===0}});
const freshState=()=>({phase:"waiting",round:20,playedRounds:0,deadline:null,lightning:null,cards:null,result:null,message:"이전 20게임 그림장 준비 완료 · 방장 시작 대기",winner:null,winLogs:[],roundWinners:[],road:seededRoad(),seats:Array(SEAT_COUNT).fill(null),started:false});
let state=freshState(),timer=null;const clients=new Map();
app.use(express.static("public",{setHeaders:res=>res.setHeader("Cache-Control","no-store, no-cache, must-revalidate")}));app.get("/health",(_,res)=>res.json({ok:true,players:state.seats.filter(Boolean).length,phase:state.phase}));
const clean=v=>String(v||"").replace(/[<>]/g,"").trim().slice(0,14),emptyBet=()=>({dragon:0,tie:0,suited:0,tiger:0});
const publicPlayer=p=>p&&({id:p.id,nickname:p.nickname,balance:p.balance,connected:p.connected,ready:p.ready,eliminated:p.eliminated,bet:p.bet,lastPay:p.lastPay||0});
const snapshot=()=>({...state,seats:state.seats.map(publicPlayer),serverNow:Date.now()}),emit=()=>io.emit("state",snapshot());
const draw=()=>{const value=crypto.randomInt(1,14);return{value,rank:RANKS[value-1],suit:SUITS[crypto.randomInt(0,4)]}};
const player=socket=>{const id=clients.get(socket.id);return state.seats.find(p=>p?.id===id)};
const clearBet=(p,refund=true)=>{if(refund){const stake=Object.values(p.bet).reduce((a,b)=>a+b,0);p.balance+=Math.floor(stake*1.2)}p.bet=emptyBet();p.ready=false};
function chooseWinner(){const alive=state.seats.filter(p=>p&&!p.eliminated&&p.balance>=ELIMINATION),targets=alive.filter(p=>p.balance>=WIN_TARGET).sort((a,b)=>b.balance-a.balance);return targets[0]||(state.started&&state.playedRounds>0&&alive.length===1?alive[0]:null)}
function finishTournament(p){clearTimeout(timer);state.winner={id:p.id,nickname:p.nickname,balance:p.balance,reason:p.balance>=WIN_TARGET?"5,000,000원 이상 최고 보유금 달성":"최후의 1인"};state.phase="finished";state.deadline=null;state.message=`🏆 ${p.nickname} 우승 · ${p.balance.toLocaleString()}원`;emit()}
function settle(d,t,l){
 const result=d.value>t.value?"dragon":d.value<t.value?"tiger":d.suit===t.suit?"suited":"tie",logs=[];
 for(const [seatIndex,p] of state.seats.entries())if(p){
  const b={...p.bet};let pay=0,area="",detail="";const dragonHit=d.suit===l.suit,tigerHit=t.suit===l.suit;
  if(result==="dragon"&&b.dragon){const m=dragonHit?l.multi:1;pay=b.dragon*(1+m);area="용";detail=dragonHit?`용 라이트닝 ${m}배 적중`:"용 1:1 적중"}
  if(result==="tiger"&&b.tiger){const m=tigerHit?l.multi:1;pay=b.tiger*(1+m);area="호";detail=tigerHit?`호 라이트닝 ${m}배 적중`:"호 1:1 적중"}
  if(result==="tie"||result==="suited"){
   const refund=Math.floor((b.dragon+b.tiger)/2);pay+=refund;
   if(b.tie){const hits=[d,t].filter(c=>c.suit===l.suit).length,m=hits?l.multi:1;pay+=b.tie*6.5*m;area="일반 무";detail=m>1?`일반 무 6.5배 × 라이트닝 ${m}배`:"일반 무 6.5배 적중"}
   if(result==="suited"&&b.suited){const m=d.suit===l.suit?l.multi:1;pay+=b.suited*20*m;area=area?area+" + 적절한 무":"적절한 무";detail+=(detail?" · ":"")+(m>1?`적절한 무 20배 × 라이트닝 ${m}배`:"적절한 무 20배 적중")}
   if(!area&&refund){area="용·호 타이 반환";detail="본 베팅 50% 반환"}
  }
  p.lastPay=Math.floor(pay);p.balance+=p.lastPay;p.bet=emptyBet();p.ready=false;p.eliminated=p.balance<ELIMINATION;
  if(pay>0)logs.push({round:state.round,seat:seatIndex+1,nickname:p.nickname,area,stake:Object.values(b).reduce((a,v)=>a+v,0),payout:p.lastPay,detail});
 }
 logs.sort((a,b)=>b.payout-a.payout||a.seat-b.seat);state.roundWinners=logs;state.result=result;state.road.push({round:state.round,result,lightning:result==="dragon"?d.suit===l.suit:result==="tiger"?t.suit===l.suit:d.suit===l.suit||t.suit===l.suit});state.road=state.road.slice(-120);state.winLogs=[...logs,...state.winLogs].slice(0,12);state.phase="result";state.message=result==="dragon"?"용 승리":result==="tiger"?"호 승리":result==="tie"?"일반 무":"적절한 무";emit();
 const winner=chooseWinner();if(winner)return setTimeout(()=>finishTournament(winner),1000);
 timer=setTimeout(()=>{state.cards=null;state.lightning=null;state.result=null;emit();if(state.started)beginBetting()},3500);
}
function beginBetting(){if(!state.started||state.winner)return;const winner=chooseWinner();if(winner)return finishTournament(winner);clearTimeout(timer);state.phase="betting";state.round++;state.playedRounds++;state.lightning=null;state.cards=null;state.result=null;state.deadline=Date.now()+BET_MS;state.message=`${state.round}라운드 · 베팅 시간 12초`;for(const p of state.seats.filter(Boolean)){p.ready=false;p.lastPay=0}emit();timer=setTimeout(closeBetting,BET_MS)}
function closeBetting(){if(state.phase!=="betting")return;state.phase="lightning";state.deadline=null;state.lightning={suit:SUITS[crypto.randomInt(0,4)],multi:MULTIS[crypto.randomInt(0,MULTIS.length)]};state.message=`라이트닝 ${state.lightning.suit} ${state.lightning.multi}X`;emit();timer=setTimeout(()=>{const d=draw();state.cards={dragon:d,tiger:null};state.phase="dealing";state.message="용 카드 공개";emit();timer=setTimeout(()=>{const t=draw();state.cards.tiger=t;state.message="호 카드 공개";emit();timer=setTimeout(()=>settle(d,t,state.lightning),1050)},900)},4400)}
io.on("connection",socket=>{
 socket.emit("state",snapshot());
 socket.on("join",({nickname,token},done=()=>{})=>{nickname=clean(nickname);if(!nickname)return done({ok:false,error:"닉네임을 입력하세요"});let p=state.seats.find(x=>x&&x.token===token)||state.seats.find(x=>x&&x.nickname===nickname&&!x.connected);if(p){p.connected=true;p.socketId=socket.id;clients.set(socket.id,p.id);emit();return done({ok:true,token:p.token,id:p.id,seat:state.seats.findIndex(x=>x?.id===p.id),reconnected:true})}if(state.started)return done({ok:false,error:"게임 시작 후에는 중간 참가할 수 없습니다"});if(state.seats.filter(Boolean).length>=SEAT_COUNT)return done({ok:false,error:"10개 좌석이 모두 찼습니다"});if(state.seats.some(x=>x?.nickname===nickname))return done({ok:false,error:"이미 사용 중인 닉네임입니다"});p={id:crypto.randomUUID(),token:crypto.randomUUID(),nickname,balance:BUY_IN,connected:true,ready:false,eliminated:false,bet:emptyBet(),lastPay:0,socketId:socket.id};clients.set(socket.id,p.id);socket.data.pending=p;done({ok:true,token:p.token,id:p.id});emit()});
 socket.on("sit",(index,done=()=>{})=>{index=Number(index);const p=player(socket)||socket.data.pending;if(!p)return done({ok:false,error:"먼저 입장하세요"});if(state.started)return done({ok:false,error:"게임 시작 후에는 좌석을 변경할 수 없습니다"});if(!Number.isInteger(index)||index<0||index>=SEAT_COUNT||state.seats[index])return done({ok:false,error:"사용할 수 없는 좌석입니다"});const old=state.seats.findIndex(x=>x?.id===p.id);if(old>=0)state.seats[old]=null;state.seats[index]=p;socket.data.pending=null;emit();done({ok:true})});
 socket.on("bet",({key,amount},done=()=>{})=>{const p=player(socket);amount=Number(amount);if(!p||state.phase!=="betting"||p.ready||p.eliminated)return done({ok:false,error:"현재 베팅할 수 없습니다"});if(!["dragon","tie","suited","tiger"].includes(key)||![5000,10000,30000,50000,100000].includes(amount))return done({ok:false,error:"잘못된 베팅입니다"});if((key==="dragon"&&p.bet.tiger)||(key==="tiger"&&p.bet.dragon))return done({ok:false,error:"용·호 양방 베팅은 불가능합니다"});const cost=Math.floor(amount*1.2);if(p.balance<cost)return done({ok:false,error:"보유금이 부족합니다"});p.balance-=cost;p.bet[key]+=amount;emit();done({ok:true})});
 socket.on("undo",(_,done=()=>{})=>{const p=player(socket);if(!p||state.phase!=="betting"||p.ready)return done({ok:false,error:"취소할 수 없습니다"});clearBet(p,true);emit();done({ok:true})});
 socket.on("ready",(_,done=()=>{})=>{const p=player(socket);if(!p||state.phase!=="betting")return done({ok:false,error:"현재 확정할 수 없습니다"});p.ready=true;emit();done({ok:true})});
 socket.on("adminLogin",(pw,done=()=>{})=>{if(String(pw)!==ADMIN_PASSWORD)return done({ok:false,error:"비밀번호가 다릅니다"});socket.data.admin=true;done({ok:true})});
 socket.on("adminStart",()=>{if(!socket.data.admin||state.started||!state.seats.some(Boolean))return;state.started=true;beginBetting()});
 socket.on("kick",(index,done=()=>{})=>{if(!socket.data.admin)return done({ok:false,error:"관리자 권한이 필요합니다"});index=Number(index);const p=state.seats[index];if(!p)return done({ok:false,error:"빈 좌석입니다"});state.seats[index]=null;for(const [sid,id] of clients)if(id===p.id){io.to(sid).emit("kicked");clients.delete(sid)}emit();const winner=chooseWinner();if(winner)finishTournament(winner);done({ok:true})});
 socket.on("adminReset",()=>{if(!socket.data.admin)return;clearTimeout(timer);state=freshState();clients.clear();io.emit("roomReset");emit()});
 socket.on("disconnect",()=>{const p=player(socket);if(p){p.connected=false;p.socketId=null;emit()}clients.delete(socket.id)});
});
server.listen(PORT,()=>console.log(`Lightning Dragon Tiger listening on ${PORT}`));
