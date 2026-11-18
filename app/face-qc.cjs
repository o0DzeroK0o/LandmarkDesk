'use strict';
const groups=require('./face50.json');

function validate(points,width,height){
  if(!Array.isArray(points)||points.length!==50)throw Error('Face cần đủ 50 điểm.');
  const sorted=[...points].sort((a,b)=>a.id-b.id);
  sorted.forEach((p,i)=>{
    if(p.id!==i||!['Visible','Occluded','Outside'].includes(p.state))throw Error('Sai ID hoặc trạng thái điểm '+i+'.');
    if(p.state==='Outside'){
      if(p.x!==null||p.y!==null)throw Error('Outside cần bỏ trống tọa độ.');
    }else if(![p.x,p.y].every(Number.isFinite)||p.x<0||p.x>=width||p.y<0||p.y>=height)throw Error('Kiểm tra tọa độ điểm '+i+'.');
  });
  return sorted;
}
const cross=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
function contains(poly,p){
  let inside=false;
  for(let i=0,j=poly.length-1;i<poly.length;j=i++){
    const a=poly[j],b=poly[i];
    if(Math.abs(cross(a,b,p))<0.001 && (p.x-a.x)*(p.x-b.x)<=0 && (p.y-a.y)*(p.y-b.y)<=0)return true;
    if((a.y>p.y)!==(b.y>p.y) && p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)inside=!inside;
  }
  return inside;
}
function ringIssue(ring,name){
  if(ring.some(p=>p.state==='Outside'))return null;
  const next=i=>ring[(i+1)%ring.length];
  let area=0;
  const crossings=[];
  ring.forEach((a,i)=>{
    const b=next(i);area+=a.x*b.y-a.y*b.x;
    for(let j=i+1;j<ring.length;j++){
      const c=ring[j],d=next(j);
      if(cross(a,b,c)*cross(a,b,d)<0 && cross(c,d,a)*cross(c,d,b)<0)
        crossings.push(a.id+'–'+b.id+' × '+c.id+'–'+d.id);
    }
  });
  if(crossings.length)return name+' có cạnh giao nhau ('+crossings.join(', ')+').';
  if(area<-.001)return name+' cần đi theo chiều kim đồng hồ từ điểm '+ring[0].id+' qua '+ring[1].id+'.';
  return null;
}
const closed=groups.filter(g=>g.closed);
function topology(points){
  const issues=closed.map(g=>ringIssue(points.slice(g.first,g.first+g.count),g.name)).filter(Boolean);
  const outer=points.slice(30,42),inner=points.slice(42);
  if(outer.every(p=>p.state!=='Outside')){
    const outside=inner.filter(p=>p.state!=='Outside'&&!contains(outer,p));
    if(outside.length)issues.push('Điểm '+outside.map(p=>p.id).join(', ')+' của moitrong nằm ngoài moingoai (30–41).');
  }
  return issues;
}
function nearestEdge(ring,p){
  let best=null,distance=Infinity;
  ring.forEach((a,i)=>{
    const b=ring[(i+1)%ring.length],dx=b.x-a.x,dy=b.y-a.y;
    const t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy||1)));
    const x=a.x+t*dx,y=a.y+t*dy,dist=Math.hypot(p.x-x,p.y-y);
    if(dist<distance){best={...p,x,y};distance=dist;}
  });
  return distance<=2?best:null;
}
// Only suggest coordinate edits. Keep point IDs, visibility and unrelated contours.
function suggest(points,predicted,old){
  const result=[...points];
  const sources=[predicted,old].map(list=>new Map(list.map(p=>[p.id,p])));
  for(const g of closed){
    const ring=result.slice(g.first,g.first+g.count);
    if(!ringIssue(ring,g.name))continue;
    for(const source of sources){
      if(!ring.every(p=>source.get(p.id)?.state===p.state))continue;
      const replacement=ring.map(p=>({...p,x:source.get(p.id).x,y:source.get(p.id).y}));
      if(ringIssue(replacement,g.name))continue;
      result.splice(g.first,g.count,...replacement);
      break;
    }
  }
  const outer=result.slice(30,42);
  if(outer.every(p=>p.state!=='Outside')){
    for(const p of result.slice(42)){
      if(p.state==='Outside'||contains(outer,p))continue;
      const nearest=nearestEdge(outer,p);
      if(!nearest)return null;
      result[p.id]=nearest;
    }
  }
  if(topology(result).length)return null;
  const edits=result.filter((p,i)=>p.x!==points[i].x||p.y!==points[i].y);
  return edits.length?edits:null;
}
module.exports={validate,topology,suggest};
