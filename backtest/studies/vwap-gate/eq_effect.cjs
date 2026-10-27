// backtest/studies/vwap-gate/eq_effect.cjs — the pre-open auction effect on equity VWAP, from the backtest cache (EFFECT.md).
//   node backtest/studies/vwap-gate/eq_effect.cjs backtest/data/cache
// Equity: how much does the pre-open auction print move the live VWAP vs a 09:15-only VWAP?
// Auction volume UPPER BOUND = daily volume - sum of 1-min volumes (also contains the closing session); auction price = daily open.
const fs=require('fs'),path=require('path');const dir=process.argv[2];
const day=t=>new Date(t+19800000).toISOString().slice(0,10), mins=t=>{const d=new Date(t+19800000);return d.getUTCHours()*60+d.getUTCMinutes()};
const CK=[[9*60+20,'09:20'],[9*60+30,'09:30'],[9*60+50,'09:50'],[10*60+30,'10:30'],[12*60,'12:00'],[14*60,'14:00']];
const res=Object.fromEntries(CK.map(c=>[c[1],[]])); const share=[];
for (const f of fs.readdirSync(path.join(dir,'res-1'))){ if(f.includes('NIFTY'))continue;
 const D=JSON.parse(fs.readFileSync(path.join(dir,'res-D',f))).bars, M=JSON.parse(fs.readFileSync(path.join(dir,'res-1',f))).bars;
 const days=[...new Set(M.map(b=>day(b.t)))].slice(-20);
 for(const d of days){ const db=D.find(b=>day(b.t)===d); if(!db)continue; const bars=M.filter(b=>day(b.t)===d);
  const sum=bars.reduce((s,b)=>s+b.v,0); const va=Math.max(0,db.v-sum); share.push(va/db.v);
  let pv=0,v=0,i=0;
  for(const [m,lab] of CK){ while(i<bars.length&&mins(bars[i].t)<m){const b=bars[i];pv+=(b.h+b.l+b.c)/3*b.v;v+=b.v;i++}
   if(v===0)continue; const s=pv/v, w=(pv+va*db.o)/(v+va); res[lab].push(Math.abs(w-s)/s*1e4);}
 }}
const q=(a,p)=>{const s=[...a].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.floor(p*s.length))]};
console.log('symbol-days',share.length,'auction+close share of daily volume (upper bound): median',(q(share,.5)*100).toFixed(2)+'%','p90',(q(share,.9)*100).toFixed(2)+'%');
for(const [,lab] of CK){const a=res[lab];console.log(lab,'|VWAP shift| bps: median',q(a,.5).toFixed(2),'p90',q(a,.9).toFixed(2),'p99',q(a,.99).toFixed(2),'max',Math.max(...a).toFixed(1),'n',a.length)}
