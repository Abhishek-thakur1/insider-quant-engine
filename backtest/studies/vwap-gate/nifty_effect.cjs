// backtest/studies/vwap-gate/nifty_effect.cjs — the pre-open effect on the 26 Oct Nifty reference (EFFECT.md).
//   node backtest/studies/vwap-gate/nifty_effect.cjs docs/proposals/vwap-session-gate/nifty_bars5_2026-10-26.jsonl
const fs=require('fs');const L=fs.readFileSync(process.argv[2],'utf8').trim().split('\n').map(JSON.parse);
const ist=t=>new Date(t+19800000).toISOString().slice(11,16);
const b=L.filter(x=>new Date(x.t+19800000).toISOString().startsWith('2026-10-26')).sort((a,c)=>a.t-c.t);
const tp=x=>(x.h+x.l+x.c)/3;
const K=388-375; // pre-open candles: 388 engine minutes, 375 in 09:15-15:30 (engine stopped 15:30:00)
// p from the 09:47:01 reading VWAP 22466 (rounded): 30 session minutes in bars 09:15-09:40 + 1 minute of the 09:45 bar
const PVs47=b.slice(0,6).reduce((s,x)=>s+5*tp(x),0)+tp(b[6]); const n47=31;
for (const r of [22465.5,22466,22466.5]) console.log('p from 09:47 reading',r,':',(((K+n47)*r-PVs47)/K).toFixed(1));
const p=((K+n47)*22466-PVs47)/K;
// cross-check with end of day: 8774003.85 over 388; session = 74 bars x5 + last 5 min unknown (use 15:20 bar close)
const PVday=b.reduce((s,x)=>s+5*tp(x),0)+5*b.at(-1).c;
console.log('p from end-of-day residual', ((8774003.85-PVday)/K).toFixed(1), ' first bar open', b[0].o);
// effect series
let pv=0,n=0; const rows=[];
for (const x of b){pv+=5*tp(x);n+=5;const sess=pv/n, eng=(pv+K*p)/(n+K);rows.push([ist(x.t+300000),sess,eng,eng-sess,(eng-sess)/sess*1e4])}
for (const r of rows.filter((_,i)=>[0,1,2,3,5,7,11,17,23,35,47,59,73].includes(i))) console.log(`${r[0]} session ${r[1].toFixed(1)} engine ${r[2].toFixed(1)} diff ${r[3].toFixed(1)} pts ${r[4].toFixed(1)} bps`);
