const assert=require('node:assert/strict');
const C=require('./core.js');
const s=C.seed();
s.settings.workShifts=[{day:0,start:'05:00',end:'07:00',confirmed:false},{day:1,start:'05:00',end:'17:30',confirmed:false},{day:2,start:'05:00',end:'16:30',confirmed:false}]; // Erfundenes, isoliertes Testszenario

assert.equal(s.projects.length,10);
assert.equal(s.courses.length,4);
assert.equal(s.settings.sleepHours,8);
assert.equal(s.applications.length,0);
const p=C.buildWeekPlan(s,'2026-11-10');
assert.equal(p.weekStart,'2026-11-09');
assert.equal(p.days.length,7);
assert.equal(p.days[0].blocks.some(b=>b.name.startsWith('Travail') && b.start===300 && b.end===420),true);
assert.equal(p.days[1].blocks.some(b=>b.name.startsWith('Travail') && b.start===300 && b.end===1050),true);
assert.equal(p.days[2].blocks.some(b=>b.name.startsWith('Travail') && b.start===300 && b.end===990),true);
assert.equal(p.days[0].blocks.some(b=>b.name.includes('Salle')),true);
assert.equal(p.days[3].blocks.some(b=>b.name.includes('Salle')),true);
assert.equal(p.days[5].blocks.some(b=>b.name.includes('Salle')),true);
for(const day of p.days){for(let i=1;i<day.blocks.length;i++){assert(day.blocks[i].start>=day.blocks[i-1].end,`Overlap ${day.name}: ${day.blocks[i-1].name} & ${day.blocks[i].name}`);}}
assert.equal(p.conflicts.length,0);
assert.equal(p.days[0].blocks.filter(b=>b.kind==='sleep').reduce((a,b)=>a+b.end-b.start,0),480);
assert.equal(p.days[1].blocks.filter(b=>b.kind==='sleep').reduce((a,b)=>a+b.end-b.start,0),480);
assert.equal(p.days[2].blocks.filter(b=>b.kind==='sleep').reduce((a,b)=>a+b.end-b.start,0),270); // 00-04:30; the next night starts at 00:00 Thursday
let withClass=C.structuredCopy(s);
withClass.settings.courseBlocks.push({title:'Cours surprise',day:3,start:'10:00',end:'14:00'});
const q=C.buildWeekPlan(withClass,'2026-11-10');
assert.equal(q.days[3].blocks.some(b=>b.name==='Cours surprise'),true);
assert(q.unscheduled.some(x=>x.title.includes('Salle')) || q.days[3].blocks.some(b=>b.name.includes('Salle')));
assert.equal(C.habitCount(s,'gym','2026-11-10'),0);
s.habitChecks['gym:2026-11-09']=true;
assert.equal(C.habitCount(s,'gym','2026-11-10'),1);
s.transactions.push({id:'t',date:'2026-11-10',type:'expense',amount:25,category:'projets'});
assert.equal(C.expensesInMonth(s,'2026-11'),25);
assert.equal(C.expensesByCategory(s,'2026-11').projets,25);
assert.doesNotThrow(()=>C.validateImported(C.structuredCopy(s)));
assert.throws(()=>C.validateImported({...s,version:2}),/version/i);
// --- Identifiants uniques par collection (import et chargement) : refus net, sans normalisation ni remplacement silencieux ---
{
  const extra={applications:{id:'a1',company:'Acme',role:'Dev',status:'brouillon',sentAt:'',followup:'',url:'',notes:''},transactions:{id:'t1',date:'2026-11-10',label:'Netflix',amount:10,type:'expense',category:'vie'},review:{id:'r1',date:'2026-11-09',wins:'',pressure:'',priorities:''}};
  for(const coll of ['projects','courses','tasks','applications','habits','transactions','ideas','goals','review']){
    const d=C.structuredCopy(C.seed());if(!d[coll].length)d[coll].push(C.structuredCopy(extra[coll]));
    assert.doesNotThrow(()=>C.validateImported(C.structuredCopy(d)),'sauvegarde valide acceptée : '+coll);
    const twin=C.structuredCopy(d[coll][0]);if('amount' in twin)twin.amount=20;if('title' in twin)twin.title+=' (bis)';if('name' in twin)twin.name+=' (bis)';
    d[coll].push(twin);
    const snapshot=JSON.stringify(d);
    assert.throws(()=>C.validateImported(d),/Identifiant en double/,'doublon refusé : '+coll);
    assert.equal(JSON.stringify(d),snapshot,'l’objet fourni n’est ni modifié ni dédoublonné : '+coll);
  }
  // cas du rapport d’audit : deux dépenses de même id, montants 10 et 20
  const dup=C.structuredCopy(C.seed());dup.transactions.push({id:'tx-1',date:'2026-11-10',label:'A',amount:10,type:'expense',category:'vie'},{id:'tx-1',date:'2026-11-11',label:'B',amount:20,type:'expense',category:'vie'});
  assert.throws(()=>C.validateImported(dup),/Identifiant en double dans transactions/);
  // le chargement du stockage reste fail-closed : mode récupération, texte brut conservé, rien de remplacé
  const store={getItem:()=>JSON.stringify(dup)};const loaded=C.loadStored(store,'k');
  assert.equal(loaded.locked,true);assert.equal(loaded.raw,JSON.stringify(dup));assert.match(loaded.reason,/Identifiant en double/);
  assert.equal(C.saveStored({getItem:()=>null,setItem(){throw Error('ne doit pas écrire');}},'k',dup).ok,false,'saveStored refuse d’écrire des doublons');
  // identifiants différents par la casse ou l’espace : ce sont des identifiants distincts (aucune normalisation)
  const ok=C.structuredCopy(C.seed());ok.transactions.push({id:'tx',date:'2026-11-10',label:'A',amount:1,type:'expense',category:'vie'},{id:'TX',date:'2026-11-10',label:'B',amount:2,type:'expense',category:'vie'},{id:'tx ',date:'2026-11-10',label:'C',amount:3,type:'expense',category:'vie'});
  assert.doesNotThrow(()=>C.validateImported(ok));
}
console.log('Core tests PASS — planner, shifts, habits, budget, import, identifiants uniques');
